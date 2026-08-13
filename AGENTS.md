# AGENTS.md — llm-gateway

## What this is

A self-hosted LLM API gateway (Bun only). One upstream provider; many users with
their own gateway keys, budgets and dashboards. Think simplified self-hosted LiteLLM.

## Architecture (read this first)

- **One process** (`server/index.ts`) serves three surfaces:
  - `/v1/*` → LLM proxy (`server/proxy/index.ts`) — pass-through to the provider's
    `openai_base_url` or `anthropic_base_url`; auth via `gw_…` keys (SHA-256 hash
    lookup in `api_keys`). The upstream key is sent per capability as
    `Authorization: Bearer` or `x-api-key`, configurable per provider
    (`openai_auth_style` / `anthropic_auth_style`; defaults Bearer/x-api-key).
  - `/api/*` → dashboard REST API (`server/routes/*`), JWT HS256 access tokens +
    rotating opaque refresh tokens (`sessions` table, jti revocation).
  - `/*` → static SPA from `dist/` (`server/static.ts`, path-traversal safe).
- **DB**: `bun:sqlite` (`server/db.ts`), migrations via `PRAGMA user_version`,
  in `MIGRATIONS` — append-only, never edit applied ones.
- **Usage accounting** (`server/usage.ts`): buffered writes (flush 1s/100 events),
  `usage_daily` aggregates, per-key spend cached 2s — enforcement is *eventually
  consistent* by design; total-exhaustion additionally flips `api_keys.status`
  optimistically in the proxy hot path.
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
  budgets MUST stay SQLite-backed. The 30/min `authPerMin` bucket covers ONLY
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
- `bun run fake-upstream` — fake provider for manual testing (:3399, key `sk-fake-secret`)
- `bun run seed` — mock usage data for the dev DB (`-- --days N`, `-- --keep`),
  seeds every existing key (replaces usage rows by default)

## Gotchas learned (don't re-learn)

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
