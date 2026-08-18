# load_test — scale audit

Scenario: 20 users × 500 reqs/day × 365 days.
Daily tokens per user: 10M in / 100M cache / 500k out; 50 audit rows/user/day.

## Seeded volume

- usage_events: 3,651,470
- usage_daily: 7,307
- usage_model_daily: 21,921
- usage_model_provider_daily: 21,921
- audit_log: 365,037
- gateway.db: 930.0 MB

## SQL probes — median of 7 runs, ms

| probe | **today** (OFFSET, pre-013) | OFFSET, post-013 | keyset, pre-013 | **keyset, post-013** |
|---|---|---|---|---|
| usage.summary (3 SELECTs) | 0.09 | 0.09 | — | — |
| usage.daily?days=all | 0.28 | 0.27 | — | — |
| usage.daily?hours=24 (raw events) | 0.32 | 0.34 | — | — |
| usage/by-model?days=all | 0.75 | 0.72 | — | — |
| events.page1 (limit 100) | 0.13 | 0.14 | — | — |
| events.deep.OFFSET (183,659) | 69.48 | 68.60 | 0.18 | 0.17 |
| events.count (per block) | 7.75 | 7.09 | — | — |
| events.count+joins (pre-fix SQL) | 78.58 | 76.73 | — | — |
| events.sort.latency_ms DESC | 81.27 | 76.05 | — | — |
| events.sort.in_tok DESC | 79.94 | 0.13 | — | — |
| events.filter.latency_ms>=5000 | 0.42 | 0.42 | — | — |
| events.filter.key_name LIKE %main% | 0.14 | 0.14 | — | — |
| events.filter.in_tok>=100000 | 59.66 | 56.35 | — | — |
| admin.stats.series.all | 1.99 | 1.89 | — | — |
| admin.stats.perUser.all | 2.25 | 2.18 | — | — |
| admin.stats.perModel.all | 8.25 | 7.65 | — | — |
| admin.stats.totals | 0.61 | 0.62 | — | — |
| admin.usage-breakdown (users, limit 2000) | 14.16 | 14.02 | — | — |
| audit.page1 (limit 50) | 0.06 | 0.07 | — | — |
| audit.deep.OFFSET (364,983) | 130.14 | 129.46 | 0.12 | 0.06 |
| audit.count | 2.76 | 2.54 | — | — |
| audit.filter.action='provider.tested' | 0.22 | 0.06 | — | — |
| audit.filter.action~%key% | 0.10 | 0.07 | — | — |
| flush.100 events (1 tx) | 7.25 | 10.53 | — | — |
| flush.1000 events (1 tx) | 20.09 | 25.60 | — | — |

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


## Live HTTP (real gateway on seeded DB)

| endpoint | p50 ms | p95 ms |
|---|---|---|
| me (control) | 0.7951519999987795 | 2.4873330000045826 |
| usage.summary | 1.2298200000004726 | 3.665293999998539 |
| usage.daily?days=all | 1.2916819999954896 | 3.7246239999949466 |
| usage.daily?hours=24 | 1.7161709999927552 | 4.411914999996952 |
| usage.events?limit=100 (p1) | 1.510720999998739 | 3.4969639999981155 |
| usage.events?limit=100&offset=10000 | 6.281446000000869 | 16.42255699999805 |
| usage.events?limit=100&offset=100000 | 52.19208300000173 | 74.77695699999458 |
| usage.breakdown?days=all | 5.164205000000948 | 8.446318000002066 |
| usage/by-model?days=all | 3.203613999998197 | 7.117747000003874 |
| admin.stats?days=all | 31.054000999996788 | 44.14778500000102 |
| admin.stats?hours=24 | 9.31783900001028 | 13.880504999993718 |
| admin.audit?limit=50 (p1) | 7.517686999999569 | 11.492761000001337 |
| admin.audit?limit=50&offset=5000 | 13.258593999998993 | 17.224658000006457 |
| admin.usage-breakdown?days=all | 61.387132000003476 | 71.69326299999375 |
| usage.events?cursor=… (p2) | 1.9383929999894463 | 3.3823929999925895 |
| proxy.nonstream 885 rps (+1.9ms over direct) | 8 | 12 |
| proxy.stream 42 rps | 118 | 123 |