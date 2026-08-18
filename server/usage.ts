import { db } from "./db";
import { buildGridWhere, buildGridOrder, gridPage, type ColSpec, type GridFilterEntry, type GridSort } from "./gridql";

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
  /** Upstream dimension (which candidate of the failover chain answered).
   *  Empty strings on pre-011 events. */
  providerId?: string;
  providerKeyId?: string;
  upstreamModel?: string;
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
  `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated, provider_id, provider_key_id, upstream_model)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
// Deepest rollup (migration 011): adds the upstream dimensions — provider,
// provider key and upstream model id — powering the AG Grid usage breakdown
// (filter by provider / upstream model / provider key) without scanning
// usage_events. Written alongside the two shallower rollups.
const upsertModelProviderDaily = db.prepare(
  `INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
   ON CONFLICT(key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
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
        ev.providerId ?? "",
        ev.providerKeyId ?? "",
        ev.upstreamModel ?? "",
      );
      const date = utcDate(ts);
      upsertDaily.run(ev.keyId, ev.userId, date, ev.inTok, ev.cacheTok, ev.outTok);
      upsertModelDaily.run(ev.keyId, ev.userId, date, ev.proto, model, ev.inTok, ev.cacheTok, ev.outTok);
      upsertModelProviderDaily.run(
        ev.keyId,
        ev.userId,
        date,
        ev.proto,
        ev.providerId ?? "",
        ev.providerKeyId ?? "",
        model,
        ev.upstreamModel ?? "",
        ev.inTok,
        ev.cacheTok,
        ev.outTok,
      );
      affectedKeys.add(ev.keyId);
    }
  })();
  for (const k of affectedKeys) spendCache.delete(k);
  // New rows just landed: every view's total changed. Clearing beats keying
  // precisely — flushes are ≤1/s and the TTL cache rebuilds on next read.
  if (batch.length > 0) eventCountCache.clear();
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
 * usage_daily can't go below one day. Optional userId/keyId/providerId narrow
 * the scope; both null = global.
 */
export function hourlySeries(userId: string | null, keyId: string | null, hours: number, providerId?: string): HourlyPoint[] {
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
  if (providerId) {
    clauses.push("provider_id = ?");
    params.push(providerId);
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

/**
 * Detailed per-key × model × (provider × upstream-model × provider key) rollup read
 * (migration 011's usage_model_provider_daily) for the dashboard grids.
 * Joins resolve display names; paged grid reads apply filters and sorting in SQL.
 */
export interface UsageBreakdownRow {
  key_id: string;
  key_name: string;
  model: string;
  proto: "openai" | "anthropic";
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
}

function usageBreakdownScope(
  userId: string,
  opts: { keyId?: string; providerId?: string; days: number | "all" },
): { where: string; params: Array<string | number> } {
  const clauses: string[] = ["m.user_id = ?"];
  const params: Array<string | number> = [userId];
  if (opts.keyId) {
    clauses.push("m.key_id = ?");
    params.push(opts.keyId);
  }
  if (opts.providerId) {
    clauses.push("m.provider_id = ?");
    params.push(opts.providerId);
  }
  if (opts.days !== "all") {
    clauses.push("m.date >= date('now', ?)");
    params.push(`-${Math.min(Math.max(Number(opts.days) || 14, 1), 365)} days`);
  }
  return { where: clauses.join(" AND "), params };
}

const USER_BREAKDOWN_COLS: Record<string, ColSpec> = {
  key_id: { col: "key_id" },
  key_name: { col: "key_name" },
  model: { col: "model" },
  proto: { col: "proto" },
  provider_id: { col: "provider_id" },
  provider_name: { col: "provider_name" },
  provider_key_id: { col: "provider_key_id" },
  provider_key_label: { col: "provider_key_label" },
  upstream_model: { col: "upstream_model" },
  in_tok: { col: "in_tok", kind: "number" },
  cache_tok: { col: "cache_tok", kind: "number" },
  out_tok: { col: "out_tok", kind: "number" },
  reqs: { col: "reqs", kind: "number" },
};

export function userUsageBreakdown(
  userId: string,
  opts: { keyId?: string; providerId?: string; days: number | "all"; limit?: number },
): UsageBreakdownRow[] {
  const { where, params } = usageBreakdownScope(userId, opts);
  return db
    .prepare(
      `SELECT m.key_id, COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name, m.model, m.proto,
              m.provider_id, p.name AS provider_name, m.provider_key_id, pk.label AS provider_key_label,
              m.upstream_model,
              SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok, SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs
       FROM usage_model_provider_daily m
       LEFT JOIN api_keys k ON k.id = m.key_id
       LEFT JOIN providers p ON p.id = m.provider_id
       LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id
       WHERE ${where}
       GROUP BY m.key_id, m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model
       ORDER BY (SUM(m.in_tok) + SUM(m.cache_tok) + SUM(m.out_tok)) DESC
       LIMIT ?`,
    )
    .all(...params, opts.limit ?? 2000) as UsageBreakdownRow[];
}

export function queryUserUsageBreakdown(
  userId: string,
  opts: {
    keyId?: string;
    providerId?: string;
    days: number | "all";
    limit: number;
    offset: number;
    sort?: GridSort[];
    filters?: Record<string, GridFilterEntry>;
  },
): { rows: UsageBreakdownRow[]; total: number; totals: { in_tok: number; cache_tok: number; out_tok: number; reqs: number } } {
  const { where, params } = usageBreakdownScope(userId, opts);
  const baseSql = `
    SELECT m.key_id,
           COALESCE(k.name, substr(m.key_id, 1, 8)) AS key_name,
           m.model, m.proto, m.provider_id, p.name AS provider_name,
           m.provider_key_id, pk.label AS provider_key_label, m.upstream_model,
           SUM(m.in_tok) AS in_tok, SUM(m.cache_tok) AS cache_tok,
           SUM(m.out_tok) AS out_tok, SUM(m.reqs) AS reqs
    FROM usage_model_provider_daily m
    LEFT JOIN api_keys k ON k.id = m.key_id
    LEFT JOIN providers p ON p.id = m.provider_id
    LEFT JOIN provider_keys pk ON pk.id = m.provider_key_id
    WHERE ${where}
    GROUP BY m.key_id, m.model, m.proto, m.provider_id, m.provider_key_id, m.upstream_model`;
  return gridPage({
    baseSql,
    baseParams: params,
    cols: USER_BREAKDOWN_COLS,
    grid: opts,
    defaultOrder: "(in_tok + cache_tok + out_tok) DESC",
    tieBreak: "key_id DESC, model DESC, provider_id DESC, provider_key_id DESC, upstream_model DESC",
    sumCols: ["in_tok", "cache_tok", "out_tok", "reqs"],
  }) as { rows: UsageBreakdownRow[]; total: number; totals: { in_tok: number; cache_tok: number; out_tok: number; reqs: number } };
}

// ===== Server-driven events query (AG Grid infinite row model) =====

/** Grid sort/filter column map — STRICT whitelist; unknown columns are simply
 *  ignored (never spliced into SQL). Translation lives in server/gridql. */
const EVENT_COLS: Record<string, ColSpec> = {
  ts: { col: "e.ts", kind: "date" },
  key_name: { col: "COALESCE(k.name, substr(e.key_id, 1, 8))" },
  proto: { col: "e.proto" },
  provider_name: { col: "COALESCE(p.name, '')" },
  model: { col: "e.model" },
  upstream_model: { col: "e.upstream_model" },
  latency_ms: { col: "e.latency_ms", kind: "number" },
  in_tok: { col: "e.in_tok", kind: "number" },
  cache_tok: { col: "e.cache_tok", kind: "number" },
  out_tok: { col: "e.out_tok", kind: "number" },
  status: { col: "e.status", kind: "number" },
};

export type EventFilterEntry = GridFilterEntry;

export function buildEventFilter(
  filters: Record<string, EventFilterEntry>,
): { clauses: string[]; params: Array<string | number> } {
  return buildGridWhere(filters, EVENT_COLS);
}

export function buildEventOrder(
  sort: Array<{ colId: string; sort: string }> | undefined,
): string {
  return buildGridOrder(sort, EVENT_COLS, "e.ts DESC", "e.id DESC");
}

export function userEvents(
  userId: string,
  opts: {
    keyId?: string;
    limit: number;
    offset: number;
    sort?: Array<{ colId: string; sort: string }>;
    filters?: Record<string, GridFilterEntry>;
    /** Keyset cursor (`ts`, `id` of the previous page's last row) — makes
     *  deep forward pages O(page) instead of O(offset). Only honored for the
     *  default (ts DESC, id DESC) ordering; custom sorts keep OFFSET. */
    cursor?: { ts: number; id: number };
  },
): { rows: any[]; total: number; totals: { in_tok: number; cache_tok: number; out_tok: number; reqs: number } } {
  // Scope (user + filters) shared by the page query and the total-count;
  // the keyset cursor predicate applies to the page query ONLY — the count
  // must answer "how many rows exist for this filter view", not "how many
  // remain after this cursor".
  const scopeClauses = [opts.keyId ? "e.user_id = ? AND e.key_id = ?" : "e.user_id = ?"];
  const scopeParams: Array<string | number> = opts.keyId ? [userId, opts.keyId] : [userId];
  if (opts.filters) {
    const { clauses: fc, params: fp } = buildGridWhere(opts.filters, EVENT_COLS);
    scopeClauses.push(...fc);
    scopeParams.push(...fp);
  }
  const useCursor = !!opts.cursor && (!opts.sort || opts.sort.length === 0);
  const pageClauses = [...scopeClauses];
  const pageParams = [...scopeParams];
  if (useCursor) {
    // Keyset continuation: rows strictly older than (cursor.ts, cursor.id).
    // Written as one backward index range (`ts <= X`) plus an exclusion
    // predicate for the boundary row — a `ts < ? OR (ts = ? AND id < ?)`
    // collapses on a near-now cursor (SQLite's MULTI-INDEX OR temp-sorts
    // the user's WHOLE slice: ~200-300ms at 3.65M events, measured). The
    // exclusion is a post-filter over an already-indexed range: O(page +
    // ties-at-boundary), exact even when events share a millisecond.
    pageClauses.push("(e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?)");
    pageParams.push(opts.cursor!.ts, opts.cursor!.ts, opts.cursor!.id);
  }
  const order = buildGridOrder(opts.sort, EVENT_COLS, "e.ts DESC", "e.id DESC");
  const rows = db
    .prepare(
      // LEFT JOINs: hard-deleted keys/providers must not hide their history.
      `SELECT e.id, e.key_id, COALESCE(k.name, substr(e.key_id, 1, 8)) AS key_name, e.ts, e.proto, e.model,
              e.in_tok, e.cache_tok, e.out_tok, e.latency_ms, e.status, e.stream,
              e.provider_id, p.name AS provider_name, e.provider_key_id, pk.label AS provider_key_label,
              e.upstream_model
       FROM usage_events e
       LEFT JOIN api_keys k ON k.id = e.key_id
       LEFT JOIN providers p ON p.id = e.provider_id
       LEFT JOIN provider_keys pk ON pk.id = e.provider_key_id
       WHERE ${pageClauses.join(" AND ")}
       ORDER BY ${order} LIMIT ?${useCursor ? "" : " OFFSET ?"}`,
    )
    .all(...pageParams, opts.limit, ...(useCursor ? [] : [opts.offset]));

  // The COUNT must never do per-row joins: a LEFT JOIN resolves
  // api_keys/providers for EVERY row of the user's whole history (~85ms at
  // 3.65M events, measured — 10x the page query). The joins only DECORATE
  // the page with names, they filter nothing, so the count runs on
  // usage_events alone; joined-name filters (key_name, provider_name) are
  // the only case that needs the joins back. A short TTL cache absorbs
  // repeat counts for the same view while the grid scrolls. The footer
  // token sums ride the SAME query and the SAME scope (never the cursor
  // predicate) — one pass, and totals always agree with `total`.
  const joinedFilter =
    opts.filters &&
    Object.keys(opts.filters).some((c) => c === "key_name" || c === "provider_name");
  const cacheKey = `u:${userId}|k:${opts.keyId ?? ""}|f:${(opts.filters ? JSON.stringify(opts.filters) : "")}`;
  const now = Date.now();
  const cached = joinedFilter ? null : eventCountCache.get(cacheKey);
  let total: number;
  let sums: { in_tok: number; cache_tok: number; out_tok: number };
  if (cached && now - cached.at < EVENT_COUNT_TTL_MS) {
    total = cached.n;
    sums = { in_tok: cached.in_tok, cache_tok: cached.cache_tok, out_tok: cached.out_tok };
  } else {
    const agg = (
      joinedFilter
        ? db
            .prepare<{ n: number; in_tok: number; cache_tok: number; out_tok: number }, any[]>(
              `SELECT COUNT(*) AS n, COALESCE(SUM(e.in_tok),0) AS in_tok, COALESCE(SUM(e.cache_tok),0) AS cache_tok, COALESCE(SUM(e.out_tok),0) AS out_tok
               FROM usage_events e
               LEFT JOIN api_keys k ON k.id = e.key_id
               LEFT JOIN providers p ON p.id = e.provider_id
               WHERE ${scopeClauses.join(" AND ")}`,
            )
        : db
            .prepare<{ n: number; in_tok: number; cache_tok: number; out_tok: number }, any[]>(
              `SELECT COUNT(*) AS n, COALESCE(SUM(e.in_tok),0) AS in_tok, COALESCE(SUM(e.cache_tok),0) AS cache_tok, COALESCE(SUM(e.out_tok),0) AS out_tok
               FROM usage_events e WHERE ${scopeClauses.join(" AND ")}`,
            )
    ).get(...scopeParams)!;
    total = agg.n;
    sums = { in_tok: agg.in_tok, cache_tok: agg.cache_tok, out_tok: agg.out_tok };
    if (!joinedFilter) eventCountCache.set(cacheKey, { n: total, at: now, ...sums });
    if (eventCountCache.size > 512) eventCountCache.clear();
  }
  return { rows, total, totals: { ...sums, reqs: total } };
}

/** Recent-request grid counts + footer token sums, TTL-cached: `total` only
 *  changes when the usage flush lands, so repeat blocks within seconds reuse
 *  the numbers. */
const EVENT_COUNT_TTL_MS = 10_000;
const eventCountCache = new Map<
  string,
  { n: number; at: number; in_tok: number; cache_tok: number; out_tok: number }
>();
