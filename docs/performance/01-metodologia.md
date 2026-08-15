# 01 — Metodologia do teste de desempenho

> Simulação **real**, com processos reais, HTTP real e registros reais no
> SQLite — nada teórico: todo número desta pasta foi medido.

## Cenário simulado (conforme pedido)

| Parâmetro | Valor |
|---|---|
| Usuários ativos | 5 (+ 1 admin) |
| Providers | 1 (fake upstream local, latência fixa de 5 ms) |
| Requests por usuário/dia | 200 (1.000/dia no total) |
| Tokens por usuário/dia | 1M `in` + 4M `cache` + 200k `out` |
| Distribuição por modelo | `claude-sonnet-4-5` 50% · `gpt-5-mini` 30% · `gpt-4o` 20% |
| Audit logs | ~50 por usuário/dia (250/dia) |
| Mix por request | 60% streaming; 94% status 200, resto 400/429/500/502; latências 0,3–24 s |

Crescimento projetado: **1.000 eventos/dia · 250 audit/dia · 5 linhas/dia em
`usage_daily`**. Um ano = 365k eventos + 91k audit rows.

## Como a simulação funciona

Ferramentas (commit `472d9e4`):

- `bun run perf:sim` — `scripts/perf-sim.ts`: sobe **gateway real +
  fake upstream reais** (child processes) num `DATA_DIR` temporário, provisiona
  provider/usuários/chaves **via API REST de verdade** e vai envelhecendo o
  banco checkpoint a checkpoint até 10 anos (3.650 dias = 3,65M eventos +
  912k audit rows ≈ 1 GB de DB).
- `bun run perf:tuning` — `scripts/perf-tuning.ts`: `build` (reconstrói o
  dataset de 10 anos num diretório persistente), `measure` (mede tudo de novo
  via HTTP), `sql` (experiências de tuning direto no arquivo SQLite).
- `scripts/perf-common.ts` — geração determinística de eventos (seed fixa,
  reproduzível), com os **mesmos INSERT/UPSERT que o gateway usa** (`usage_events`,
  `usage_daily`, `audit_log`).

A história "antiga" é gravada em lote direto no SQLite (mesmo formato e mesmos
índices que o tráfego real produz — mesma técnica do `scripts/seed-usage.ts`),
enquanto **toda medição é HTTP real**: requests de proxy passam pelo pipeline
completo (auth → budgets → rate limits → upstream → accounting) e os endpoints
de dashboard são chamados com JWTs reais de usuário/admin.

Checkpoints: 0, 1, 7, 14, 30, 60, 90, 180, 270, 365, 545, 730, 1000, 1460,
1825, 2555 e 3650 dias.

## O que é medido em cada checkpoint

**Proxy LLM** (o caminho do "usuário da AI"):
- 100 requests non-stream + 30 stream + 60 direto ao upstream (baseline),
  rodando pelas 5 chaves × 3 modelos; concorrência 8/5. Métricas: p50/p95 e
  **overhead do gateway** (proxy − direto).

**Dashboard API** (o que a SPA chama, amostras adaptativas de 3–20 por endpoint):
- usuário: `me`, `keys`, `usage/summary`, `usage/daily?days=14|all`,
  `usage/daily?hours=24`, `usage/events` (1ª página e página funda, offset 10k),
  `usage/by-model?days=14|all`
- admin: `admin/stats?hours=24|days=14|days=all`, `admin/audit` (p. 1 e funda,
  offset 5k), `admin/users`, `admin/keys`

**Frontend**: entrega do `index.html` e do bundle JS (estático).

## Limites de percepção usados

| Limiar | Significado |
|---|---|
| > 300 ms p95 | usuário percebe lentidão ao clicar |
| > 1.000 ms p95 | irritante ("está travado?") |
| > 3.000 ms p95 | inaceitável |
| proxy overhead > 100 ms p95 | começaria a pesar no TTFT de chats (a latência real do provedor — centenas de ms a segundos — domina a experiência; overhead do gateway só é relevante se crescer muito) |

## Ambiente

- Bun 1.3.0, Linux x86_64, SQLite WAL (`bun:sqlite`)
- fake upstream com latência fixa de 5 ms (remove a variância do "provedor";
  o que medimos é **custo do gateway** — auth, budgets, queries, flush)
- Resultados brutos: [`results/crescimento.json`](results/crescimento.json) e
  [`results/tuning-10y.json`](results/tuning-10y.json)

## Como reproduzir

```bash
# simulação completa (~10 min, 10 anos; PERF_MAX_DAYS=365 limita a 1 ano)
bun run perf:sim

# tuning empírico no dataset de 10 anos
bun run perf:tuning build /tmp/gw-tune 3650
bun run perf:tuning measure /tmp/gw-tune baseline
bun run perf:tuning sql /tmp/gw-tune
```
