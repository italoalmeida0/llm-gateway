/**
 * scripts/perf-sim.ts — day-by-day growth simulation with REAL measurements.
 *
 * Scenario v2 — the current architecture (router mode + upstream failover):
 *
 *   1. boots a real gateway + TWO fake upstreams (primary + fallback provider)
 *      on a fresh temp DATA_DIR
 *   2. provisions through the real API:
 *        - routing_mode = "router" with a model registry
 *        - 2 providers: primary (3 upstream keys) + fallback (2 upstream keys)
 *        - 3 public models, each with an A→B target chain (fallback target
 *          renames the model → exercises the router rewrite path)
 *        - 5 users + 5 gateway keys
 *   3. grows history checkpoint by checkpoint (usage events, audit rows, and
 *      registry churn: +2 models per simulated quarter)
 *   4. at every checkpoint measures, over real HTTP:
 *        - proxy latency (stream + non-stream, 5 keys × 3 models rotating)
 *        - direct-to-upstream baseline
 *        - every dashboard endpoint the SPA calls (user + admin + registry)
 *        - SPA delivery (static index)
 *      and at chosen checkpoints also runs the failover probes
 *      (skip-exhausted / active-failover / burst / provider-fallback).
 *   5. writes docs/performance/results/crescimento-v2-router.json + prints a table
 *
 * Run: bun run perf:sim            (goes up to PERF_MAX_DAYS, default 10 years)
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  GW, NUM_USERS, REQS_PER_USER_DAY, AUDIT_PER_USER_DAY,
  startStack, stopStack, provisionRouter, backfill, backfillRegistry,
  openRawDb, tableCounts,
  measureGet, measureProxy, measureDirect, endpointSet, runFailoverProbes,
  type Stack, type EndpointSample, type FailoverProbes,
} from "./perf-common";

const MAX_DAYS = Number(process.env.PERF_MAX_DAYS || 3650); // 10 years
const STOP_P95_MS = Number(process.env.PERF_STOP_P95 || 5000);
const PROBE_DAYS = (process.env.PERF_PROBE_DAYS ?? "365,3650")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);

/** day counts where a full measurement round happens */
function checkpoints(maxDays: number): number[] {
  const base = [0, 1, 7, 14, 30, 60, 90, 180, 270, 365, 545, 730, 1000, 1460, 1825, 2555, 3650];
  return base.filter((d) => d <= maxDays);
}

interface CheckpointResult {
  days: number;
  rows: Record<string, number>;
  dbSizeMB: number;
  endpoints: Record<string, { p50: number; p95: number; n: number; errors: number }>;
  proxy: {
    direct: { p50: number; p95: number; rps: number; errors: number };
    nonstream: { p50: number; p95: number; rps: number; errors: number };
    stream: { p50: number; p95: number; rps: number; errors: number };
    overheadP50: number;
    overheadP95: number;
  };
  failoverProbes?: FailoverProbes;
  coldSnapshot?: { coldMs: number; warmP50: number };
}

// simple linear regression y = a + b*x over checkpoints
function linreg(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = my - b * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i]! - (a + b * xs[i]!)) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { a, b, r2 };
}

function crossingDays(xs: number[], ys: number[], threshold: number): number | null {
  for (let i = 0; i < xs.length; i++) if (ys[i]! >= threshold) return xs[i]!;
  const { a, b } = linreg(xs, ys);
  if (b <= 0) return null;
  const d = (threshold - a) / b;
  return d > xs[xs.length - 1]! ? Math.round(d) : null;
}

// ===== main =====

const dataDir = mkdtempSync(path.join(tmpdir(), "gw-perf-sim-"));
console.log(`[sim] data dir: ${dataDir}`);
// open the raw writer BEFORE the stack boots: the file exists from the start
// (empty), the gateway's own boot runs the migrations on it.
const rawDb = openRawDb(dataDir);
const stack: Stack = await startStack(dataDir, { fallbackUpstream: true });

const results: CheckpointResult[] = [];

try {
  console.log(`[sim] provisioning router mode + failover topology via real API...`);
  const { adminToken, users, topo } = await provisionRouter(NUM_USERS);
  const adminId = (rawDb.query("SELECT id FROM users WHERE role='admin'").get() as any).id as string;

  let simDays = 0;
  let catalogCount = 3; // the provisioned public models
  const stop = checkpoints(MAX_DAYS);

  // discover the built SPA bundle URL so we can time a "frontend load"
  let bundlePath: string | null = null;
  try {
    const html = await (await fetch(`${GW}/`)).text();
    const m = html.match(/src="([^"]+\.js)"/);
    const raw = m?.[1] ?? null;
    bundlePath = raw ? (raw.startsWith("/") ? raw : `/${raw.replace(/^\.\//, "")}`) : null;
  } catch {}
  if (bundlePath) console.log(`[sim] SPA bundle: ${bundlePath}`);

  // warm up JIT/provider caches/circuit state so day-0 numbers aren't cold-start noise
  await measureProxy(users, 80, 8, false);
  await measureProxy(users, 20, 5, true);

  let aborted = false;
  for (const target of stop) {
    if (target > simDays) {
      backfill(rawDb, users, adminId, simDays, target - simDays);
      catalogCount += backfillRegistry(rawDb, topo.providerA, simDays, target - simDays, catalogCount);
      simDays = target;
    }

    const rows = tableCounts(rawDb);
    rawDb.exec("PRAGMA wal_checkpoint(PASSIVE)");

    console.log(
      `\n[sim] ===== day ${simDays} — rows: events=${rows.usage_events.toLocaleString("en-US")} ` +
        `daily=${rows.usage_daily} audit=${rows.audit_log.toLocaleString("en-US")} ` +
        `models=${rows.models} targets=${rows.model_targets} pkeys=${rows.provider_keys} =====`,
    );

    // --- proxy (real requests through the gateway, router mode) ---
    const direct = await measureDirect(60, 8);
    const nonstream = await measureProxy(users, 100, 8, false);
    const stream = await measureProxy(users, 30, 5, true);

    // --- failover probes at the chosen checkpoints ---
    let failoverProbes: FailoverProbes | undefined;
    if (PROBE_DAYS.includes(simDays)) {
      console.log(`  [probes] failover regimes...`);
      failoverProbes = await runFailoverProbes(users, adminToken, topo);
      console.log(
        `  [probes] skip-exhausted p50 ${failoverProbes.skipExhausted.p50.toFixed(1)}ms (dead-key hits: ${failoverProbes.skipExhausted.deadKeyHitsDuringMeasure}) | ` +
          `active failover ${failoverProbes.activeFailover.mean.toFixed(1)}ms avg | ` +
          `burst p95 ${failoverProbes.failoverBurst.p95.toFixed(1)}ms | ` +
          `provider-fallback p50 ${failoverProbes.providerFallback.p50.toFixed(1)}ms (${failoverProbes.providerFallback.fallbackUpstreamHits} hits on B)`,
      );
    }

    // --- dashboard endpoints ---
    const endpoints: Record<string, { p50: number; p95: number; n: number; errors: number }> = {};
    let slowest = 0;
    let slowestName = "";
    const set: EndpointSample[] = endpointSet(
      Math.min(Math.max(rows.usage_events - 100, 0), 10_000),
      Math.min(Math.max(rows.audit_log - 50, 0), 5_000),
      { router: true },
    );
    if (bundlePath) set.push({ name: "static.bundle", url: bundlePath, who: "anon" });
    for (const ep of set) {
      const token =
        ep.who === "admin" ? adminToken
        : ep.who === "user" ? users[0]!.accessToken
        : ep.who === "gw" ? users[0]!.gwKey
        : undefined;
      const s = await measureGet(ep.url, token);
      endpoints[ep.name] = { p50: s.p50, p95: s.p95, n: s.n, errors: s.errors };
      if (s.p95 > slowest) { slowest = s.p95; slowestName = ep.name; }
    }

    // --- cold router-snapshot rebuild (5s TTL expired) ---
    let coldSnapshot: { coldMs: number; warmP50: number } | undefined;
    if (target === stop[stop.length - 1]) {
      await Bun.sleep(5600); // SNAP_TTL_MS is 5s
      const t0 = performance.now();
      await measureProxy(users, 1, 1, false);
      coldSnapshot = { coldMs: performance.now() - t0, warmP50: nonstream.p50 };
      console.log(
        `  [snapshot] cold rebuild + first request: ${coldSnapshot.coldMs.toFixed(1)}ms vs warm p50 ${nonstream.p50.toFixed(1)}ms`,
      );
    }

    results.push({
      days: simDays,
      rows: {
        usage_events: rows.usage_events,
        usage_daily: rows.usage_daily,
        usage_model_daily: rows.usage_model_daily,
        usage_model_provider_daily: rows.usage_model_provider_daily,
        audit_log: rows.audit_log,
        sessions: rows.sessions,
        models: rows.models,
        model_targets: rows.model_targets,
        provider_keys: rows.provider_keys,
      },
      dbSizeMB: dbSizeMB(dataDir),
      endpoints,
      proxy: {
        direct: { p50: direct.p50, p95: direct.p95, rps: direct.rps, errors: direct.errors },
        nonstream: { p50: nonstream.p50, p95: nonstream.p95, rps: nonstream.rps, errors: nonstream.errors },
        stream: { p50: stream.p50, p95: stream.p95, rps: stream.rps, errors: stream.errors },
        overheadP50: nonstream.p50 - direct.p50,
        overheadP95: nonstream.p95 - direct.p95,
      },
      failoverProbes,
      coldSnapshot,
    });

    console.log(
      `  proxy p50 ${nonstream.p50.toFixed(1)}ms (overhead +${(nonstream.p50 - direct.p50).toFixed(2)}ms) | ` +
        `slowest endpoint: ${slowestName} p95 ${slowest.toFixed(0)}ms`,
    );

    if (slowest >= STOP_P95_MS) {
      console.log(`[sim] stop condition hit: ${slowestName} p95 ${slowest.toFixed(0)}ms >= ${STOP_P95_MS}ms`);
      aborted = true;
    }
    if (aborted) break;
  }

  // keep-data option for follow-up tuning runs (`perf-tuning measure <dir>`
  // re-boots the CURRENT code on the aged dataset — fresh planner stats)
  if (process.env.PERF_KEEP_DIR === "1") {
    writeFileSync(
      path.join(dataDir, "meta.json"),
      JSON.stringify(
        {
          router: true,
          adminToken,
          users: users.map((u) => ({ id: u.id, email: u.email, gwKey: u.gwKey, keyId: u.keyId })),
        },
        null,
        2,
      ),
    );
    console.log(`[sim] PERF_KEEP_DIR=1 — keeping ${dataDir}`);
  }
} finally {
  await stopStack(stack);
  rawDb.close(false);
}

// ===== analysis + report =====

function dbSizeMB(dir: string): number {
  try {
    const f = Bun.file(path.join(dir, "gateway.db"));
    return Math.round((f.size / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

const outDir = path.join(import.meta.dir, "..", "docs", "performance", "results");
mkdirSync(outDir, { recursive: true });
// keep the 5-user file name stable (docs reference it); larger runs get a
// suffixed file so both scenarios coexist
const outName = NUM_USERS === 5 ? "crescimento-v2-router.json" : `crescimento-v2-router-${NUM_USERS}users.json`;
const outFile = path.join(outDir, outName);
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), scenario: scenarioText(), results }, null, 2));

function scenarioText() {
  return {
    architecture: "router mode + model registry + multi-key failover (migrations 006–009)",
    routingMode: "router",
    users: NUM_USERS,
    reqsPerUserDay: REQS_PER_USER_DAY,
    tokensPerUserDay: { in: 1_000_000, cache: 4_000_000, out: 200_000 },
    auditRowsPerUserDay: AUDIT_PER_USER_DAY,
    models: ["claude-sonnet-4-5 (50%)", "gpt-5-mini (30%)", "gpt-4o (20%)"],
    topology: {
      providerPrimary: "3 upstream keys (failover chain)",
      providerFallback: "2 upstream keys",
      modelTargets: "A(same id) → B(fb-<id>) per public model",
      registryChurn: "+2 models per quarter",
    },
  };
}

console.log(`\n[sim] wrote ${outFile}`);

// table print: days × rows × key endpoints
const ALL_ENDPOINTS = Object.keys(results[results.length - 1]?.endpoints ?? {});
console.log("\n===== GROWTH TABLE (p95 ms) =====");
const cols = ["days", "events", "audit", "models", "dbMB", "proxyOv50", "proxyOv95", ...ALL_ENDPOINTS];
console.log(cols.map((c) => c.padStart(16)).join(""));
for (const r of results) {
  const cells = [
    String(r.days),
    String(r.rows.usage_events),
    String(r.rows.audit_log),
    String(r.rows.models),
    String(r.dbSizeMB),
    r.proxy.overheadP50.toFixed(2),
    r.proxy.overheadP95.toFixed(2),
    ...ALL_ENDPOINTS.map((e) => r.endpoints[e]!.p95.toFixed(1)),
  ];
  console.log(cells.map((c) => c.padStart(16)).join(""));
}

console.log("\n===== THRESHOLD CROSSINGS (p95) =====");
console.log(
  "endpoint".padEnd(22) +
  "slope ms/yr".padStart(12) +
  "R²".padStart(8) +
  ">300ms".padStart(12) +
  ">1000ms".padStart(12) +
  ">3000ms".padStart(12),
);
for (const ep of ["proxy.overhead", ...ALL_ENDPOINTS]) {
  const xs = results.map((r) => r.days);
  const ys = ep === "proxy.overhead"
    ? results.map((r) => r.proxy.overheadP95)
    : results.map((r) => r.endpoints[ep]!.p95);
  const { b, r2 } = linreg(xs, ys);
  const fmt = (d: number | null) => (d === null ? "never" : d >= 365 ? `${(d / 365).toFixed(1)}y` : `${d}d`);
  console.log(
    ep.padEnd(22) +
      (b * 365).toFixed(2).padStart(12) +
      r2.toFixed(3).padStart(8) +
      fmt(crossingDays(xs, ys, 300)).padStart(12) +
      fmt(crossingDays(xs, ys, 1000)).padStart(12) +
      fmt(crossingDays(xs, ys, 3000)).padStart(12),
  );
}

if (process.env.PERF_KEEP_DIR !== "1") {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
} else {
  console.log(`[sim] kept data dir: ${dataDir}`);
}
