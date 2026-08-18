/**
 * scripts/load_test.ts — empirical scale audit for the exact production
 * scenario (20 intensive users × 500 reqs/day → 10k usage_events/day,
 * 10M in / 100M cache / 500k out tokens per user-day, 50 audit rows per
 * user-day).
 *
 *   bun scripts/load_test.ts [dir=/tmp/gw-load-test] [days=365] [--live] [--report=path]
 *
 * STAGES
 *   1. seed   — a real gateway boot creates the schema (all migrations incl.
 *      migration 013); `days` of history are bulk-inserted into SQLite using
 *      the SAME genDayEvents per-request distribution as the perf backfill,
 *      and the three rollup tables receive the exact aggregate rows the
 *      proxy flush maintains (aggregated from the raw events, exactly like
 *      migration backfills compute them).
 *   2. probe  — times every read the user + admin dashboards run, plus the
 *      gateway flush WRITE path, in both DB states:
 *        pre-013  = schema as shipped before migration 013
 *        post-013 = migration 013 applied (keyset + sort-covering indexes)
 *      Each probe runs the SHIPPED OFFSET query shape AND the keyset-cursor
 *      shape in BOTH index states → the report shows the full 2×2 matrix.
 *      Also captures EXPLAIN QUERY PLAN of the deep pages.
 *   3. live   (--live only) — boots the real gateway + a fake upstream on the
 *      seeded DB, logs in with seeded credentials, measures the real HTTP
 *      endpoints (JWT auth, JSON overhead, proxied LLM traffic incl. the
 *      buffered SQLite flush).
 *   4. report — console table + markdown report (default <dir>/report.md).
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";

// `bun test` discovers *any* `*_test*` file and executes it as an entry —
// this benchmark must never run during the test suite. The PRIMARY guard is
// bunfig.toml's `[test] root = "test"` (discovery never reaches scripts/).
// Empirically, bun 1.3.0 executes discovered entries with import.meta.main
// === true and import.meta.test unreliable, so the runtime guard below is
// only defense-in-depth for bun versions where import.meta.test works.
if (!import.meta.test) {
// ---- scenario parameters (the audited load) — set BEFORE perf-common loads
process.env.PERF_NUM_USERS = "20";
process.env.PERF_REQS_PER_USER_DAY = "500";
process.env.PERF_AUDIT_PER_USER_DAY = "50";
process.env.PERF_DAY_IN = "10000000";
process.env.PERF_DAY_CACHE = "100000000";
process.env.PERF_DAY_OUT = "500000";

const argList = process.argv.slice(2);
const dir = path.resolve(argList[0] || "/tmp/gw-load-test");
const days = Number(argList[1] || 365);
const live = argList.includes("--live");
const reuse = argList.includes("--reuse"); // skip seeding, probe an existing DB
const reportArg = argList.find((a) => a.startsWith("--report="));
const reportPath = reportArg ? path.resolve(reportArg.split("=")[1]!) : path.join(dir, "report.md");
if (!Number.isInteger(days) || days < 1) throw new Error("days must be a positive integer");
if (existsSync(path.join(dir, "gateway.db")) && !reuse) {
  throw new Error(`refusing to overwrite existing database: ${dir}`);
}
if (!existsSync(path.join(dir, "gateway.db")) && reuse) {
  throw new Error(`--reuse requested but no database at ${dir}`);
}
mkdirSync(dir, { recursive: true });

// perf-common reads the scenario env at import time — import it lazily.
const pc = await import("./perf-common");
const {
  NUM_USERS, REQS_PER_USER_DAY, AUDIT_PER_USER_DAY, DAY_IN, DAY_CACHE,
  DAY_OUT, genDayEvents, mulberry32, todayStartUTC, MS_DAY, GW, UP, startStack,
  stopStack, waitFor, measureGet, measureDirect, measureProxy, openRawDb,
  tableCounts, ADMIN_PW, USER_PW, UPSTREAM_KEY,
} = pc;
const { sha256Hex, hashPassword } = await import("../server/crypto");

const ROOT = path.resolve(import.meta.dir, "..");
const BOOT_SUB = Number(process.env.PERF_GW_PORT || 5460) + 200;
const bootUrl = `http://127.0.0.1:${BOOT_SUB}/api/health`;

console.log(
  `load_test: ${NUM_USERS} users × ${REQS_PER_USER_DAY} reqs/day for ${days} days` +
    ` (${(DAY_IN / 1e6).toFixed(0)}M in / ${(DAY_CACHE / 1e6).toFixed(0)}M cache / ${(DAY_OUT / 1e3).toFixed(0)}k out per user-day, ${AUDIT_PER_USER_DAY} audit/user-day)`,
);

// =====================================================================
// Stage 1 — seed
// =====================================================================

function seedUsers(): { id: string; keyId: string }[] {
  const out: { id: string; keyId: string }[] = [];
  for (let i = 0; i < NUM_USERS; i++) {
    out.push({ id: `lu-user-${String(i).padStart(3, "0")}`, keyId: `lu-key-${String(i).padStart(3, "0")}` });
  }
  return out;
}

async function seedScenario(): Promise<void> {
  const t0 = performance.now();

  // 1) schema via a REAL gateway boot (migrations incl. 013)
  const boot = Bun.spawn({
    cmd: ["bun", "server/index.ts"],
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(BOOT_SUB),
      NODE_ENV: "development",
      DATA_DIR: dir,
      ADMIN_EMAIL: "perf-admin@example.com",
      ADMIN_PASSWORD: ADMIN_PW,
      STATIC_DIR: path.join(ROOT, "dist"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitFor(bootUrl, 30_000);
  } finally {
    boot.kill();
    await boot.exited;
  }

  const db = openRawDb(dir);
  try {
    const userHash = await hashPassword(USER_PW);
    const adminHash = await hashPassword(ADMIN_PW);
    const users = seedUsers();

    // 2) users + one gateway key each. The gateway boot above already
    //    created the admin user — OR IGNORE keeps seeding idempotent.
    const insUser = db.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, role, password_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    );
    const insKey = db.prepare(
      `INSERT INTO api_keys (id, user_id, name, prefix, hash, created_at, status)
       VALUES (?, ?, 'main', 'gw_', ?, ?, 'active')`,
    );
    db.transaction(() => {
      insUser.run("lu-admin", "perf-admin@example.com", "Load Admin", "admin", adminHash, Date.now());
      for (let i = 0; i < users.length; i++) {
        const u = users[i]!;
        insUser.run(u.id, `perf-user${i}@example.com`, `Load User ${i}`, "user", userHash, Date.now());
        insKey.run(u.keyId, u.id, sha256Hex(`load-test-gw-key-${i}-secret`), Date.now());
      }
    })();

    // 3) usage_events — one row per request (same token/model/status spread
    //    as the perf backfill); per-day in-memory aggregation feeds rollups.
    const EV = [
      "key_id", "user_id", "ts", "proto", "model",
      "in_tok", "cache_tok", "out_tok", "latency_ms", "status", "stream", "estimated",
      "provider_id", "provider_key_id", "upstream_model",
    ].join(",");
    const insEvent = db.prepare(
      `INSERT INTO usage_events (${EV}) VALUES (${EV.split(",").map(() => "?").join(",")})`,
    );
    const daily = new Map<string, { u: string; in: number; cache: number; out: number; reqs: number }>();
    const modelDaily = new Map<string, { in: number; cache: number; out: number; reqs: number }>();
    const mpd = new Map<string, { in: number; cache: number; out: number; reqs: number }>();

    let events = 0;
    const startDay = todayStartUTC() - days * MS_DAY;
    for (let d = 0; d < days; d++) {
      const dayStart = startDay + d * MS_DAY;
      const date = new Date(dayStart).toISOString().slice(0, 10);
      db.transaction(() => {
        for (let u = 0; u < users.length; u++) {
          const user = users[u]!;
          const evs = genDayEvents((u + 1) * 1_000_003 + d * 9_973, dayStart);
          for (const ev of evs) {
            insEvent.run(
              user.keyId, user.id, ev.ts, ev.proto, ev.model,
              ev.inTok, ev.cacheTok, ev.outTok, ev.latency, ev.status, ev.stream, 0,
              "", "", "",
            );
            events++;
            const dk = `${user.keyId}\u0000${date}`;
            const dl = daily.get(dk) ?? { u: user.id, in: 0, cache: 0, out: 0, reqs: 0 };
            dl.in += ev.inTok; dl.cache += ev.cacheTok; dl.out += ev.outTok; dl.reqs++;
            daily.set(dk, dl);
            const mk = `${user.keyId}\u0000${date}\u0000${ev.proto}\u0000${ev.model}`;
            const ml = modelDaily.get(mk) ?? { in: 0, cache: 0, out: 0, reqs: 0 };
            ml.in += ev.inTok; ml.cache += ev.cacheTok; ml.out += ev.outTok; ml.reqs++;
            modelDaily.set(mk, ml);
            const pk = `${user.keyId}\u0000${date}\u0000${ev.proto}\u0000\u0000${ev.model}\u0000`;
            const pl = mpd.get(pk) ?? { in: 0, cache: 0, out: 0, reqs: 0 };
            pl.in += ev.inTok; pl.cache += ev.cacheTok; pl.out += ev.outTok; pl.reqs++;
            mpd.set(pk, pl);
          }
        }
      })();
    }
    console.log(`  [seed] ${events.toLocaleString("en-US")} usage_events rows`);

    // 4) rollup tables — exact rows the proxy flush upserts per day
    const insDaily = db.prepare(
      `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insModelDaily = db.prepare(
      `INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insMpd = db.prepare(
      `INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, '', '', ?, '', ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const [k, v] of daily) {
        const [keyId, date] = k.split("\u0000");
        insDaily.run(keyId, v.u, date, v.in, v.cache, v.out, v.reqs);
      }
      for (const [k, v] of modelDaily) {
        const [keyId, date, proto, m] = k.split("\u0000");
        insModelDaily.run(keyId, keyId.replace("lu-key-", "lu-user-"), date, proto, m, v.in, v.cache, v.out, v.reqs);
      }
      for (const [k, v] of mpd) {
        const [keyId, date, proto, , m] = k.split("\u0000");
        insMpd.run(keyId, keyId.replace("lu-key-", "lu-user-"), date, proto, m, v.in, v.cache, v.out, v.reqs);
      }
    })();

    // 5) audit trail — 50 rows per user-day
    const insAudit = db.prepare(
      "INSERT INTO audit_log (ts, actor_id, action, target, meta, ip) VALUES (?, ?, ?, ?, NULL, ?)",
    );
    const AUDIT_ACTIONS = [
      "auth.login.success", "auth.refresh", "key.revealed", "me.updated",
      "provider.tested", "key.created", "key.revoked", "2fa.enabled",
      "password.changed", "provider.updated", "provider_key.reenabled",
    ];
    db.transaction(() => {
      for (let d = 0; d < days; d++) {
        const dayStart = startDay + d * MS_DAY;
        const rnd = mulberry32(42_000 + d * 31);
        for (let u = 0; u < NUM_USERS; u++) {
          for (let a = 0; a < AUDIT_PER_USER_DAY; a++) {
            const action = AUDIT_ACTIONS[Math.floor(rnd() * AUDIT_ACTIONS.length)]!;
            const ts = dayStart + Math.floor(rnd() * MS_DAY * 0.9);
            insAudit.run(
              ts, users[u]!.id, action,
              rnd() < 0.5 ? users[u]!.keyId : null,
              `10.0.${u}.${Math.floor(rnd() * 254) + 1}`,
            );
          }
        }
      }
    })();
    console.log(`  [DB] ${(NUM_USERS * AUDIT_PER_USER_DAY * days).toLocaleString("en-US")} audit_log rows`);

    db.exec("PRAGMA optimize");
  } finally {
    db.close(false);
  }
  console.log(`[seed] complete in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

// =====================================================================
// Stage 2 — SQL probes: (OFFSET vs KEYSET) × (pre-013 vs post-013)
// =====================================================================

type DB = import("bun:sqlite").Database;

const IDX_013_DEFS = [
  { name: "idx_usage_user_ts_id", sql: "CREATE INDEX IF NOT EXISTS idx_usage_user_ts_id ON usage_events(user_id, ts, id)" },
  { name: "idx_usage_user_in_tok_id", sql: "CREATE INDEX IF NOT EXISTS idx_usage_user_in_tok_id ON usage_events(user_id, in_tok, id)" },
  { name: "idx_audit_ts_id", sql: "CREATE INDEX IF NOT EXISTS idx_audit_ts_id ON audit_log(ts, id)" },
  { name: "idx_audit_action_ts", sql: "CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log(action, ts, id)" },
];

function setIndexState(db: DB, present: boolean): void {
  // A latency_ms tail was tested and REJECTED during the audit (its
  // unselective filter flips the planner onto a temp-sort of half the user
  // slice) — scrub it from datasets seeded with the earlier migration text.
  db.exec("DROP INDEX IF EXISTS idx_usage_user_latency_id");
  for (const def of IDX_013_DEFS) {
    db.exec(present ? def.sql : `DROP INDEX IF EXISTS ${def.name}`);
  }
  db.exec("ANALYZE");
}

function medianMs(fn: () => unknown, reps = 7): number {
  fn(); // warm
  const t: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return Math.round(t[Math.floor(t.length / 2)]! * 100) / 100;
}

interface ProbeRow {
  name: string;
  /** shipped OFFSET SQL × pre-013 indexes — i.e. TODAY'S PRODUCTION */
  today: number | null;
  /** shipped OFFSET SQL × post-013 indexes (index-only win) */
  offset013: number | null;
  /** keyset SQL × pre-013 indexes */
  keysetOld: number | null;
  /** keyset SQL × post-013 indexes — THE SHIPPED FIX */
  keyset013: number | null;
}

function runProbes(): ProbeRow[] {
  const db = openRawDb(dir);
  const uid = seedUsers()[0]!.id;

  // ---- equivalent deep pages for the offset/keyset pair ----
  const userTotal = (db.query(`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?`).get(uid) as any).n as number;
  const auditTotal = (db.query(`SELECT COUNT(*) AS n FROM audit_log`).get() as any).n as number;
  const evDeep = Math.max(0, userTotal - 101);
  const auDeep = Math.max(0, auditTotal - 51);
  const evCur = db.query(
    `SELECT ts, id FROM usage_events WHERE user_id = ? ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?`,
  ).get(uid, evDeep - 1) as { ts: number; id: number };
  const auCur = db.query(
    `SELECT ts, id FROM audit_log ORDER BY ts DESC, id DESC LIMIT 1 OFFSET ?`,
  ).get(auDeep - 1) as { ts: number; id: number };

  // exact SELECT shapes the production code runs (userEvents JOINs, grid
  // page wrapper, audit join) — not simplified stand-ins.
  const EV = `SELECT e.id, e.key_id, e.ts, e.proto, e.model,
                     e.in_tok, e.cache_tok, e.out_tok, e.latency_ms, e.status, e.stream,
                     e.provider_id, e.upstream_model,
                     COALESCE(k.name, substr(e.key_id,1,8)) AS key_name
              FROM usage_events e
              LEFT JOIN api_keys k ON k.id = e.key_id
              LEFT JOIN providers p ON p.id = e.provider_id
              LEFT JOIN provider_keys pk ON pk.id = e.provider_key_id`;
  const AU = `SELECT a.ts, a.action, a.target, a.meta, a.ip, u.email AS actor_email
              FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id`;

  interface Probe {
    name: string;
    offset: (d: DB) => unknown;
    keyset?: (d: DB) => unknown;
  }

  const probes: Probe[] = [
    // ---------- user dashboard (rollup-backed reads) ----------
    {
      name: "usage.summary (3 SELECTs)",
      offset: (d) => {
        const s = "COALESCE(SUM(in_tok),0), COALESCE(SUM(cache_tok),0), COALESCE(SUM(out_tok),0), COALESCE(SUM(reqs),0)";
        const today = new Date().toISOString().slice(0, 10);
        d.query(`SELECT ${s} FROM usage_daily WHERE user_id = ? AND date = ?`).get(uid, today);
        d.query(`SELECT ${s} FROM usage_daily WHERE user_id = ? AND date >= date('now','start of month')`).get(uid);
        d.query(`SELECT ${s} FROM usage_daily WHERE user_id = ?`).get(uid);
      },
    },
    {
      name: "usage.daily?days=all",
      offset: (d) => d.query(
        `SELECT date, SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
         FROM usage_daily WHERE user_id = ? GROUP BY date ORDER BY date`,
      ).all(uid),
    },
    {
      name: "usage.daily?hours=24 (raw events)",
      offset: (d) => d.query(
        `SELECT (ts / 3600000) AS hbucket, SUM(in_tok), SUM(cache_tok), SUM(out_tok), COUNT(*)
         FROM usage_events WHERE ts >= ? AND user_id = ? GROUP BY hbucket`,
      ).all(Date.now() - 24 * 3_600_000, uid),
    },
    {
      name: "usage/by-model?days=all",
      offset: (d) => d.query(
        `SELECT model, proto, SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
         FROM usage_model_daily WHERE user_id = ? GROUP BY model, proto`,
      ).all(uid),
    },
    // ---------- user recent-requests grid (raw usage_events) ----------
    {
      name: "events.page1 (limit 100)",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 100`).all(uid),
    },
    {
      name: `events.deep.OFFSET (${evDeep.toLocaleString("en-US")})`,
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 100 OFFSET ?`).all(uid, evDeep),
      keyset: (d) => d.query(`${EV} WHERE e.user_id = ? AND (e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?)
                              ORDER BY e.ts DESC, e.id DESC LIMIT 100`).all(uid, evCur.ts, evCur.ts, evCur.id),
    },
    {
      name: "events.count (per block)",
      offset: (d) => d.query(`SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ?`).get(uid),
    },
    {
      name: "events.count+joins (pre-fix SQL)",
      offset: (d) => d.query(
        `SELECT COUNT(*) AS n FROM usage_events e
         LEFT JOIN api_keys k ON k.id = e.key_id
         LEFT JOIN providers p ON p.id = e.provider_id
         WHERE e.user_id = ?`,
      ).get(uid),
    },
    {
      name: "events.sort.latency_ms DESC",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? ORDER BY e.latency_ms DESC, e.id DESC LIMIT 100`).all(uid),
    },
    {
      name: "events.sort.in_tok DESC",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? ORDER BY e.in_tok DESC, e.id DESC LIMIT 100`).all(uid),
    },
    {
      name: "events.filter.latency_ms>=5000",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? AND e.latency_ms >= 5000 ORDER BY e.ts DESC, e.id DESC LIMIT 100`).all(uid),
    },
    {
      name: "events.filter.key_name LIKE %main%",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? AND COALESCE(k.name, substr(e.key_id,1,8)) LIKE '%main%' ESCAPE '\\'
                              ORDER BY e.ts DESC, e.id DESC LIMIT 100`).all(uid),
    },
    {
      name: "events.filter.in_tok>=100000",
      offset: (d) => d.query(`${EV} WHERE e.user_id = ? AND e.in_tok >= 100000 ORDER BY e.ts DESC, e.id DESC LIMIT 100`).all(uid),
    },
    // ---------- admin dashboard (rollup-backed) ----------
    {
      name: "admin.stats.series.all",
      offset: (d) => d.query(
        `SELECT date, SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
         FROM usage_daily GROUP BY date ORDER BY date`,
      ).all(),
    },
    {
      name: "admin.stats.perUser.all",
      offset: (d) => d.query(
        `SELECT ud.user_id, COALESCE(u.email, ud.user_id), SUM(ud.in_tok), SUM(ud.cache_tok), SUM(ud.out_tok), SUM(ud.reqs)
         FROM usage_daily ud LEFT JOIN users u ON u.id = ud.user_id GROUP BY ud.user_id`,
      ).all(),
    },
    {
      name: "admin.stats.perModel.all",
      offset: (d) => d.query(
        `SELECT model, proto, SUM(in_tok), SUM(cache_tok), SUM(out_tok), SUM(reqs)
         FROM usage_model_daily GROUP BY model, proto LIMIT 50`,
      ).all(),
    },
    {
      name: "admin.stats.totals",
      offset: (d) => d.query(
        `SELECT COALESCE(SUM(in_tok),0), COALESCE(SUM(cache_tok),0), COALESCE(SUM(out_tok),0), COALESCE(SUM(reqs),0)
         FROM usage_daily`,
      ).get(),
    },
    {
      name: "admin.usage-breakdown (users, limit 2000)",
      offset: (d) => d.query(
        `SELECT ud.user_id, COALESCE(u.email, ud.user_id),
                SUM(ud.in_tok), SUM(ud.cache_tok), SUM(ud.out_tok), SUM(ud.reqs)
         FROM usage_model_provider_daily ud LEFT JOIN users u ON u.id = ud.user_id
         GROUP BY ud.user_id ORDER BY (SUM(ud.in_tok) + SUM(ud.cache_tok) + SUM(ud.out_tok)) DESC LIMIT 2000`,
      ).all(),
    },
    // ---------- admin audit log (raw table) ----------
    {
      name: "audit.page1 (limit 50)",
      offset: (d) => d.query(`${AU} ORDER BY a.ts DESC, a.id DESC LIMIT 50`).all(),
    },
    {
      name: `audit.deep.OFFSET (${auDeep.toLocaleString("en-US")})`,
      offset: (d) => d.query(`${AU} ORDER BY a.ts DESC, a.id DESC LIMIT 50 OFFSET ?`).all(auDeep),
      keyset: (d) => d.query(`${AU} WHERE (a.ts <= ?) AND NOT (a.ts = ? AND a.id >= ?)
                              ORDER BY a.ts DESC, a.id DESC LIMIT 50`).all(auCur.ts, auCur.ts, auCur.id),
    },
    {
      name: "audit.count",
      offset: (d) => d.query(`SELECT COUNT(*) AS n FROM audit_log`).get(),
    },
    {
      name: "audit.filter.action='provider.tested'",
      offset: (d) => d.query(`${AU} WHERE a.action = 'provider.tested' ORDER BY a.ts DESC, a.id DESC LIMIT 50`).all(),
    },
    {
      name: "audit.filter.action~%key%",
      offset: (d) => d.query(`${AU} WHERE a.action LIKE '%key%' ESCAPE '\\' ORDER BY a.ts DESC, a.id DESC LIMIT 50`).all(),
    },
  ];

  // ---------- WRITE path: the exact 4-statement proxy flush ----------
  const flushProbe = (n: number) => (d: DB) => {
    const ins = d.prepare(
      `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated, provider_id, provider_key_id, upstream_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', '')`,
    );
    const upD = d.prepare(
      `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(key_id, date) DO UPDATE SET
         in_tok = in_tok + excluded.in_tok, cache_tok = cache_tok + excluded.cache_tok,
         out_tok = out_tok + excluded.out_tok, reqs = reqs + 1`,
    );
    const upM = d.prepare(
      `INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(key_id, date, proto, model) DO UPDATE SET
         in_tok = in_tok + excluded.in_tok, cache_tok = cache_tok + excluded.cache_tok,
         out_tok = out_tok + excluded.out_tok, reqs = reqs + 1`,
    );
    const upP = d.prepare(
      `INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
       VALUES (?, ?, ?, ?, '', '', ?, '', ?, ?, ?, 1) ON CONFLICT(key_id, date, proto, provider_id, provider_key_id, model, upstream_model) DO UPDATE SET
         in_tok = in_tok + excluded.in_tok, cache_tok = cache_tok + excluded.cache_tok,
         out_tok = out_tok + excluded.out_tok, reqs = reqs + 1`,
    );
    d.transaction(() => {
      for (let i = 0; i < n; i++) {
        const ts = Date.now() - i;
        const date = new Date(ts).toISOString().slice(0, 10);
        ins.run("__flush__", uid, ts, "openai", "probe-model", 1000, 5000, 50, 300, 200, 0);
        upD.run("__flush__", uid, date, 1000, 5000, 50);
        upM.run("__flush__", uid, date, "openai", "probe-model", 1000, 5000, 50);
        upP.run("__flush__", uid, date, "openai", "probe-model", 1000, 5000, 50);
      }
    })();
    // cleanup so repeated reps stay identical
    d.exec("DELETE FROM usage_events WHERE key_id = '__flush__'");
    d.exec("DELETE FROM usage_daily WHERE key_id = '__flush__'");
    d.exec("DELETE FROM usage_model_daily WHERE key_id = '__flush__'");
    d.exec("DELETE FROM usage_model_provider_daily WHERE key_id = '__flush__'");
  };
  probes.push({ name: "flush.100 events (1 tx)", offset: flushProbe(100) });
  probes.push({ name: "flush.1000 events (1 tx)", offset: flushProbe(1000) });

  const rows = new Map<string, ProbeRow>();
  try {
    // post-013 index state first
    setIndexState(db, true);
    for (const p of probes) {
      const row: ProbeRow = { name: p.name, today: null, offset013: null, keysetOld: null, keyset013: null };
      row.offset013 = medianMs(() => p.offset(db));
      rows.set(p.name, row);
    }
    // pre-013 (today's production schema)
    setIndexState(db, false);
    for (const p of probes) {
      rows.get(p.name)!.today = medianMs(() => p.offset(db));
    }
    // keyset shapes in both states
    for (const p of probes) {
      if (!p.keyset) continue;
      setIndexState(db, true);
      rows.get(p.name)!.keyset013 = medianMs(() => p.keyset!(db));
      setIndexState(db, false);
      rows.get(p.name)!.keysetOld = medianMs(() => p.keyset!(db));
    }
  } finally {
    setIndexState(db, true); // leave the DB in the shipped post-013 state
    db.close(false);
  }
  return [...rows.values()];
}

function explainPlans(): string[] {
  const db = openRawDb(dir);
  setIndexState(db, true);
  const uid = seedUsers()[0]!.id;
  const out: string[] = [];
  const fmt = (q: string, rows: Array<{ detail: string }>) =>
    ["```", q, ...rows.map((r) => r.detail), "```"].join("\n");
  const ev = `FROM usage_events e LEFT JOIN api_keys k ON k.id = e.key_id`;
  out.push(`### OFFSET deep page (pre-013 index set)\n` +
    fmt(
      `SELECT e.id ${ev} WHERE e.user_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 100 OFFSET 90000`,
      db.query(
        `EXPLAIN QUERY PLAN SELECT e.id ${ev} WHERE e.user_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 100 OFFSET 90000`,
      ).all(uid) as Array<{ detail: string }>,
    ));
out.push(`### Keyset deep page (migration-013 index set)\n` + fmt(
    `SELECT e.id ${ev} WHERE e.user_id = ? AND (e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?) ORDER BY e.ts DESC, e.id DESC LIMIT 100`,
    db.query(
      `EXPLAIN QUERY PLAN SELECT e.id ${ev} WHERE e.user_id = ? AND (e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?) ORDER BY e.ts DESC, e.id DESC LIMIT 100`,
    ).all(uid, 1, 1, 1) as Array<{ detail: string }>,
  ));
  db.close(false);
  return out;
}

// =====================================================================
// Stage 3 — live HTTP (--live)
// =====================================================================

interface LiveRow {
  name: string;
  endpoint: string;
  p50: number;
  p95: number;
}

async function runLive(): Promise<LiveRow[]> {
  const stack = (await startStack(dir)) as ReturnType<typeof startStack>;
  const out: LiveRow[] = [];
  try {
    const api = (p: string, body?: unknown, token?: string, method?: string) =>
      fetch(`${GW}${p}`, {
        method: method ?? (body !== undefined ? "POST" : "GET"),
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    const login = async (email: string, password: string) => {
      const r = await api("/api/auth/login", { email, password });
      if (r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(r.json).slice(0, 160)}`);
      return r.json.accessToken as string;
    };
    const adminToken = await login("perf-admin@example.com", ADMIN_PW);
    const userToken = await login("perf-user0@example.com", USER_PW);

    // a provider on the fake upstream (passthrough routing stays default) —
    // idempotent so repeated --live runs on the same DB don't accumulate.
    const existing = await api("/api/admin/providers", undefined, adminToken);
    const already = (existing.json?.providers ?? []).some(
      (p: { name: string }) => p.name === "load-audit-provider",
    );
    if (!already) {
      const prov = await api(
        "/api/admin/providers",
        {
          name: "load-audit-provider",
          openaiBaseUrl: `${UP}/openai/v1`,
          anthropicBaseUrl: `${UP}/anthropic/v1`,
          apiKey: UPSTREAM_KEY,
        },
        adminToken,
        "POST",
      );
      if (prov.status !== 200) {
        throw new Error(`provider create failed: ${prov.status} ${JSON.stringify(prov.json).slice(0, 200)}`);
      }
    }
    // gateway key for the proxy burst: the plaintext is only shown ONCE, so
    // each run creates its own (keys are cheap rows; provider reuse above is
    // what keeps the DB tidy).
    const keyResp = await api("/api/keys", { name: `load-live-${Date.now()}` }, userToken, "POST");
    if (keyResp.status !== 200) throw new Error(`key create failed: ${keyResp.status}`);
    const gwKey = keyResp.json.token as string;

    // ---- user facing endpoints ----
    const E: Array<[string, string, string | undefined]> = [
      ["me (control)", "/api/me", userToken],
      ["usage.summary", "/api/usage/summary", userToken],
      ["usage.daily?days=all", "/api/usage/daily?days=all", userToken],
      ["usage.daily?hours=24", "/api/usage/daily?hours=24", userToken],
      ["usage.events?limit=100 (p1)", "/api/usage/events?limit=100", userToken],
      ["usage.events?limit=100&offset=10000", "/api/usage/events?limit=100&offset=10000", userToken],
      ["usage.events?limit=100&offset=100000", "/api/usage/events?limit=100&offset=100000", userToken],
      ["usage.breakdown?days=all", "/api/usage/breakdown?days=all", userToken],
      ["usage/by-model?days=all", "/api/usage/by-model?days=all", userToken],
      ["admin.stats?days=all", "/api/admin/stats?days=all", adminToken],
      ["admin.stats?hours=24", "/api/admin/stats?hours=24", adminToken],
      ["admin.audit?limit=50 (p1)", "/api/admin/audit?limit=50", adminToken],
      ["admin.audit?limit=50&offset=5000", "/api/admin/audit?limit=50&offset=5000", adminToken],
      ["admin.usage-breakdown?days=all", "/api/admin/usage-breakdown?days=all", adminToken],
    ];
    for (const [name, p, token] of E) {
      const s = await measureGet(p, token);
      out.push({ name, endpoint: p, p50: s.p50, p95: s.p95 });
    }

    // ---- keyset continuation through the real HTTP surface ----
    const cur = await fetch(`${GW}/api/usage/events?limit=100`, {
      headers: { Authorization: `Bearer ${userToken}` },
    }).then((r) => r.json()) as { events: Array<{ ts: number; id: number }> };
    const last = cur.events[cur.events.length - 1]!;
    const k = await measureGet(`/api/usage/events?limit=100&cursor=${last.ts}:${last.id}`, userToken);
    out.push({ name: "usage.events?cursor=… (p2)", endpoint: "<cursor>", p50: k.p50, p95: k.p95 });

    // ---- proxy: real LLM traffic through the gateway on the seeded DB ----
    const direct = await measureDirect(60, 8);
    await measureProxy([{ gwKey }], 60, 8, false); // warm
    const proxy = await measureProxy([{ gwKey }], 120, 8, false);
    const stream = await measureProxy([{ gwKey }], 30, 5, true);
    out.push({
      name: `proxy.nonstream ${proxy.rps.toFixed(0)} rps (+${(proxy.p50 - direct.p50).toFixed(1)}ms over direct)`,
      endpoint: "/v1/chat/completions",
      p50: Math.round(proxy.p50), p95: Math.round(proxy.p95),
    });
    out.push({
      name: `proxy.stream ${stream.rps.toFixed(0)} rps`,
      endpoint: "/v1/chat/completions",
      p50: Math.round(stream.p50), p95: Math.round(stream.p95),
    });
  } finally {
    await stopStack(stack);
  }
  return out;
}

// =====================================================================
// Stage 4 — report
// =====================================================================

function buildReport(rows: ProbeRow[], liveRows: LiveRow[], plans: string[]): string {
  const db = openRawDb(dir);
  const counts = tableCounts(db);
  const dbMB = (Bun.file(path.join(dir, "gateway.db")).size / 1048576).toFixed(1);
  db.close(false);

  const cell = (v: number | null) => (v === null ? "—" : v.toFixed(2));
  const table = [
    "| probe | **today** (OFFSET, pre-013) | OFFSET, post-013 | keyset, pre-013 | **keyset, post-013** |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.name} | ${cell(r.today)} | ${cell(r.offset013)} | ${cell(r.keysetOld)} | ${cell(r.keyset013)} |`),
  ].join("\n");
  const liveTable = liveRows.length
    ? `\n## Live HTTP (real gateway on seeded DB)\n\n| endpoint | p50 ms | p95 ms |\n|---|---|---|\n` +
      liveRows.map((r) => `| ${r.name} | ${r.p50} | ${r.p95} |`).join("\n")
    : "";
  const sum = [
    `- usage_events: ${counts.usage_events?.toLocaleString("en-US")}`,
    `- usage_daily: ${counts.usage_daily?.toLocaleString("en-US")}`,
    `- usage_model_daily: ${counts.usage_model_daily?.toLocaleString("en-US")}`,
    `- usage_model_provider_daily: ${counts.usage_model_provider_daily?.toLocaleString("en-US")}`,
    `- audit_log: ${counts.audit_log?.toLocaleString("en-US")}`,
    `- gateway.db: ${dbMB} MB`,
  ].join("\n");

  return `# load_test — scale audit\n\n` +
    `Scenario: ${NUM_USERS} users × ${REQS_PER_USER_DAY} reqs/day × ${days} days.\n` +
    `Daily tokens per user: ${(DAY_IN / 1e6).toFixed(0)}M in / ${(DAY_CACHE / 1e6).toFixed(0)}M cache / ${(DAY_OUT / 1e3).toFixed(0)}k out; ` +
    `${AUDIT_PER_USER_DAY} audit rows/user/day.\n\n## Seeded volume\n\n${sum}\n\n` +
    `## SQL probes — median of 7 runs, ms\n\n${table}\n\n` +
    (plans.length ? `## EXPLAIN QUERY PLAN (deep events page)\n\n${plans.join("\n\n")}\n\n` : "") +
    liveTable;
}

// =====================================================================
// main — only when run directly (import.meta.main): `bun test` should
// never execute this long-running benchmark as a discovered test file.
// =====================================================================

if (import.meta.main) {
  if (!reuse) await seedScenario();

  console.log("\n[probes] timing the dashboard/grid query set in both DB states…");
  const rows = runProbes();
  const plans = explainPlans();

  const liveRows = live ? await runLive() : [];

  for (const r of rows) {
    const today = r.today ?? -1;
    const o13 = r.offset013 ?? -1;
    const k13 = r.keyset013 ?? -1;
    console.log(
      `  ${r.name.padEnd(44)}  today=${today.toFixed(2).padStart(8)}ms   offset013=${o13.toFixed(2).padStart(8)}ms   keyset013=${k13.toFixed(2).padStart(8)}ms`,
    );
  }

  const md = buildReport(rows, liveRows, plans);
  writeFileSync(reportPath, md);
  console.log(`\n[report] wrote ${reportPath}`);
}
} // end `if (!import.meta.test)` — never runs under `bun test`