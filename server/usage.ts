import { db } from "./db";

/**
 * Usage accounting.
 *
 * Writes: proxy events are buffered and flushed in one transaction (every
 * second or every 100 events) so a busy proxy never does per-request writes.
 *
 * Reads: per-key spend (today + all-time) is cached for ~2s because the
 * proxy checks budgets on EVERY request. Flush invalidates affected cache
 * entries. SQLite (usage_daily) is the source of truth — the cache is only
 * ever a read optimization, never authoritative state.
 */

export interface UsageEvent {
  keyId: string;
  userId: string;
  proto: "openai" | "anthropic";
  model: string;
  /** Cache-free input tokens (providers charge full price for these). */
  inTok: number;
  /** Cached input tokens — cache reads (+ Anthropic cache creation), billed
   *  at the provider's cache rate. Tracked in their own bucket, never folded
   *  into inTok. */
  cacheTok: number;
  outTok: number;
  latencyMs: number;
  status: number;
  stream: boolean;
  estimated: boolean;
  ts?: number;
}

const buffer: UsageEvent[] = [];
let flushScheduled = false;

export function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function recordUsage(ev: UsageEvent): void {
  buffer.push(ev);
  if (buffer.length >= 100) {
    flushUsage();
    return;
  }
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flushUsage, 1_000).unref();
  }
}

const insertEvent = db.prepare(
  `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDaily = db.prepare(
  `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, ?, 1)
   ON CONFLICT(key_id, date)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                 cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok,
                 reqs = reqs + 1`,
);
// Same rollup, one dimension deeper (model): powers the per-model dashboard
// queries without scanning usage_events (~0.03ms extra per event, measured).
const upsertModelDaily = db.prepare(
  `INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
   ON CONFLICT(key_id, date, proto, model)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                 cache_tok = cache_tok + excluded.cache_tok,
                 out_tok = out_tok + excluded.out_tok,
                 reqs = reqs + 1`,
);

export function flushUsage(): void {
  flushScheduled = false;
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  const affectedKeys = new Set<string>();
  db.transaction(() => {
    for (const ev of batch) {
      const ts = ev.ts ?? Date.now();
      const model = ev.model.slice(0, 128);
      insertEvent.run(
        ev.keyId,
        ev.userId,
        ts,
        ev.proto,
        model,
        ev.inTok,
        ev.cacheTok,
        ev.outTok,
        ev.latencyMs,
        ev.status,
        ev.stream ? 1 : 0,
        ev.estimated ? 1 : 0,
      );
      const date = utcDate(ts);
      upsertDaily.run(ev.keyId, ev.userId, date, ev.inTok, ev.cacheTok, ev.outTok);
      upsertModelDaily.run(ev.keyId, ev.userId, date, ev.proto, model, ev.inTok, ev.cacheTok, ev.outTok);
      affectedKeys.add(ev.keyId);
    }
  })();
  for (const k of affectedKeys) spendCache.delete(k);
}

// ===== Budget reads (cached) =====

/**
 * Key budgets (daily_limit / total_limit) cap OUTPUT tokens only — the
 * category providers price highest and the one the key owner controls.
 * Input and cached-input tokens are metered in their own buckets for
 * visibility, but they never consume a key's budget.
 */
interface Spend {
  today: number;
  total: number;
  fetchedAt: number;
}

const spendCache = new Map<string, Spend>();
const SPEND_TTL_MS = 2_000;

const qToday = db.prepare<{ t: number }, [string, string]>(
  "SELECT COALESCE(out_tok, 0) AS t FROM usage_daily WHERE key_id = ? AND date = ?",
);
const qTotal = db.prepare<{ t: number }, [string]>(
  "SELECT COALESCE(SUM(out_tok), 0) AS t FROM usage_daily WHERE key_id = ?",
);

/** OUTPUT-token burn of a key, UTC-today and all-time. */
export function getKeySpend(keyId: string): { today: number; total: number } {
  const now = Date.now();
  const cached = spendCache.get(keyId);
  if (cached && now - cached.fetchedAt < SPEND_TTL_MS) {
    return { today: cached.today, total: cached.total };
  }
  const today = qToday.get(keyId, utcDate(now))?.t ?? 0;
  const total = qTotal.get(keyId)?.t ?? 0;
  spendCache.set(keyId, { today, total, fetchedAt: now });
  return { today, total };
}

// ===== Dashboard queries =====

export interface HourlyPoint {
  date: string; // "2026-08-13 13:00 UTC" (tooltip/legend text)
  label: string; // "13:00" (axis tick)
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
}

const HOUR_MS = 3_600_000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Hourly buckets for the trailing `hours` hours (UTC), zero-filled so charts
 * render quiet hours as empty bars instead of gaps. Reads usage_events —
 * usage_daily can't go below one day. Optional userId/keyId narrow the scope;
 * both null = global.
 */
export function hourlySeries(userId: string | null, keyId: string | null, hours: number): HourlyPoint[] {
  const h = Math.min(Math.max(Math.floor(hours) || 24, 1), 168);
  const startHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (h - 1) * HOUR_MS;
  const clauses = ["ts >= ?"];
  const params: Array<string | number> = [startHour];
  if (userId !== null) {
    clauses.push("user_id = ?");
    params.push(userId);
  }
  if (keyId !== null) {
    clauses.push("key_id = ?");
    params.push(keyId);
  }
  const rows = db
    .prepare<{ hbucket: number; in_tok: number; cache_tok: number; out_tok: number; reqs: number }, any[]>(
      `SELECT (ts / ?) AS hbucket,
              COALESCE(SUM(in_tok), 0) AS in_tok,
              COALESCE(SUM(cache_tok), 0) AS cache_tok,
              COALESCE(SUM(out_tok), 0) AS out_tok,
              COUNT(*) AS reqs
       FROM usage_events WHERE ${clauses.join(" AND ")}
       GROUP BY hbucket`,
    )
    .all(HOUR_MS, ...params);
  const byBucket = new Map(rows.map((r) => [r.hbucket, r]));
  const out: HourlyPoint[] = [];
  for (let i = 0; i < h; i++) {
    const ts = startHour + i * HOUR_MS;
    const r = byBucket.get(Math.floor(ts / HOUR_MS));
    const d = new Date(ts);
    out.push({
      date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:00 UTC`,
      label: `${pad2(d.getUTCHours())}:00`,
      in_tok: r?.in_tok ?? 0,
      cache_tok: r?.cache_tok ?? 0,
      out_tok: r?.out_tok ?? 0,
      reqs: r?.reqs ?? 0,
    });
  }
  return out;
}

/** Daily series over the trailing `days` days — or the full history ("all"). */
export function userDailySeries(userId: string, days: number | "all") {
  if (days === "all") {
    return db
      .prepare(
        `SELECT date, SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
         FROM usage_daily WHERE user_id = ? GROUP BY date ORDER BY date`,
      )
      .all(userId);
  }
  return db
    .prepare(
      `SELECT date, SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
       FROM usage_daily WHERE user_id = ? AND date >= date('now', ?)
       GROUP BY date ORDER BY date`,
    )
    .all(userId, `-${days} days`);
}

export function keyDailySeries(keyId: string, days: number | "all") {
  if (days === "all") {
    return db
      .prepare(
        `SELECT date, in_tok, cache_tok, out_tok, reqs FROM usage_daily
         WHERE key_id = ? ORDER BY date`,
      )
      .all(keyId);
  }
  return db
    .prepare(
      `SELECT date, in_tok, cache_tok, out_tok, reqs FROM usage_daily
       WHERE key_id = ? AND date >= date('now', ?) ORDER BY date`,
    )
    .all(keyId, `-${days} days`);
}

const SUMMARY_COLS = `COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs`;

export function userSummary(userId: string) {
  const today = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT ${SUMMARY_COLS} FROM usage_daily WHERE user_id = ? AND date = date('now')`,
    )
    .get(userId)!;
  const month = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT ${SUMMARY_COLS} FROM usage_daily WHERE user_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(userId)!;
  const total = db
    .prepare<{ in_tok: number; cache_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT ${SUMMARY_COLS} FROM usage_daily WHERE user_id = ?`,
    )
    .get(userId)!;
  return { today, month, total };
}

export function userEvents(userId: string, opts: { keyId?: string; limit: number; offset: number }) {
  const where = opts.keyId ? "user_id = ? AND key_id = ?" : "user_id = ?";
  const params = opts.keyId ? [userId, opts.keyId] : [userId];
  const rows = db
    .prepare(
      `SELECT id, key_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream
       FROM usage_events WHERE ${where}
       ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...(params as [string, string]), opts.limit, opts.offset);
  const count = db
    .prepare<{ n: number }, [string, string] | [string]>(
      `SELECT COUNT(*) AS n FROM usage_events WHERE ${where}`,
    )
    // @ts-expect-error tuple spread fine at runtime
    .get(...params)!.n;
  return { rows, total: count };
}
