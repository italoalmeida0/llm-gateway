# Scale audit — 20 intensive users × 500 reqs/day (1y & 5y)

Empirical audit of the gateway under the exact production scenario:

- 20 users, each: 500 proxied LLM requests/day, 10M input / 100M cached / 500K output tokens per day, 50 audit rows per day.
- Platform totals per day: 10,000 `usage_events`, 1,000 `audit_log` rows.
- Datasets were seeded with `scripts/load_test.ts` (real gateway boot for schema, same per-request token/model/status distribution as the perf backfill, rollup totals identical to what the proxy flush maintains), then every dashboard query and the flush write path were timed in two DB states: the schema as shipped before migration 013 ("today") and with 013 + the code fixes ("fixed").

```
bun scripts/load_test.ts /tmp/gw-audit-1y 365 --live     # ~5 min (4 min seed)
bun scripts/load_test.ts /tmp/gw-audit-5y 1825 --live    # ~38 min (32 min seed)
```

## Task 1 — Seeded volume and time-to-lag

| table | 1 year | 5 years |
|---|---|---|
| usage_events | 3,650,210 | 18,250,000 |
| usage_daily | 7,301 | 36,501 |
| usage_model_daily | 21,903 | 109,503 |
| usage_model_provider_daily | 21,903 | 109,503 |
| audit_log | 365,005 | 1,825,000 |
| api_keys / users | 20 / 21 | 20 / 21 |
| gateway.db | 930 MB | ~4.9 GB |

### When does >500ms arrive? (measured at both checkpoints, linear fit)

| surface / query | 1y | 5y | slope | crosses 500ms |
|---|---|---|---|---|
| Admin audit log, deep OFFSET page | 132ms | 664ms | ~133ms/yr | **≈ year 3.8 (first breach)** |
| User events grid, COUNT per block (joined) | 77ms | 404ms | ~82ms/yr | ≈ year 5.8 — paid on *every* page incl. the first |
| User events grid, sort by in_tok/latency | 77ms | 421ms | ~86ms/yr | ≈ year 5.9 |
| User events grid, deep OFFSET page | 70ms | 368ms | ~75ms/yr | ≈ year 6.4 |
| User events grid, in_tok range filter | 57ms | 312ms | ~64ms/yr | ≈ year 7.3 |
| Admin dashboard (all rollup-backed) | 23ms | 131ms | ~27ms/yr | > 15 years |
| Gateway proxy path (non-stream, 8 conc.) | +0.8ms | +1.5ms | ~flat | never |
| Proxy flush (100 events / 1 tx) | 8–11ms | 10–16ms | ~flat | never |

Within the **first year nothing crosses 500ms** (worst measured: 132ms audit deep page). The first breach is the admin audit log's deep-offset page at ≈ 3.8 years; between year 5 and 6 the events grid joins it (per-block COUNT, sorts, deep pages). The admin dashboard and the gateway hot path never cross at this load.

## Task 2 — the three bottleneck questions, answered empirically

**1. "Will a specific `SELECT SUM(tokens)` lock SQLite or take seconds after 6 months?"**
No. Every budget/spend read hits the `usage_daily` rollup (7.3K rows/year, PK-indexed, cached 2s — `getKeySpend`). Dashboard SUMs read `usage_daily` / `usage_model_daily` / `usage_model_provider_daily` (migrations 006/011): usage summary measured 1.4ms (1y) / 5.4ms (5y) over HTTP. There are no table locks: WAL mode, one writer (the buffered flush, ≤1 tx/s), `busy_timeout=5000`.
The queries that *did* degrade were never SUMs — they were (a) the per-block `COUNT(*)` whose `LEFT JOIN` resolved api_keys/providers for every row of a user's history (77ms → 404ms), (b) deep `OFFSET` walks (70ms → 368ms), (c) grid sorts on token columns (77ms → 421ms). All measured, all fixed below.

**2. "Will the SolidJS frontend freeze rendering a massive array of logs?"**
No. Every usage/audit/admin grid is AG Grid's **infinite row model** with server-side sort/filter (`web/src/aggrid.tsx`): blocks of 100 rows, ≤800 rows cached client-side, 2 concurrent block requests. Charts render ≤365 pre-aggregated points. No page ever holds the full log — the largest client-side arrays are the 800-row grid cache and the daily series.

**3. "Will Bun's event loop block writing audit logs synchronously?"**
No. `audit()` is a synchronous INSERT but the scenario generates only 1,000 rows/day (~0.07/s). The usage path is buffered: `recordUsage` pushes to an in-memory buffer; `flushUsage` writes ≤100 events × 4 statements in ONE transaction (measured: 8–11ms per 100 events at 3.65M rows, 10–16ms at 18.25M — flat with history size). The proxy's per-request tail flushes at most once per 5s (`usageFlushDue`); measured proxy overhead at 1,002 rps: **+0.8ms** p50 over direct-to-upstream.

## Task 3 — fixes and proof

### Fixed code

1. **Migration `013_events_audit_keyset`** (`server/db.ts`):
   - `idx_usage_user_ts_id (user_id, ts, id)` — keyset pages + `(ts DESC, id DESC)` ordering without a temp sort
   - `idx_usage_user_in_tok_id (user_id, in_tok, id)` — grid sorts on input tokens (408ms → 0.14ms at 5y)
   - `idx_audit_ts_id (ts, id)`, `idx_audit_action_ts (action, ts, id)` — audit pagination + action filters
   - A `(user_id, latency_ms, id)` variant was measured and **rejected**: an unselective `latency_ms >= X` filter (matches ~56% of the seeded distribution) flips the planner onto that index and temp-sorts half the user slice — 2,339ms at 18.25M events vs 0.25ms on the ts scan.
2. **Keyset cursor pagination** (`server/usage.ts userEvents`, `server/routes/admin.ts` audit branch): `?cursor=<ts>:<id>` — O(page) deep navigation. The predicate is `(ts <= X) AND NOT (ts = X AND id >= Y)`; the textbook OR form (`ts < X OR (ts = X AND id < Y)`) collapses on near-now cursors — SQLite's MULTI-INDEX OR temp-sorts the whole slice (measured 200–300ms at 1y). Backward compatible: OFFSET still works; cursors only apply to the default `(ts DESC, id DESC)` ordering.
3. **COUNT de-join + TTL cache** (`server/usage.ts`): the events-grid total no longer LEFT-JOINs api_keys/providers per history row (measured 77ms@1y / 404ms@5y per block); it counts the bare table and is cached 10s per (user, key, filter) view, invalidated on every flush. Same de-join for the audit grid via `gridPage(countFrom=…)` (`server/gridql.ts`) — only `actor_email`/`key_name` filters keep the join.
4. **Web** (`web/src/pages/Usage.tsx`, `web/src/pages/admin/Audit.tsx`): the events and audit datasources send the previous block's cursor for forward scrolling; jumps and filter/sort changes fall back to OFFSET.

### Proof — SQL probes (median of 7; full tables in the raw reports)

| probe | 1y today | 1y fixed | 5y today | 5y fixed |
|---|---|---|---|---|
| events deep page (OFFSET → keyset) | 68.9ms | **0.48ms** | 367.8ms | **0.40ms** |
| events COUNT per block (joined → de-joined+cached) | 77.0ms | **7.2ms** (≈0 cached) | 403.7ms | **36.4ms** (≈0 cached) |
| events sort by in_tok DESC | 76.9ms | **0.13ms** | 408.4ms | **0.14ms** |
| events filter in_tok >= 100000 | 57.2ms | **0.01ms** | 311.9ms | **0.01ms** |
| audit deep page (OFFSET → keyset) | 132.1ms | **0.08ms** | 664.3ms | **0.13ms** |
| audit filter action='provider.tested' | 0.20ms | **0.06ms** | 0.19ms | **0.07ms** |
| admin stats / breakdowns (rollups) | 1.9–14.9ms | same | 10.9–72.4ms | same |
| **write path: flush 100 events (1 tx)** | 10.6ms | 8.4ms | 11.6ms | 15.3ms |
| **write path: flush 1000 events (1 tx)** | 22.3ms | 24.0ms | 32.1ms | 22.9ms |

The write path is unchanged within noise — the four new indexes do not hurt the gateway's buffered flush at this event rate.

### Proof — live HTTP on the seeded DBs (real gateway + fake upstream, p50)

| endpoint | 1y pre-fix | 1y fixed | 5y fixed |
|---|---|---|---|
| GET /api/usage/events?limit=100 | 83ms | **2.1ms** | **2.1ms** |
| GET /api/usage/events (cursor p2) | 350–400ms | **1.0ms** | **1.3ms** |
| GET /api/usage/events&offset=100000 | 157ms | 56ms | 85ms |
| GET /api/usage/summary | 1.2ms | 1.4ms | 5.4ms |
| GET /api/usage/daily?days=all | 1.4ms | 2.3ms | 9.1ms |
| GET /api/usage/breakdown?days=all | 4.3ms | 5.3ms | 14.1ms |
| GET /api/admin/stats?days=all | 21ms | 23ms | 131ms |
| GET /api/admin/audit?limit=50 | 51ms | **8.1ms** | **24.5ms** |
| GET /api/admin/usage-breakdown?days=all | 51ms | 53ms | 284ms |
| proxied chat completion (8 conc.) | 972 rps | 1002 rps | 889 rps |

(The 1y "pre-fix" column was measured on the same DB before the fixes; offset pages remain linear by design — cursors are the deep-navigation path.)

### EXPLAIN QUERY PLAN — deep events page

OFFSET (pre-013):
```
SEARCH e USING INDEX idx_usage_user_ts (user_id=?)   -- walks O(offset) entries
```
Keyset (013):
```
SEARCH e USING INDEX idx_usage_user_ts_id (user_id=? AND ts<=?)   -- seeks to the cursor
```

## Residual observations (no action needed at this load)

- `events sort by latency_ms` stays unindexed (421ms @ 5y, crosses ~5.9y) — indexing it regresses unselective latency filters (see above); acceptable, revisit if latency sorting becomes a primary workflow.
- `admin.usage-breakdown?days=all` (legacy non-grid endpoint) is 284ms @ 5y — the grid-backed `/users`+`/models` endpoints the dashboard uses are paged and cheap.
- The events/audit grids run one COUNT per block; with the 10s TTL cache this is amortized to ~1 count per view per 10s.

## Raw artifacts

- `load-test-1y.md`, `load-test-5y.md` (this directory) — full probe matrices + EXPLAIN + live tables as emitted by the runner.
