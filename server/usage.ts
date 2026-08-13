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
  inTok: number;
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
  `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream, estimated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const upsertDaily = db.prepare(
  `INSERT INTO usage_daily (key_id, user_id, date, in_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, 1)
   ON CONFLICT(key_id, date)
   DO UPDATE SET in_tok = in_tok + excluded.in_tok,
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
      insertEvent.run(
        ev.keyId,
        ev.userId,
        ts,
        ev.proto,
        ev.model.slice(0, 128),
        ev.inTok,
        ev.outTok,
        ev.latencyMs,
        ev.status,
        ev.stream ? 1 : 0,
        ev.estimated ? 1 : 0,
      );
      upsertDaily.run(ev.keyId, ev.userId, utcDate(ts), ev.inTok, ev.outTok);
      affectedKeys.add(ev.keyId);
    }
  })();
  for (const k of affectedKeys) spendCache.delete(k);
}

// ===== Budget reads (cached) =====

interface Spend {
  today: number;
  total: number;
  fetchedAt: number;
}

const spendCache = new Map<string, Spend>();
const SPEND_TTL_MS = 2_000;

const qToday = db.prepare<{ t: number }, [string, string]>(
  "SELECT COALESCE(in_tok + out_tok, 0) AS t FROM usage_daily WHERE key_id = ? AND date = ?",
);
const qTotal = db.prepare<{ t: number }, [string]>(
  "SELECT COALESCE(SUM(in_tok + out_tok), 0) AS t FROM usage_daily WHERE key_id = ?",
);

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

export function userDailySeries(userId: string, days: number) {
  return db
    .prepare(
      `SELECT date, SUM(in_tok) AS in_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
       FROM usage_daily WHERE user_id = ? AND date >= date('now', ?)
       GROUP BY date ORDER BY date`,
    )
    .all(userId, `-${days} days`);
}

export function keyDailySeries(keyId: string, days: number) {
  return db
    .prepare(
      `SELECT date, in_tok, out_tok, reqs FROM usage_daily
       WHERE key_id = ? AND date >= date('now', ?) ORDER BY date`,
    )
    .all(keyId, `-${days} days`);
}

export function userSummary(userId: string) {
  const today = db
    .prepare<{ in_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
       FROM usage_daily WHERE user_id = ? AND date = date('now')`,
    )
    .get(userId)!;
  const month = db
    .prepare<{ in_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
       FROM usage_daily WHERE user_id = ? AND date >= date('now', 'start of month')`,
    )
    .get(userId)!;
  const total = db
    .prepare<{ in_tok: number; out_tok: number; reqs: number }, [string]>(
      `SELECT COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
       FROM usage_daily WHERE user_id = ?`,
    )
    .get(userId)!;
  return { today, month, total };
}

export function userEvents(userId: string, opts: { keyId?: string; limit: number; offset: number }) {
  const where = opts.keyId ? "user_id = ? AND key_id = ?" : "user_id = ?";
  const params = opts.keyId ? [userId, opts.keyId] : [userId];
  const rows = db
    .prepare(
      `SELECT id, key_id, ts, proto, model, in_tok, out_tok, latency_ms, status, stream
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
