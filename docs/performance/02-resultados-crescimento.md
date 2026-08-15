# 02 — Resultados: degradação com o crescimento (10 anos simulados)

> Estado **antes das otimizações** (código em `main` até o commit `472d9e4`).
> Cada linha é um checkpoint real: p95 em ms, medido por HTTP contra o gateway
> ao vivo. Dados brutos: [`results/crescimento.json`](results/crescimento.json).

## Volume por marco

| Dias | Eventos (usage_events) | audit_log | usage_daily | Tamanho do DB |
|---:|---:|---:|---:|---:|
| 30 | 30.620 | 7.523 | 155 | 8 MB |
| 180 | 181.010 | 45.023 | 905 | 49 MB |
| 365 | 366.270 | 91.273 | 1.830 | 101 MB |
| 730 | 731.530 | 182.523 | 3.655 | 202 MB |
| 1.825 (5 anos) | 1.826.920 | 456.273 | 9.130 | 503 MB |
| 3.650 (10 anos) | 3.652.180 | 912.523 | 18.255 | **1.013 MB** |

## Tabela de crescimento — p95 (ms)

| Endpoint | 30 d | 180 d | 365 d | 730 d | 5 anos | 10 anos | Inclinação |
|---|---:|---:|---:|---:|---:|---:|---:|
| **proxy overhead p50** | 0,3 | 1,8 | 1,9 | 1,9 | 0,9 | 0,1 | ~0 (1,3 ms/ano) |
| **proxy overhead p95** | −0,4 | 3,6 | 4,8 | 4,1 | 8,3 | 11,4 | ~0 |
| me | 7,6 | 1,9 | 3,2 | 2,9 | 0,9 | 2,3 | plano |
| keys.list | 2,6 | 2,8 | 2,6 | 2,0 | 2,8 | 2,5 | plano |
| usage.summary | 2,3 | 3,6 | 4,9 | 3,4 | 4,7 | 6,2 | +0,4 ms/ano |
| usage.daily.14d | 2,8 | 2,0 | 2,6 | 2,8 | 0,9 | 2,8 | plano |
| usage.daily.all | 2,6 | 4,7 | 4,7 | 5,8 | 8,2 | 19,8 | +1,5 ms/ano |
| usage.hourly.24h | 3,2 | 4,0 | 4,7 | 2,3 | 4,0 | 1,8 | plano |
| usage.events.p1 | 2,8 | 11,5 | 16,0 | 25,0 | 45,1 | 71,1 | +7,3 ms/ano |
| usage.events.deep (off 10k) | 4,2 | 9,6 | 16,3 | 24,7 | 46,9 | 69,2 | +7,2 ms/ano |
| usage.bymodel.14d | 8,0 | 7,2 | 7,9 | 6,9 | 7,0 | 8,4 | plano |
| **usage.bymodel.all** | 10,3 | 53,6 | 96,7 | 149,1 | 361,3 | **693,5** | **+67,9 ms/ano** |
| **admin.stats.24h** | 16,0 | 42,2 | 62,8 | 85,7 | 183,6 | **320,2** | **+31,1 ms/ano** |
| admin.stats.14d | 28,4 | 34,5 | 32,6 | 35,9 | 35,7 | 42,8 | ~plano |
| **admin.stats.all** | 46,9 | 201,0 | 341,8 | 661,6 | 1.659,5 | **3.344,5** | **+332,2 ms/ano** |
| admin.audit.p1 | 1,7 | 0,7 | 6,8 | 10,8 | 18,6 | 35,2 | +3,3 ms/ano |
| admin.audit.deep (off 5k) | 10,1 | 6,0 | 12,7 | 14,1 | 23,9 | 39,1 | +3,6 ms/ano |
| admin.users | 3,3 | 2,3 | 3,2 | 2,4 | 2,9 | 2,2 | plano |
| admin.keys | 2,4 | 2,9 | 3,4 | 3,4 | 3,1 | 1,9 | plano |
| **static.index** | 1,1 | 2,4 | 2,9 | 1,8 | 0,4 | 0,4 | plano |
| **static.bundle** | 1,5 | 2,1 | 1,7 | 2,0 | 2,3 | 3,1 | plano |

## Respostas diretas à pergunta "quando o usuário percebe lag?"

### 🟢 Proxy LLM (o chat com a AI): **nunca**

Overhead do gateway **plano em ~1–2 ms p50 / < 12 ms p95** em 10 anos
(3,65M eventos). Regressão linear: 300 ms de overhead só em ~**225 anos**.
O caminho quente do proxy não lê `usage_events`: auth é PK lookup por hash,
budgets são `SUM` em `usage_daily` por chave (3.650 linhas em 10 anos) com
cache de 2 s, e a contabilização é buffered (flush em lote). A latência
percebida pelo usuário da AI continua sendo a do provedor (segundos) —
o gateway nunca entra na equação.

### 🟢 Frontend (SPA estática): **nunca**

Entrega de `index.html`/bundle plana em < 4 ms p95 em qualquer volume.
O "peso" do frontend vem das APIs acima, não da entrega.

### 🟡 Dashboard do usuário: primeiro lag em **~5 anos**

`by-model?days=all` (GROUP BY sobre todos os eventos do usuário) cruza 300 ms
p95 em ≈ **5 anos** (medido: 361 ms) e chegaria a 1 s em ~15 anos. Listagem de
eventos cruza 300 ms só em ~40 anos. O resto fica abaixo de 20 ms por décadas.

### 🔴 Dashboard do admin: primeiro lag em **~1 ano** — o gargalo

`admin/stats?days=all` (GROUP BY global sobre **todos os eventos**):
- **322 dias ≈ 300 ms** (regressão; medido 342 ms aos 365 dias) — perceptível
- **~4–5 anos ≈ 1 s** (medido 901 ms aos 1000 dias; 1.660 ms aos 5 anos)
- **~10 anos ≈ 3,3 s** — inaceitável

`admin/stats?hours=24` também degradava linearmente (320 ms aos 10 anos) por
um **erro do query planner** sem estatísticas: full index scan de 3,65M linhas
para uma janela de 24 h (a query certa levaria < 1 ms).

## Qualidade estatística

- 17 checkpoints, amostras adaptativas (20 repetições por endpoint; 3–8 nos
  lentos); proxy medido com 100+30 requests por checkpoint + baseline direto.
- R² das regressões lineares dos endpoints que degradam: `stats.all` 0,999,
  `bymodel.all` 0,998, `stats.24h` 0,992, `events.*` 0,94–0,96 — crescimento
  claramente linear com o volume, não ruído.
- Endpoints planos têm R² ≈ 0 — sem tendência.

➡️ Correções empíricas desses três pontos: [`03-otimizacoes.md`](03-otimizacoes.md).
