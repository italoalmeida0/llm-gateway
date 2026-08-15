# Performance — estudo empírico completo

Cenário: **5 usuários pesados**, 1 provider, 200 req/dia cada
(1M in + 4M cache + 200k out tokens/usuário/dia em 3 modelos),
~50 audit logs/usuário/dia. Simulado **de verdade** por até 10 anos:
processos reais, HTTP real, registros reais no SQLite (3,65M eventos,
912k audit rows, 1 GB de DB).

## Documentos

1. [`01-metodologia.md`](01-metodologia.md) — ambiente, cenário, ferramentas
   (`bun run perf:sim`, `bun run perf:tuning`), limites de percepção.
2. [`02-resultados-crescimento.md`](02-resultados-crescimento.md) — tabelas
   p95 por checkpoint (30 dias → 10 anos), regressões e cruzamentos de limiar.
3. [`03-otimizacoes.md`](03-otimizacoes.md) — alternativas de otimização
   medidas (ANALYZE, índices de cobertura, rollup) com antes/depois HTTP.
4. [`results/`](results/) — JSONs brutos de todas as medições.

## Conclusão executiva

| Superfície | Primeira lentidão perceptível (antes das otimizações) | Depois das otimizações |
|---|---|---|
| **Proxy LLM (chat da AI)** | **nunca** — overhead plano ~1–2 ms p50 / < 12 ms p95 em 10 anos; 300 ms só em ~225 anos | idem — e o hot path ficou 5% mais rápido no bench A/B (ruído, mas sem regressão) |
| **Frontend (SPA estática)** | **nunca** — entrega plana < 4 ms p95 em qualquer volume | idem |
| **Dashboard usuário** | `by-model?days=all` ~300 ms p95 em **≈ 5 anos** (resto: décadas) | pior endpoint: **33 ms p95 aos 10 anos** |
| **Dashboard admin** | `stats?days=all` ~300 ms em **≈ 1 ano** (342 ms medido), 1 s em ~4–5 anos, 3,3 s em 10 | **86 ms p95 aos 10 anos** |

### Por que o proxy nunca degrada (medido, não suposto)

O caminho quente não toca em `usage_events`: autenticação é lookup por PK
(hash SHA-256 da chave), budgets leem `usage_daily` por chave (3.650 linhas
em 10 anos) com cache de 2 s, contabilização é buffered em lote. A latência
que o usuário da AI percebe é a do provedor (segundos) — a do gateway
(~1,5 ms) é desprezível e **constante no tempo**.

### O que foi corrigido no código (commit `28e8b04`, migração `006`)

1. **`usage_model_daily`** — rollup por chave/dia/modelo alimentado pelo
   flush existente (+0,0023 ms/evento; bench A/B 4.824 vs 4.606 rps). As
   queries por modelo liam `GROUP BY` sobre milhões de eventos brutos;
   agora leem o rollup: **39×/21× mais rápidas** aos 10 anos.
2. **`PRAGMA optimize`** no boot — sem estatísticas, o planner fazia full
   scan de 3,65M linhas para agregados de 24 h (287 ms → 0,5 ms só com isso);
   boot único após a migração: 6,3 s (DB de 1 GB), depois normal (0,55 s).

### O que NÃO vale a pena (medido)

- Índices de cobertura: +40 % de disco por −31 % de tempo; continua O(n).
- Tabela de contadores para `COUNT(*)` de eventos/audit: 69 ms/40 ms p95 aos
  10 anos, limiar de 300 ms só em ~40 anos.

### Recomendações operacionais

- **Custo conhecido de upgrade**: o boot que aplica a migração 006 demora
  ~6 s por GB de histórico (uma única vez) — planeje o deploy.
- **Disco**: ~101 MB/ano neste cenário; 1 GB em 10 anos. Backup/VACUUM
  anuais são confortáveis.
- **Se o volume for 10× maior** (50 usuários pesados), multiplique os
  prazos do `02` por ~0,3–0,5 para os endpoints que eram O(n): sem o
  rollup, o stats global chegaria a 300 ms em ~4 meses — vale monitorar
  `admin.stats` como canário.
- Repetir `bun run perf:sim` após mudanças no schema mantém este estudo vivo.
