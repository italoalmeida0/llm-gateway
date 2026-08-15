/**
 * scripts/perf-common.ts — shared machinery for the performance suite
 * (perf-sim.ts and perf-tuning.ts).
 *
 * The scenario being simulated, per user per day (5 users, 1 provider):
 *   - 200 proxied LLM requests
 *   - 1_000_000 uncached input tokens  (avg 5_000/req)
 *   - 4_000_000 cached input tokens    (avg 20_000/req)
 *   -   200_000 output tokens          (avg 1_000/req)
 *   - spread across 3 models (claude-sonnet 50% / gpt-5-mini 30% / gpt-4o 20%)
 *   - ~50 audit_log rows (logins, refreshes, key reveals, edits, provider tests)
 *
 * History is backfilled straight into SQLite (same INSERT/UPSERT statements the
 * gateway itself runs — WAL mode, same pattern as scripts/seed-usage.ts), while
 * "today" traffic and every latency measurement go through the REAL HTTP
 * surface of a live gateway + fake upstream child process.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";

export const ROOT = path.join(import.meta.dir, "..");

// ports are isolated per tool so both can even run back to back
export const GW_PORT = Number(process.env.PERF_GW_PORT || 5460);
export const UP_PORT = Number(process.env.PERF_UP_PORT || 5461);
export const GW = `http://127.0.0.1:${GW_PORT}`;
export const UP = `http://127.0.0.1:${UP_PORT}`;
export const UPSTREAM_KEY = "sk-fake-secret";
export const ADMIN_PW = "perf-admin-password-1";
export const USER_PW = "perf-user-password-1";

export const NUM_USERS = 5;
export const REQS_PER_USER_DAY = 200;
export const AUDIT_PER_USER_DAY = 50;
/** daily per-user token totals (averaged per request in genDayEvents) */
export const DAY_IN = 1_000_000;
export const DAY_CACHE = 4_000_000;
export const DAY_OUT = 200_000;

export const MODELS = [
  { proto: "anthropic", model: "claude-sonnet-4-5", weight: 50 },
  { proto: "openai", model: "gpt-5-mini", weight: 30 },
  { proto: "openai", model: "gpt-4o", weight: 20 },
] as const;
const TOTAL_WEIGHT = MODELS.reduce((s, m) => s + m.weight, 0);

export const MS_DAY = 86_400_000;

export function todayStartUTC(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

// ===== deterministic PRNG (results reproducible) =====

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== process management =====

export function spawnProc(cmd: string, env: Record<string, string>) {
  return Bun.spawn({
    cmd: ["bun", cmd],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
}

export interface Stack {
  gwProc: ReturnType<typeof spawnProc>;
  upProc: ReturnType<typeof spawnProc>;
  dataDir: string;
}

export function gatewayEnv(dataDir: string): Record<string, string> {
  return {
    PORT: String(GW_PORT),
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    ADMIN_EMAIL: "perf-admin@example.com",
    ADMIN_PASSWORD: ADMIN_PW,
    LIMIT_IP_PER_MIN: "100000000",
    LIMIT_AUTH_PER_MIN: "100000000",
    DEFAULT_KEY_RPM: "100000000",
    DEFAULT_KEY_CONCURRENCY: "100000",
    STATIC_DIR: path.join(ROOT, "dist"),
  };
}

export async function startStack(dataDir: string): Promise<Stack> {
  mkdirSync(dataDir, { recursive: true });
  const upProc = spawnProc("test/fake-upstream.ts", {
    FAKE_UPSTREAM_PORT: String(UP_PORT),
    FAKE_UPSTREAM_KEY: UPSTREAM_KEY,
    FAKE_UPSTREAM_LATENCY: "5",
  });
  const gwProc = spawnProc("server/index.ts", gatewayEnv(dataDir));
  await Promise.all([waitFor(`${GW}/api/health`), waitForUpstream()]);
  return { gwProc, upProc, dataDir };
}

export async function stopStack(stack: Stack): Promise<void> {
  try { stack.gwProc.kill(); } catch {}
  try { stack.upProc.kill(); } catch {}
  // drain so we don't leave zombies that keep ports busy
  await Promise.allSettled([stack.gwProc.exited, stack.upProc.exited]);
}

export async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await Bun.sleep(100);
  }
}

async function waitForUpstream(): Promise<void> {
  await waitFor(`${UP}/openai/v1/models`, 20_000).catch(async () => {
    const r = await fetch(`${UP}/openai/v1/models`, {
      headers: { Authorization: `Bearer ${UPSTREAM_KEY}` },
    });
    if (!r.ok) throw new Error("upstream not ready");
  });
}

// ===== HTTP helpers =====

export async function api(pathname: string, body?: unknown, token?: string) {
  const res = await fetch(`${GW}${pathname}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null as any) };
}

export interface ProvisionedUser {
  id: string;
  email: string;
  accessToken: string;
  gwKey: string;
  keyId: string;
}

export async function provision(numUsers: number): Promise<{ adminToken: string; users: ProvisionedUser[] }> {
  const must = (cond: boolean, label: string, extra?: unknown) => {
    if (!cond) throw new Error(`provisioning failed at ${label}: ${JSON.stringify(extra)}`);
  };

  const login = await api("/api/auth/login", { email: "perf-admin@example.com", password: ADMIN_PW });
  must(login.status === 200, "admin login", login.json);
  const adminToken: string = login.json.accessToken;

  const p = await api(
    "/api/admin/providers",
    {
      name: "perf-provider",
      openaiBaseUrl: `${UP}/openai/v1`,
      anthropicBaseUrl: `${UP}/anthropic/v1`,
      apiKey: UPSTREAM_KEY,
    },
    adminToken,
  );
  must(p.status === 200, "create provider", p.json);

  const users: ProvisionedUser[] = [];
  for (let i = 0; i < numUsers; i++) {
    const email = `perf-user${i}@example.com`;
    const created = await api(
      "/api/admin/users",
      { email, name: `Perf User ${i}`, role: "user", sendInvite: true },
      adminToken,
    );
    must(created.status === 200, `create user ${i}`, created.json);
    const inviteToken = decodeURIComponent(String(created.json.invite.link).split("token=")[1]);
    const set = await api("/api/auth/password-reset/confirm", { token: inviteToken, password: USER_PW });
    must(set.status === 200, `set password ${i}`, set.json);
    const uLogin = await api("/api/auth/login", { email, password: USER_PW });
    must(uLogin.status === 200, `user login ${i}`, uLogin.json);
    const accessToken: string = uLogin.json.accessToken;
    const keyResp = await api("/api/keys", { name: "main" }, accessToken);
    must(keyResp.status === 200, `create key ${i}`, keyResp.json);
    users.push({
      id: created.json.user.id,
      email,
      accessToken,
      gwKey: keyResp.json.token,
      keyId: keyResp.json.key.id,
    });
  }
  return { adminToken, users };
}

/**
 * Tokens rotate/expire with the process lifetime only via refresh — but when we
 * re-attach to an existing data dir (perf-tuning measure) we must log in again.
 */
export async function relogin(numUsers: number): Promise<{ adminToken: string; users: { id: string; email: string; accessToken: string }[] }> {
  const login = await api("/api/auth/login", { email: "perf-admin@example.com", password: ADMIN_PW });
  if (login.status !== 200) throw new Error(`admin re-login failed: ${JSON.stringify(login.json)}`);
  const adminToken: string = login.json.accessToken;
  const users = [];
  for (let i = 0; i < numUsers; i++) {
    const email = `perf-user${i}@example.com`;
    const u = await api("/api/auth/login", { email, password: USER_PW });
    if (u.status !== 200) throw new Error(`user re-login failed ${i}: ${JSON.stringify(u.json)}`);
    users.push({ id: "", email, accessToken: u.json.accessToken });
  }
  return { adminToken, users };
}

// ===== history generation =====

const AUDIT_ACTIONS = [
  ["auth.login.success", 18],
  ["auth.refresh", 14],
  ["key.revealed", 3],
  ["me.updated", 2],
  ["provider.tested", 2],
  ["key.updated", 2],
  ["auth.logout", 4],
  ["key.created", 1],
  ["key.revoked", 1],
  ["2fa.enabled", 1],
  ["password.changed", 2],
] as const;
const AUDIT_TOTAL = AUDIT_ACTIONS.reduce((s, a) => s + a[1], 0);

const STATUSES = [
  [200, 940],
  [400, 20],
  [429, 15],
  [500, 15],
  [502, 10],
] as const;
const STATUS_TOTAL = STATUSES.reduce((s, st) => s + st[1], 0);

function pickWeighted<T>(rnd: () => number, table: readonly (readonly [T, number])[]): T {
  let r = rnd() * table.reduce((s, row) => s + row[1], 0);
  for (const [v, w] of table) {
    r -= w;
    if (r <= 0) return v;
  }
  return table[0]![0];
}

interface DayEvent {
  ts: number;
  proto: string;
  model: string;
  inTok: number;
  cacheTok: number;
  outTok: number;
  latency: number;
  status: number;
  stream: number;
}

/** One user-day: REQS_PER_USER_DAY events hitting the daily token totals. */
export function genDayEvents(seed: number, dayStart: number): DayEvent[] {
  const rnd = mulberry32(seed);
  const n = REQS_PER_USER_DAY;
  // random multipliers, then normalized so daily sums are exact
  const wIn = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const wCache = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const wOut = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const sIn = wIn.reduce((a, b) => a + b, 0);
  const sCache = wCache.reduce((a, b) => a + b, 0);
  const sOut = wOut.reduce((a, b) => a + b, 0);

  const out: DayEvent[] = [];
  for (let i = 0; i < n; i++) {
    let r = rnd() * TOTAL_WEIGHT;
    let m: (typeof MODELS)[number] = MODELS[0];
    for (const cand of MODELS) {
      r -= cand.weight;
      if (r <= 0) { m = cand; break; }
    }
    // 07:00–22:59 UTC waking-hours spread
    const ts = dayStart + (7 + Math.floor(rnd() * 16)) * 3_600_000 + Math.floor(rnd() * 3_599_000);
    const status = pickWeighted(rnd, STATUSES as any) as number;
    const failed = status >= 400;
    out.push({
      ts,
      proto: m.proto,
      model: m.model,
      inTok: failed ? Math.floor(rnd() * 400) : Math.round((wIn[i]! / sIn) * DAY_IN),
      cacheTok: failed ? 0 : Math.round((wCache[i]! / sCache) * DAY_CACHE),
      outTok: failed ? 0 : Math.round((wOut[i]! / sOut) * DAY_OUT),
      latency: 350 + Math.floor(rnd() ** 2 * 24_000),
      status,
      stream: rnd() < 0.6 ? 1 : 0,
    });
  }
  return out;
}

/**
 * Backfill `days` more days of history, prepended BEFORE the already-simulated
 * span (older dates), so previously written rows never move.
 * `daysAlready` = days simulated so far; day dates run [today-(daysAlready+days) .. today-(daysAlready+1)].
 */
export function backfill(
  rawDb: Database,
  users: { id: string; keyId: string }[],
  adminId: string,
  daysAlready: number,
  days: number,
): void {
  const insertEvent = rawDb.prepare(
    `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const upsertDaily = rawDb.prepare(
    `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(key_id, date)
     DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                   cache_tok = cache_tok + excluded.cache_tok,
                   out_tok = out_tok + excluded.out_tok,
                   reqs = reqs + 1`,
  );
  const insertAudit = rawDb.prepare(
    "INSERT INTO audit_log (ts, actor_id, action, target, meta, ip) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const t0 = performance.now();
  let written = 0;
  rawDb.transaction(() => {
    for (let d = 0; d < days; d++) {
      const dayStart = todayStartUTC() - (daysAlready + d + 1) * MS_DAY;
      const date = new Date(dayStart).toISOString().slice(0, 10);
      for (let u = 0; u < users.length; u++) {
        const user = users[u]!;
        const events = genDayEvents((u + 1) * 1_000_003 + (daysAlready + d) * 9_973, dayStart);
        for (const ev of events) {
          insertEvent.run(
            user.keyId, user.id, ev.ts, ev.proto, ev.model,
            ev.inTok, ev.cacheTok, ev.outTok, ev.latency, ev.status, ev.stream,
          );
          written++;
          // one upsert per request — exactly what the proxy's flush does
          upsertDaily.run(user.keyId, user.id, date, ev.inTok, ev.cacheTok, ev.outTok);
        }
        // audit trail for the day (~AUDIT_PER_USER_DAY rows/user, admin chips in too)
        const rnd = mulberry32(42_000 + u * 7_777 + (daysAlready + d) * 31);
        for (let a = 0; a < AUDIT_PER_USER_DAY; a++) {
          const action = pickWeighted(rnd, AUDIT_ACTIONS as any) as string;
          const actor = rnd() < 0.08 ? adminId : user.id;
          const ts = dayStart + Math.floor(rnd() * MS_DAY * 0.9);
          insertAudit.run(ts, actor, action, rnd() < 0.3 ? user.keyId : null, null, `10.0.${u}.${Math.floor(rnd() * 254) + 1}`);
        }
      }
    }
  })();
  const ms = performance.now() - t0;
  console.log(
    `  [backfill] +${days} day(s): ${written.toLocaleString("en-US")} events ` +
      `(${users.length * AUDIT_PER_USER_DAY * days} audit rows) in ${(ms / 1000).toFixed(1)}s`,
  );
}

export function openRawDb(dataDir: string): Database {
  // create:true — the gateway owns schema/migrations; we only ever attach to
  // a DB it already created, but a fresh dir must not hard-fail on a race.
  const rawDb = new Database(path.join(dataDir, "gateway.db"));
  rawDb.exec("PRAGMA busy_timeout = 30000");
  return rawDb;
}

export function tableCounts(rawDb: Database) {
  const c = (t: string) => (rawDb.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number;
  return {
    usage_events: c("usage_events"),
    usage_daily: c("usage_daily"),
    audit_log: c("audit_log"),
    sessions: c("sessions"),
  };
}

// ===== latency measurement =====

export interface LatStats {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  errors: number;
}

export function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Sequential timed GETs — adaptive sample size so slow endpoints don't stall the run. */
export async function measureGet(pathname: string, token?: string): Promise<LatStats> {
  const doFetch = async () => {
    const t0 = performance.now();
    const res = await fetch(`${GW}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await res.arrayBuffer();
    const ms = performance.now() - t0;
    return { ms, ok: res.ok, status: res.status };
  };
  const warm = await doFetch(); // warm caches/planner; excluded from stats
  if (!warm.ok) console.warn(`  [warn] GET ${pathname} -> ${warm.status}`);
  const reps = warm.ms > 2000 ? 3 : warm.ms > 400 ? 8 : 20;
  const lat: number[] = [];
  let errors = 0;
  for (let i = 0; i < reps; i++) {
    const r = await doFetch();
    if (!r.ok) errors++;
    lat.push(r.ms);
  }
  lat.sort((a, b) => a - b);
  return {
    n: reps,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
  };
}

export interface ProxyStats extends LatStats {
  rps: number;
}

/** Timed parallel POSTs (real proxied chat completions through the gateway). */
export async function measureProxy(
  users: { gwKey: string }[],
  count: number,
  concurrency: number,
  stream: boolean,
): Promise<ProxyStats> {
  const lat: number[] = [];
  let errors = 0;
  let idx = 0;
  const started = performance.now();
  async function worker(w: number) {
    while (true) {
      const my = idx++;
      if (my >= count) return;
      const user = users[my % users.length]!;
      const m = MODELS[(my + w) % MODELS.length]!;
      const url =
        m.proto === "openai" ? `${GW}/v1/chat/completions` : `${GW}/v1/messages`;
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.gwKey}` },
          body: JSON.stringify({
            model: m.model,
            stream,
            messages: [{ role: "user", content: "perf probe — say hello" }],
          }),
        });
        await res.arrayBuffer();
        if (res.status >= 400) {
          errors++;
          if (errors <= 3) console.warn(`  [warn] proxy ${m.proto} -> ${res.status}`);
        }
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  const wallMs = performance.now() - started;
  lat.sort((a, b) => a - b);
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
    rps: (lat.length / wallMs) * 1000,
  };
}

/** Direct-to-upstream baseline (no gateway) for overhead computation. */
export async function measureDirect(count: number, concurrency: number): Promise<ProxyStats> {
  const lat: number[] = [];
  let errors = 0;
  let idx = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= count) return;
      const t0 = performance.now();
      try {
        const res = await fetch(`${UP}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${UPSTREAM_KEY}` },
          body: JSON.stringify({ model: "fake-llm-1", messages: [{ role: "user", content: "perf probe" }] }),
        });
        await res.arrayBuffer();
        if (res.status >= 400) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - started;
  lat.sort((a, b) => a - b);
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
    rps: (lat.length / wallMs) * 1000,
  };
}

/** Standard dashboard/static endpoint set measured at every checkpoint. */
export interface EndpointSample {
  name: string;
  url: string;
  who: "user" | "admin" | "anon";
}

export function endpointSet(eventsDeepOffset: number, auditDeepOffset: number): EndpointSample[] {
  return [
    // control: near-zero DB work, should stay flat
    { name: "me", url: "/api/me", who: "user" },
    // user dashboard
    { name: "keys.list", url: "/api/keys", who: "user" },
    { name: "usage.summary", url: "/api/usage/summary", who: "user" },
    { name: "usage.daily.14d", url: "/api/usage/daily?days=14", who: "user" },
    { name: "usage.daily.all", url: "/api/usage/daily?days=all", who: "user" },
    { name: "usage.hourly.24h", url: "/api/usage/daily?hours=24", who: "user" },
    { name: "usage.events.p1", url: "/api/usage/events?limit=25&offset=0", who: "user" },
    { name: "usage.events.deep", url: `/api/usage/events?limit=100&offset=${eventsDeepOffset}`, who: "user" },
    { name: "usage.bymodel.14d", url: "/api/usage/by-model?days=14", who: "user" },
    { name: "usage.bymodel.all", url: "/api/usage/by-model?days=all", who: "user" },
    // admin dashboard
    { name: "admin.stats.24h", url: "/api/admin/stats?hours=24", who: "admin" },
    { name: "admin.stats.14d", url: "/api/admin/stats?days=14", who: "admin" },
    { name: "admin.stats.all", url: "/api/admin/stats?days=all", who: "admin" },
    { name: "admin.audit.p1", url: "/api/admin/audit?limit=50&offset=0", who: "admin" },
    { name: "admin.audit.deep", url: `/api/admin/audit?limit=50&offset=${auditDeepOffset}`, who: "admin" },
    { name: "admin.users", url: "/api/admin/users", who: "admin" },
    { name: "admin.keys", url: "/api/admin/keys", who: "admin" },
    // SPA / frontend delivery
    { name: "static.index", url: "/", who: "anon" },
  ];
}
