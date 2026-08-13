/**
 * scripts/seed-usage.ts — fills usage_events / usage_daily with realistic mock
 * data so the dashboard and usage pages can be previewed without real traffic.
 * Dev tool only: seeds every existing gateway key. Deterministic (fixed seed),
 * so re-running produces the same shape of data.
 *
 * Usage:
 *   bun run seed                 # 60 days, replaces existing usage rows
 *   bun run seed -- --days 30    # custom window (1..365)
 *   bun run seed -- --keep       # keep existing rows, append mock data
 */

import { db } from "../server/db";

// ===== CLI args =====

let days = 60;
let keep = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--days") days = Number(process.argv[++i]);
  else if (a === "--keep") keep = true;
  else if (a === "-h" || a === "--help") {
    console.log("bun run seed -- [--days N] [--keep]");
    process.exit(0);
  } else {
    console.error(`unknown arg: ${a}`);
    process.exit(1);
  }
}
if (!Number.isFinite(days) || days < 1 || days > 365) {
  console.error("--days must be between 1 and 365");
  process.exit(1);
}

// ===== Deterministic PRNG (mulberry32) =====

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0xc0ffee);

// ===== Mock shape =====

interface ModelSpec {
  proto: "openai" | "anthropic";
  model: string;
  weight: number; // relative popularity
  inMax: number; // token ceilings — actual values skew small (rnd²)
  outMax: number;
}
const MODELS: ModelSpec[] = [
  { proto: "openai", model: "gpt-4o-mini", weight: 30, inMax: 2_000, outMax: 600 },
  { proto: "openai", model: "gpt-4o", weight: 18, inMax: 10_000, outMax: 2_500 },
  { proto: "openai", model: "gpt-5-mini", weight: 16, inMax: 6_000, outMax: 1_800 },
  { proto: "openai", model: "o4-mini", weight: 6, inMax: 14_000, outMax: 4_000 },
  { proto: "anthropic", model: "claude-haiku-4-5", weight: 15, inMax: 3_000, outMax: 800 },
  { proto: "anthropic", model: "claude-sonnet-4-5", weight: 12, inMax: 24_000, outMax: 3_000 },
  { proto: "anthropic", model: "claude-opus-4-1", weight: 3, inMax: 40_000, outMax: 5_000 },
];
const TOTAL_WEIGHT = MODELS.reduce((s, m) => s + m.weight, 0);

function pickModel(): ModelSpec {
  let r = rnd() * TOTAL_WEIGHT;
  for (const m of MODELS) {
    r -= m.weight;
    if (r <= 0) return m;
  }
  return MODELS[0]!;
}

function pickStatus(): number {
  const r = rnd();
  if (r < 0.93) return 200;
  if (r < 0.955) return 400;
  if (r < 0.975) return 429;
  if (r < 0.985) return 500;
  return 502;
}

// ===== Generate =====

const keys = db
  .query<{ id: string; user_id: string; name: string }, []>(
    "SELECT id, user_id, name FROM api_keys ORDER BY created_at",
  )
  .all();

if (keys.length === 0) {
  console.error("[seed] no gateway keys found — create a key in the dashboard first");
  process.exit(1);
}

if (!keep) {
  db.exec("DELETE FROM usage_events");
  db.exec("DELETE FROM usage_daily");
}

const insertEvent = db.prepare(
  `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const insertDaily = db.prepare(
  `INSERT INTO usage_daily (key_id, user_id, date, in_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const MS_DAY = 86_400_000;
const todayStart = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);

let eventCount = 0;
const daily = new Map<
  string,
  { keyId: string; userId: string; date: string; inTok: number; outTok: number; reqs: number }
>();

db.transaction(() => {
  for (const key of keys) {
    // Each key gets its own activity profile: baseline requests/day.
    const baseReqs = 6 + Math.floor(rnd() * 14);
    for (let d = days - 1; d >= 0; d--) {
      const dayStart = todayStart - d * MS_DAY;
      const dow = new Date(dayStart).getUTCDay();
      const weekend = dow === 0 || dow === 6 ? 0.45 : 1;
      const ramp = 0.6 + 0.8 * (1 - d / days); // usage grows over time
      const jitter = 0.5 + rnd();
      const nReqs = Math.round(baseReqs * weekend * ramp * jitter);

      for (let r = 0; r < nReqs; r++) {
        // Requests cluster around waking hours (07:00–22:00 UTC).
        const hour = 7 + Math.floor(rnd() * 15);
        const ts = dayStart + hour * 3_600_000 + Math.floor(rnd() * 3_600_000);
        // "Today" is partial: don't generate future timestamps.
        if (ts > Date.now()) continue;

        const m = pickModel();
        const status = pickStatus();
        const failed = status >= 400;
        const inTok = failed ? Math.floor(rnd() * 400) : 80 + Math.floor(rnd() ** 2 * m.inMax);
        const outTok = failed ? 0 : 40 + Math.floor(rnd() ** 2 * m.outMax);
        const latency = 150 + Math.floor(rnd() ** 2 * 8_000);

        insertEvent.run(
          key.id,
          key.user_id,
          ts,
          m.proto,
          m.model,
          inTok,
          outTok,
          latency,
          status,
          rnd() < 0.55 ? 1 : 0,
          0,
        );
        eventCount++;

        const date = new Date(ts).toISOString().slice(0, 10);
        const aggKey = `${key.id}|${date}`;
        const agg = daily.get(aggKey) ?? {
          keyId: key.id,
          userId: key.user_id,
          date,
          inTok: 0,
          outTok: 0,
          reqs: 0,
        };
        agg.inTok += inTok;
        agg.outTok += outTok;
        agg.reqs += 1;
        daily.set(aggKey, agg);
      }
    }
  }
  for (const a of daily.values()) {
    insertDaily.run(a.keyId, a.userId, a.date, a.inTok, a.outTok, a.reqs);
  }
})();

console.log(
  `[seed] ${keep ? "appended" : "replaced"} usage: ${eventCount} events, ` +
    `${daily.size} daily rows, ${days} days, ${keys.length} key(s)`,
);
for (const k of keys) console.log(`  - ${k.name} (${k.id.slice(0, 8)}…)`);

const top = db
  .query<{ model: string; proto: string; reqs: number; tok: number }, []>(
    `SELECT model, proto, COUNT(*) AS reqs, SUM(in_tok + out_tok) AS tok
     FROM usage_events GROUP BY model, proto ORDER BY tok DESC`,
  )
  .all();
console.log("[seed] by model:");
for (const t of top) {
  console.log(
    `  ${t.proto.padEnd(9)} ${t.model.padEnd(18)} ${String(t.reqs).padStart(5)} reqs  ${t.tok.toLocaleString("en-US")} tok`,
  );
}
