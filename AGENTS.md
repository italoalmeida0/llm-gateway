# AGENTS.md — llm-gateway

## What this is

A self-hosted LLM API gateway (Bun only). One upstream provider; many users with
their own gateway keys, budgets and dashboards. Think simplified self-hosted LiteLLM.

## Architecture (read this first)

- **One process** (`server/index.ts`) serves three surfaces:
  - `/v1/*` (+ directional aliases `/openai/v1/*`, `/anthropic/v1/*` that force
    the protocol from the path prefix) → LLM proxy (`server/proxy/index.ts`) —
    pass-through to the provider's `openai_base_url` or `anthropic_base_url`;
    auth via `gw_…` keys (SHA-256 hash lookup in `api_keys`). The upstream key
    is sent per capability as `Authorization: Bearer` or `x-api-key`,
    configurable per provider (`openai_auth_style` / `anthropic_auth_style`;
    defaults Bearer/x-api-key).
  - `/api/*` → dashboard REST API (`server/routes/*`), JWT HS256 access tokens +
    rotating opaque refresh tokens (`sessions` table, jti revocation).
  - `/*` → static SPA from `dist/` (`server/static.ts`, path-traversal safe).
- **DB**: `bun:sqlite` (`server/db.ts`), migrations via `PRAGMA user_version`,
  in `MIGRATIONS` — append-only, never edit applied ones.
- **Usage accounting** (`server/usage.ts`): buffered writes (flush 1s/100 events),
  `usage_daily` aggregates (plus `usage_model_daily` — per key/date/model rollup
  written by the same flush; the per-model dashboard queries read it, NOT raw
  `usage_events`), per-key spend cached 2s — enforcement is *eventually
  consistent* by design; total-exhaustion additionally flips `api_keys.status`
  optimistically in the proxy hot path. Tokens are tracked in THREE buckets,
  never one lump sum: `in_tok` (cache-free input), `cache_tok` (cached input,
  billed at cache rate upstream), `out_tok`. OpenAI's `prompt_tokens` includes
  the cached share — the proxy splits it via `prompt_tokens_details.cached_tokens`;
  Anthropic's `input_tokens` is already cache-free and its
  `cache_read/cache_creation_input_tokens` BOTH land in `cache_tok`.
  **Key budgets (`daily_limit`/`total_limit`) cap OUTPUT tokens only** — input
  and cache are visibility metrics, they never consume a key's budget; say
  "output" in every budget label/message.
  Scaling evidence: `docs/performance` (10y sim). `PRAGMA optimize` runs at the
  end of `migrate()` — without planner stats, hour-window aggregates on big
  `usage_events` degrade into full index scans.
- **Model registry & routing** (`server/models.ts`, migration `007_models`):
  `models` = public id → provider + `upstream_model` (aliases allowed), with
  rich metadata as validated JSON columns; `settings` KV holds
  `routing_mode`. Creating a provider auto-imports its `GET /models` per
  capability (8s timeout, tolerant 3-shape parser, `INSERT OR IGNORE` —
  best-effort, never blocks creation, never clobbers admin edits). Proxy reads
  a 5s `routerSnapshot()` cache (mode + all models + enabled providers with
  decrypted keys); admin mutations call `invalidateModelCache()`.
  - `passthrough` (default): model names forwarded untouched; `/v1/models`
    proxies upstream. Zero behavioral change for existing setups.
  - `router`: unknown/disabled model → 404; orphaned (provider deleted → FK
    `ON DELETE SET NULL`) or provider-unavailable → 503; body `model` is
    rewritten to `upstream_model` (only when different — byte-fidelity rule
    stands); usage is recorded under the PUBLIC id; `/v1/models` is generated
    from the registry in the rich format (never forwarded upstream).
  - Registry ids are global and per-proto: for a dual-surface provider the
    first capability sync wins the id (the other proto's duplicate is skipped)
    — register a separate public id manually for the second proto if needed.
- **Crypto** (`server/crypto.ts`): hand-rolled on WebCrypto — PBKDF2 (100k),
  TOTP (RFC 6238, anti-replay in `ratelimit.ts`), JWT HS256, AES-256-GCM.
  Do not add crypto libs.
- **Frontend** (`web/`, SolidJS + Tailwind v4): hand-rolled hash router and UI kit
  (`web/src/ui.tsx`). No React, no router/query/chart libs. Built via
  `build.ts` → `dist/` — uses `plugins/solid-plugin.ts` (Babel 7 + isTSX;
  **Babel 8 removed isTSX — keep versions pinned at ^7**).
- **Theming** (`web/style.tailwindcss.css`): two themes (white/dark) driven by
  `[data-theme]` on `<html>`. Components use semantic tokens only (`ink-*`,
  `accent-*` = monochrome primary, `brand-*` = red highlight, `card`/`elev`/
  `line`); values flip per theme — never hardcode hex colors in pages. Init
  script in `web/index.html` picks localStorage `llmgw-theme` else OS;
  `ThemeToggle`/`theme` helpers live in `ui.tsx` (watchSystemTheme keeps
  following the OS until the user picks once).
- **Animations**: `usal` (see `web/src/motion.ts` — config once, `once:true`
  + `forwards:true`; helpers `usal()`/`usalItems()`/`CountUp`). USAL observes
  DOM mutations, no manual restarts needed. **Never put `data-usal` on
  Modal/toasts** (retained transforms break `position: fixed`, same gotcha as
  fill-mode below). Icons are inline stroke SVGs in `ui.tsx` (`currentColor`)
  — do not reintroduce runtime icon CDNs.
- Static legal pages: `web/public/*.html` copied into `dist/`.

## Hard rules

- **Never log or serialize secrets**: upstream provider keys (AES-encrypted at rest),
  plaintext gateway keys (only hash stored; shown once at creation), TOTP secrets,
  GATEWAY_SECRET.
- Error messages on `/v1/*` use the protocol envelope (OpenAI `{"error":{…}}`,
  Anthropic `{"type":"error",…}`) — clients depend on it.
- Dashboard API envelope: `{success:true, …}` / `{success:false, error}`.
- Every admin/user mutation writes to `audit_log`.
- Rate limits and brute-force counters are in-memory (single process) — fine;
  budgets MUST stay SQLite-backed. Never reintroduce a summed "total tokens"
  number in the UI/API — always show in / cache / out separately. The 30/min
  `authPerMin` bucket covers ONLY
  credential endpoints (login/2fa/google) — refresh/logout/config must not
  consume it (dashboard traffic would lock users out).
- Key delete is soft (revoke) by default; `DELETE /api/keys/:id?hard=true`
  removes the row. Usage ledger rows survive either way.
- Session rows carry a `label` (device name) — copied across refresh rotation.
- Don't buffer whole streams: keep the SSE tee incremental (memory bounded by
  longest event line, not response size).
- Keep the dependency list minimal: runtime deps are `nodemailer` (SMTP),
  `qrcode` (TOTP QR) and `usal` (scroll/entrance animations, user-sanctioned).
  `@fontsource-variable/inter` is a bundled dev asset (no runtime CDN).
  Bun-native or hand-rolled beats a new dep.

## Commands

- `bun run dev` / `bun run dev:web` — backend :3000 / frontend dev :5700 (proxies /api,/v1)
- `bun run build` — build SPA into `dist/`
- `bun test` — must stay green (unit + black-box integration with fake upstream)
- `bun run bench` — perf harness; do not let non-stream overhead regress wildly
- `bun run perf:sim` — day-by-day growth sim (real gateway+upstream, HTTP
  measurements per checkpoint up to 10y; `PERF_MAX_DAYS=N` to shorten)
- `bun run perf:tuning` — `build|measure|sql <dir>` on a persistent big dataset
- `bun run fake-upstream` — fake provider for manual testing (:3399, key `sk-fake-secret`)
- `bun run seed` — mock usage data for the dev DB (`-- --days N`, `-- --keep`),
  seeds every existing key (replaces usage rows by default)

## Gotchas learned (don't re-learn)

- **Bun.serve `idleTimeout` applies to in-flight responses**: a paused SSE
  stream (model thinking, zero bytes) counts as idle and the socket dies
  mid-turn — clients then retry and re-run tool actions (duplicate file
  writes). Keep it above `LIMITS.proxyStreamIdleMs` (240 > 180s; Bun caps at
  255).
- `decryptSecret(enc, GATEWAY_SECRET)` takes TWO args — omitting the secret
  throws inside `routerSnapshot()`'s per-provider try/catch and silently
  empties the routing table (every routed request 503s, `/v1/models` lists
  nothing).
- Model ids can contain `/` (e.g. `hf:zai-org/GLM-5.2`): admin routes match
  `/api/admin/models/(.+)` on the RAW (still-encoded) path and then
  `decodeURIComponent` — the UI must `encodeURIComponent` ids, and the
  bulk-delete route must be matched BEFORE the `/:id` one.
- Proxy is byte-faithful pass-through: requests are forwarded untouched EXCEPT
  openai streams missing `stream_options.include_usage` (injected so usage
  accounting stays exact — decided per `route.upstreamPath`, never per
  `url.pathname`, or the prefixed aliases would silently skip it).
- SSE relay is pull-based (`ReadableStream.pull`): reading upstream only when
  the client socket drains keeps memory bounded and gives true pass-through
  pacing. The concurrency slot stays held until the stream really ends —
  the outer `finally` skips it (`slotHeldByStream`), the pump's cleanup owns it.
- USAL `count-[...]` parses a lone separator + ≤3 digits as DECIMALS — feed it
  compact dot-formatted numbers only (`compactParts` in `ui.tsx`), with the
  K/M/B suffix as plain text outside. Locale-grouped strings ("1,140,500")
  would count to 1.140 and misrender.
- Circuit breaker: client disconnects must NEVER count (audit fix) — only real
  upstream network failures, our header timeout, and upstream 5xx/429. A user
  aborting slow requests would otherwise 503 everyone for 30s.
- Proxy response headers: the upstream must not replace gateway security
  headers — `buildClientHeaders` strips CSP/XFO/nosniff/CORP/etc. and clamps
  Content-Type to json/sse/plain (upstream could otherwise serve live HTML on
  the gateway origin; dashboard tokens sit in localStorage).
- Login lockouts are asymmetric ON PURPOSE: 10 fails/15min per account, but
  `LIMIT_LOGIN_IP_FAIL_MAX` (default 50) per IP — shared IPs (NAT/CGNAT) must
  not be 5 typos away from a collective lockout.

- `PRAGMA user_version` returns column `user_version` — read it generically.
- `bun-plugin-solid@1.0.0` is broken for `.tsx` (no isTSX) — use `plugins/solid-plugin.ts`.
- Babel 8 removed `isTSX`/`allExtensions` — stay on Babel 7 for the build pipeline.
- Bun.serve + `new URL()` normalizes literal `/../` in paths; encoded `%2e` must be
  (and is) refused in `static.ts`.
- TOTP anti-replay: the same code can't be used twice within 90s — affects tests
  doing two logins in one 30s window.
- Provider create/update uses a single `providerWrite()` — create must not
  dereference `existing`; keep null-safe.
- `Modal` renders via `<Portal>` and entrance animations use fill-mode
  `backwards` (never `both`): a retained `transform` creates a containing
  block that breaks `position: fixed` descendants (modal spawns off-screen).

## Testing philosophy

Integration tests spawn REAL child processes (gateway + fake upstream) and drive
HTTP — assert behavior at the boundary, including security (lockouts, traversal,
budget exhaustion, revocation). When you add a route, add its black-box test.
