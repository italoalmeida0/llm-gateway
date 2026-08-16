/**
 * scripts/perf-tuning.ts — empirical before/after experiments on a big dataset.
 *
 * Subcommands:
 *   bun scripts/perf-tuning.ts build <dir> [days]
 *       Boot a stack on <dir>, provision the 5-user scenario, backfill `days`
 *       of history (default 3650), save credentials to <dir>/meta.json, stop.
 *   bun scripts/perf-tuning.ts measure <dir> [label]
 *       Boot the CURRENT server code on <dir> (any pending migrations apply),
 *       re-login, measure the full endpoint set + proxy, print a table, and
 *       append the result to <dir>/measurements.json under `label`.
 *   bun scripts/perf-tuning.ts sql <dir>
 *       Direct-attach to the DB: time the hot dashboard queries, then apply
 *       candidate fixes (ANALYZE; covering indexes) timing every step, and
 *       re-time the queries after each step. No server booted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

import {
  NUM_USERS, GW,
  startStack, stopStack, provision, relogin, backfill, openRawDb, tableCounts,
  measureGet, measureDirect, measureProxy, endpointSet,
} from "./perf-common";

const [cmd, dir, ...rest] = process.argv.slice(2);
if (!cmd || !dir || !["build", "measure", "sql"].includes(cmd)) {
  console.error("usage: perf-tuning.ts build|measure|sql <dir> [days|label]");
  process.exit(1);
}
const DAYS = Number(rest[0] || 3650);

// ================= build =================
if (cmd === "build") {
  if (existsSync(path.join(dir, "gateway.db"))) {
    console.error(`[tuning] ${dir} already has a gateway.db — pick a fresh dir`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const stack = await startStack(dir);
  const rawDb = openRawDb(dir);
  try {
    const { adminToken, users } = await provision(NUM_USERS);
    const adminId = (rawDb.query("SELECT id FROM users WHERE role='admin'").get() as any).id as string;
    backfill(rawDb, users, adminId, 0, DAYS);
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ adminToken, users: users.map((u) => ({ id: u.id, email: u.email, gwKey: u.gwKey, keyId: u.keyId })) }, null, 2),
    );
    const rows = tableCounts(rawDb);
    console.log(`[tuning] built ${dir}: ${JSON.stringify(rows)} dbMB=${(Bun.file(path.join(dir, "gateway.db")).size / 1048576).toFixed(1)}`);
  } finally {
    await stopStack(stack);
    rawDb.close(false);
  }
  process.exit(0);
}

// ================= measure =================
if (cmd === "measure") {
  const label = String(rest[0] || `run-${Date.now()}`);
  const stack = await startStack(dir);
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
    const { adminToken, users } = await relogin(NUM_USERS);
    const rawDb = openRawDb(dir);
    const rows = tableCounts(rawDb);
    rawDb.close(false);

    const userKeys = meta.users.map((u: any) => ({ gwKey: u.gwKey }));
    const direct = await measureDirect(60, 8);
    await measureProxy(userKeys, 80, 8, false); // warm
    const nonstream = await measureProxy(userKeys, 100, 8, false);
    const stream = await measureProxy(userKeys, 30, 5, true);

    const out: Record<string, any> = {
      label,
      at: new Date().toISOString(),
      rows,
      proxy: {
        overheadP50: nonstream.p50 - direct.p50,
        overheadP95: nonstream.p95 - direct.p95,
        nonstreamP50: nonstream.p50, nonstreamP95: nonstream.p95,
        streamP50: stream.p50, streamP95: stream.p95,
      },
      endpoints: {} as Record<string, { p50: number; p95: number }>,
    };

    const router = meta.router === true;
    const set = endpointSet(10_000, 5_000, { router });
    // also the SPA bundle
    try {
      const html = await (await fetch(`${GW}/`)).text();
      const m = html.match(/src="([^"]+\.js)"/);
      if (m) set.push({ name: "static.bundle", url: m[1]!.startsWith("/") ? m[1]! : `/${m[1]!.replace(/^\.\//, "")}`, who: "anon" });
    } catch {}
    for (const ep of set) {
      const token =
        ep.who === "admin" ? adminToken
        : ep.who === "user" ? users[0]!.accessToken
        : ep.who === "gw" ? meta.users[0].gwKey
        : undefined;
      const s = await measureGet(ep.url, token);
      out.endpoints[ep.name] = { p50: s.p50, p95: s.p95 };
    }

    const dbPath = path.join(dir, "measurements.json");
    const all = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : [];
    all.push(out);
    writeFileSync(dbPath, JSON.stringify(all, null, 2));

    console.log(`\n===== ${label} =====`);
    console.log(`proxy overhead p50 ${out.proxy.overheadP50.toFixed(2)}ms p95 ${out.proxy.overheadP95.toFixed(2)}ms`);
    for (const [k, v] of Object.entries(out.endpoints)) {
      console.log(`  ${k.padEnd(20)} p50 ${v.p50.toFixed(1).padStart(8)}  p95 ${v.p95.toFixed(1).padStart(8)}`);
    }
  } finally {
    await stopStack(stack);
  }
  process.exit(0);
}

// ================= sql =================
{
  const db = openRawDb(dir);
  const time = (name: string, fn: () => unknown, reps = 5): number => {
    fn(); // warm
    const lat: number[] = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      fn();
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)]!;
    console.log(`  ${name.padEnd(58)} p50 ${p50.toFixed(1).padStart(9)}ms`);
    return p50;
  };

  const userId = (db.query("SELECT user_id FROM usage_events LIMIT 1").get() as any).user_id as string;
  const now = Date.now();
  const DAY = 86_400_000;

  const queries: [string, () => unknown][] = [
    ["perModel GLOBAL 24h (stats?hours=24)", () =>
      db.prepare(`SELECT model, proto, SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*) FROM usage_events WHERE ts >= ? GROUP BY model, proto ORDER BY 1`).all(now - DAY)],
    ["perModel GLOBAL all (stats?days=all)", () =>
      db.prepare(`SELECT model, proto, SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*) FROM usage_events WHERE ts >= ? GROUP BY model, proto ORDER BY 1`).all(0)],
    ["perUser 24h (stats?hours=24)", () =>
      db.prepare(`SELECT ue.user_id, u.email, SUM(ue.in_tok), SUM(ue.cache_tok), SUM(ue.out_tok), COUNT(*) FROM usage_events ue JOIN users u ON u.id = ue.user_id WHERE ue.ts >= ? GROUP BY ue.user_id`).all(now - DAY)],
    ["by-model USER all (by-model?days=all)", () =>
      db.prepare(`SELECT model, proto, SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*) FROM usage_events WHERE user_id = ? AND ts >= ? GROUP BY model, proto`).all(userId, 0)],
    ["events COUNT user (events?limit=25)", () =>
      db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?`).get(userId)],
    ["events page deep (offset 10000)", () =>
      db.prepare(`SELECT id, key_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream FROM usage_events WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 100 OFFSET 10000`).all(userId)],
    ["audit COUNT (*)", () => db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()],
    ["audit page p1 (join users)", () =>
      db.prepare(`SELECT a.ts, a.action, a.target, a.meta, a.ip, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.ts DESC, a.id DESC LIMIT 50`).all()],
  ];

  console.log(`\n[sql] baseline (no ANALYZE, original indexes) — events=${(tableCounts(db)).usage_events.toLocaleString("en-US")}`);
  for (const [n, q] of queries) time(n, q);

  console.log(`\n[sql] step 1: ANALYZE`);
  time("ANALYZE (one-time cost)", () => db.exec("ANALYZE"), 1);
  for (const [n, q] of queries) time(n, q);

  console.log(`\n[sql] step 2: covering index (user_id, ts, proto, model, tokens...)`);
  time("CREATE INDEX idx_usage_user_cov", () =>
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_user_cov ON usage_events(user_id, ts, proto, model, in_tok, cache_tok, out_tok)`), 1);
  db.exec("ANALYZE");
  for (const [n, q] of queries) time(n, q);

  console.log(`\n[sql] step 3: covering index (ts, proto, model, tokens...)`);
  time("CREATE INDEX idx_usage_ts_cov", () =>
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts_cov ON usage_events(ts, proto, model, in_tok, cache_tok, out_tok)`), 1);
  db.exec("ANALYZE");
  for (const [n, q] of queries) time(n, q);

  console.log(`\n[sql] disk cost`);
  const sz = Bun.file(path.join(dir, "gateway.db")).size / 1048576;
  console.log(`  gateway.db size with new indexes: ${sz.toFixed(1)} MB`);
  try {
    const idxRows = db.query(`SELECT name, SUM(pgsize)/1048576.0 AS mb FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT 8`).all() as any[];
    for (const r of idxRows) console.log(`  ${String(r.name).padEnd(28)} ${Number(r.mb).toFixed(1)} MB`);
  } catch {
    console.log("  (dbstat vtab unavailable in this bun build — file size above is the disk cost)");
  }

  db.close(false);
  process.exit(0);
}
