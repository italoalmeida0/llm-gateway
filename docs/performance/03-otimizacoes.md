# 03 — Otimizações testadas empiricamente

> Todas as alternativas foram **medidas de verdade** sobre o dataset de 10 anos
> (3.652.180 eventos · 912.523 audit rows · 1 GB de SQLite), no nível SQL e
> depois no nível HTTP, antes/depois. Brutos: [`results/tuning-10y.json`](results/tuning-10y.json).

## Experimento A — timings SQL na base de 10 anos (antes de qualquer mudança)

| Query (endpoint que a usa) | p50 |
|---|---:|
| perModel global 24h (`admin/stats?hours=24`) | 1,5 ms |
| **perModel global tudo (`admin/stats?days=all`)** | **3.330 ms** |
| **perUser 24h (`admin/stats?hours=24`)** | **287 ms** |
| **by-model usuário tudo (`usage/by-model?days=all`)** | **668 ms** |
| COUNT eventos do usuário (`usage/events`) | 50 ms |
| página funda de eventos (offset 10k) | 0,5 ms |
| COUNT audit (`admin/audit`) | 15 ms |
| página 1 do audit (join users) | 0,1 ms |

## Experimento B — `ANALYZE` (estatísticas do planner)

Custo único: **1,27 s** num DB de 1 GB.

| Query | antes | depois |
|---|---:|---:|
| **perUser 24h** | 287 ms | **0,5 ms** (−99,8%, 574×) |
| perModel global 24h | 1,5 ms | 0,6 ms |
| demais | — | sem mudança |

Causa raiz empírica: sem `sqlite_stat1`, o planner preferia varrer o índice
`(user_id, ts)` inteiro (3,65M entradas) para satisfazer o `GROUP BY user_id`,
ignorando que o predicado `ts >= agora-24h` casa ~130 linhas. Com estatísticas,
ele usa o range scan de `idx_usage_ts`. **Adotado**: `PRAGMA optimize` ao final
do `migrate()` (incremental — boot seguinte custa 0).

## Experimento C — índices de cobertura (covering)

Custo de disco medido: **+411 MB (+40%)** num DB de 1 GB.

| Query | antes | depois |
|---|---:|---:|
| by-model usuário tudo | 668 ms | 464 ms (−31%) |
| perModel global tudo | 3.310 ms | 2.283 ms (−31%) |

Os índices tornam a varredura completa *index-only*, mas a query continua
**O(n)** — aos 10 anos ainda haveria 2,3 s no stats global e ~7 s aos 30 anos.
**Rejeitado**: benefício parcial, custo permanente de disco e de escrita.

## Experimento D — tabela de rollup `usage_model_daily` ✅ adotado

Agregado `PRIMARY KEY (key_id, date, proto, model)` alimentado pelo mesmo
flush de `usage_daily` (migração `006`). Backfill único a partir dos eventos
existentes: **3,7 s** num DB de 1 GB; 54.765 linhas resultantes.

| Query | antes | com rollup | ganho |
|---|---:|---:|---:|
| perModel global `days=all` | 3.330 ms | **30 ms** | ~110× |
| perModel global `days=14` | 1,5 ms | 0,1 ms | — |
| by-model usuário `days=all` | 668 ms | **4 ms** | ~165× |
| by-model usuário `days=14` | ~5 ms | ~0 ms | — |

**Paridade verificada**: `SUM(in/cache/out/reqs)` idênticos entre o rollup e
`usage_events` (match exato sobre 3.650.210 eventos).

**Custo de escrita medido**: 10.000 eventos = 73,4 ms no formato atual (2
escritas/evento) → 96,0 ms com o rollup (3 escritas/evento) — **+0,0023 ms por
evento**, amortizado num flush assíncrono por lote.

## Experimento E — prova final HTTP (antes → depois, mesmo dataset copiado)

p95 (ms). Boot único com migração 006 + primeiro ANALYZE: **6,3 s**;
boot seguinte (steady state): **0,55 s** (normal).

| Endpoint | antes | depois | ganho |
|---|---:|---:|---:|
| **admin.stats?days=all** | 3.341,8 | **86,4** | **39×** |
| **usage/by-model?days=all** | 712,2 | **33,2** | **21×** |
| **admin.stats?hours=24** | 320,4 | **13,9** | **23×** |
| admin.stats?days=14 | 38,1 | 9,8 | 4× |
| usage/by-model?days=14 | 7,1 | 1,0 | 7× |
| proxy overhead | 10,4 | 11,3 | plano ✓ |
| usage.events.p1 | 68,7 | 69,3 | sem mudança (era ok) |
| admin.audit.p1 | 38,8 | 40,7 | sem mudança (era ok) |

`stats?hours=24` e `by-model?days=all` mantêm janelas por hora em
`usage_events` (seletivas, < 1 ms com estatísticas); apenas as janelas
por dia/total passam a ler o rollup.

## Experimento F — bench do hot path (A/B com `git stash`)

| | código antigo | com rollup |
|---|---:|---:|
| throughput do proxy | 4.606 rps | **4.824 rps** |
| overhead p50 | 3,86 ms | 2,76 ms |
| streaming (170 rps) | 115 ms p50 | 115 ms p50 |

Diferença dentro do ruído da máquina — **zero regressão de escrita** no caminho
quente. Suíte de testes: **71/71 passando**.

## Ficou fora (medido, não compensa)

| Ideia | Por que não |
|---|---|
| Índices de cobertura | +40% de disco por −31%; continua O(n). O rollup resolve a raiz |
| Tabela de contadores para `COUNT(*) de eventos` | 69 ms p95 aos 10 anos (300 ms só em ~40 anos) — complexidade sem urgência |
| Otimizar `audit COUNT(*)` | 15 ms aos 912k rows (~40 ms p95 HTTP aos 10 anos) — índice já resolve a paginação |
