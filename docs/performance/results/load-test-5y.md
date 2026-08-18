# load_test — scale audit

Scenario: 20 users × 500 reqs/day × 1825 days.
Daily tokens per user: 10M in / 100M cache / 500k out; 50 audit rows/user/day.

## Seeded volume

- usage_events: 18,250,420
- usage_daily: 36,502
- usage_model_daily: 109,506
- usage_model_provider_daily: 109,506
- audit_log: 1,825,009
- gateway.db: 4756.7 MB

## SQL probes — median of 7 runs, ms

| probe | **today** (OFFSET, pre-013) | OFFSET, post-013 | keyset, pre-013 | **keyset, post-013** |
|---|---|---|---|---|
| usage.summary (3 SELECTs) | 1.63 | 1.59 | — | — |
| usage.daily?days=all | 2.83 | 2.57 | — | — |
| usage.daily?hours=24 (raw events) | 0.23 | 0.14 | — | — |
| usage/by-model?days=all | 3.74 | 3.77 | — | — |
| events.page1 (limit 100) | 0.13 | 0.14 | — | — |
| events.deep.OFFSET (912,819) | 367.77 | 381.14 | 0.17 | 0.40 |
| events.count (per block) | 36.44 | 38.27 | — | — |
| events.count+joins (pre-fix SQL) | 403.71 | 409.49 | — | — |
| events.sort.latency_ms DESC | 426.30 | 423.01 | — | — |
| events.sort.in_tok DESC | 408.35 | 0.14 | — | — |
| events.filter.latency_ms>=5000 | 0.25 | 0.25 | — | — |
| events.filter.key_name LIKE %main% | 0.14 | 0.15 | — | — |
| events.filter.in_tok>=100000 | 311.95 | 0.01 | — | — |
| admin.stats.series.all | 10.74 | 10.98 | — | — |
| admin.stats.perUser.all | 33.77 | 33.99 | — | — |
| admin.stats.perModel.all | 58.55 | 59.38 | — | — |
| admin.stats.totals | 3.83 | 4.12 | — | — |
| admin.usage-breakdown (users, limit 2000) | 73.41 | 73.24 | — | — |
| audit.page1 (limit 50) | 0.06 | 0.07 | — | — |
| audit.deep.OFFSET (1,824,958) | 664.33 | 670.65 | 0.08 | 0.13 |
| audit.count | 14.85 | 15.14 | — | — |
| audit.filter.action='provider.tested' | 0.19 | 0.07 | — | — |
| audit.filter.action~%key% | 0.08 | 0.09 | — | — |
| flush.100 events (1 tx) | 11.64 | 15.25 | — | — |
| flush.1000 events (1 tx) | 32.09 | 22.89 | — | — |

## EXPLAIN QUERY PLAN (deep events page)

### OFFSET deep page (pre-013 index set)
```
SELECT e.id FROM usage_events e LEFT JOIN api_keys k ON k.id = e.key_id WHERE e.user_id = ? ORDER BY e.ts DESC, e.id DESC LIMIT 100 OFFSET 90000
SEARCH e USING INDEX idx_usage_user_ts (user_id=?)
```

### Keyset deep page (migration-013 index set)
```
SELECT e.id FROM usage_events e LEFT JOIN api_keys k ON k.id = e.key_id WHERE e.user_id = ? AND (e.ts <= ?) AND NOT (e.ts = ? AND e.id >= ?) ORDER BY e.ts DESC, e.id DESC LIMIT 100
SEARCH e USING INDEX idx_usage_user_ts (user_id=? AND ts<?)
```


## Live HTTP (real gateway on the seeded 5y DB — final fixed state)

Measured after the last probe run with a focused endpoint pass (same method as
the runner's --live stage):

| endpoint | p50 ms | p95 ms |
|---|---|---|
| me (control) | 0.4 | 1.5 |
| usage.summary | 5.4 | 7.9 |
| usage.daily?days=all | 9.1 | 12.7 |
| usage.events p1 | 2.1 | 6.0 |
| usage.events offset=10000 | 12.1 | 23.8 |
| usage.events offset=100000 | 85.2 | 104.7 |
| usage.breakdown?days=all | 14.1 | 28.5 |
| admin.stats?days=all | 131.1 | 151.9 |
| admin.stats?hours=24 | 10.9 | 21.3 |
| admin.audit p1 | 24.5 | 38.1 |
| admin.audit offset=5000 | 21.5 | 39.7 |
| admin.audit cursor p2 | 18.8 | 36.4 |
| admin.usage-breakdown?days=all | 283.5 | 345.0 |
| usage.events cursor p2 | 1.3 | 4.3 |
