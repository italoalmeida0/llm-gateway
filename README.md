# LLM Gateway

Self-hosted, single-process **LLM API gateway** written for [Bun](https://bun.sh).
You own one upstream provider (e.g. your provider exposing `/openai/v1` and
`/anthropic/v1/messages`); your friends get their own keys, budgets and a
dashboard — without ever seeing the real provider key or URL.

```
client ──(gw_ key)──> gateway ──(real key)──> your LLM provider
                      │
                      ├── /openai/v1/*, /anthropic/v1/*  directional protocol proxy
                      ├── /v1/*  same proxy, protocol inferred from the endpoint
                      ├── /api/* dashboard REST API (JWT + optional TOTP)
                      └── /*     built dashboard (SolidJS SPA)
```

## Features

**Proxy** (`/openai/v1/…`, `/anthropic/v1/…`, legacy `/v1/…`)
- OpenAI-compatible: `POST /openai/v1/chat/completions` (+SSE streaming), `/openai/v1/completions`, `/openai/v1/embeddings`, `GET /openai/v1/models`
- Anthropic-compatible: `POST /anthropic/v1/messages` (+SSE streaming), `/anthropic/v1/messages/count_tokens`, `GET /anthropic/v1/models`
- The prefixed aliases force the protocol from the path (ideal for tools that need one unambiguous base URL); bare `/v1/*` still works and infers the protocol from the endpoint itself
- Exact token accounting: parses `usage` in JSON and streams (injects `stream_options.include_usage` only when the client didn't send it — everything else passes through byte-for-byte, and SSE is relayed incrementally with backpressure, never buffered)
- Per-key security: SHA-256-hashed `gw_…` keys, RPM limit, concurrency cap, daily/total token budgets (daily resets 00:00 UTC), expiration, instant revocation
- Anti-abuse: global per-IP token bucket, proxy key-spray limiting, per-capability circuit breaker for a failing upstream, sanitized upstream errors (never leaks the provider URL/key)
- **Model registry & routing**: creating a provider auto-imports its `GET /models` list into a local registry (tolerant OpenAI/Anthropic/OpenRouter-style parsing, duplicates skipped, admin edits never clobbered). The admin **Models** tab supports manual aliases (public id → any upstream id), rich metadata (pricing, context, modalities, reasoning efforts…), bulk delete and re-linking orphaned models. A global `routing_mode` toggle switches the proxy between **pass-through** (default: model names forwarded untouched) and **router** (strict: unknown models 404, requests rewrite to the registered upstream id, and `/v1/models` is served from the registry in a rich format instead of forwarding upstream)

**Dashboard**
- Users: invite-only (created by admin), email+password login, optional **TOTP 2FA** with anti-replay, **Google sign-in** (link by matching verified email), password reset via email, session list/revocation
- Self-service: mint keys with expiration (1h → permanent) + daily/total token limits + RPM, watch live usage (charts, per-request event log)
- Admin: providers CRUD + connection tester + model sync, model registry tab (CRUD, bulk delete, routing mode), users CRUD/ban/kick/reset-2FA, all-keys view + revoke, global stats (users/models), audit log

**Security hardening** (designed for a publicly exposed endpoint)
- Only admins create accounts — a leaked URL can't mint accounts
- PBKDF2-100k passwords, HS256 JWT (12h) + rotating opaque refresh tokens, brute-force lockouts, constant-time comparisons
- Upstream key stored AES-256-GCM-encrypted, never serialized in API responses or logs
- Strict CSP/nosniff/frame headers on every response, path-traversal-protected static server, CORS allow-list
- No third-party runtime deps for the hot path (JWT/TOTP/AES hand-rolled on WebCrypto); only `nodemailer` + `qrcode` as aux libs

## Quick start (Docker)

```bash
docker build -t llm-gateway .
docker run -d --name llm-gateway \
  -p 3000:3000 \
  -v gateway-data:/data \
  -e GATEWAY_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_EMAIL="you@example.com" \
  -e ADMIN_PASSWORD="use-a-long-random-password" \
  -e PUBLIC_URL="https://gateway.example.com" \
  -e TRUST_PROXY="true" \
  llm-gateway
```

Open `http://localhost:3000`, sign in as the admin, add your provider
(Admin → Providers → "Test connection"), then invite users.

Compose (optional):

```yaml
services:
  gateway:
    build: .
    ports: ["3000:3000"]
    volumes: [gateway-data:/data]
    env_file: .env
volumes:
  gateway-data:
```

## Quick start (bare metal)

Requirements: Bun ≥ 1.3.

```bash
bun install
bun run build                 # builds the dashboard into dist/
cp .env.example .env          # edit secrets
bun start                     # serves everything on :3000
```

Dev mode (hot-ish):

```bash
bun run dev                   # backend on :3000 (watch mode), serves dist/
bun run dev:web               # frontend dev server on :5700, proxies /api + /v1
```

## Configuration

All configuration is env-based — see every option in [`.env.example`](.env.example).
Highlights:

| Var | Purpose |
|---|---|
| `GATEWAY_SECRET` | **required in prod** — signs JWTs, encrypts upstream keys (32+ bytes) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first-admin bootstrap (only when the DB is empty) |
| `GOOGLE_CLIENT_ID` | enables Google sign-in (Web client; JS origin = `PUBLIC_URL`) |
| `SMTP_*` | invite/reset/security emails; without it, action links are printed to the log and shown to the admin |
| `TRUST_PROXY` | honor `cf-connecting-ip`/`x-forwarded-for` (set when behind Cloudflare/nginx) |
| `ALLOWED_ORIGINS` | CORS allow-list for the dashboard API |
| `LIMIT_*`, `DEFAULT_KEY_RPM`, `DEFAULT_KEY_CONCURRENCY` | rate-limit tuning (incl. `LIMIT_LOGIN_IP_FAIL_MAX`, the per-IP password-spray threshold — defaults to 50; keep it well above the per-account lockout of 5) |

## Testing & benchmarks

```bash
bun test               # unit + black-box integration + security suites (fake upstream spawned automatically)
bun run bench          # load test: direct-vs-proxied throughput, p50/p95/p99, streaming
bun run fake-upstream  # standalone fake provider for manual curl testing (:3399)
```

Latest local run: 64/64 tests pass (incl. the adversarial `test/security.test.ts`
suite); proxy sustains ~4.3k rps non-stream at C=50 with ~5 ms p50 gateway
overhead under saturation (dominated by upstream latency at realistic loads),
streaming adds negligible buffering.

## Deployment notes

- Put it behind TLS (Caddy/nginx/Cloudflare). Set `PUBLIC_URL` to the https origin and `TRUST_PROXY=true`.
- `/data` (SQLite + dev-generated secret) is the only state — back it up or mount a volume.
- The proxy routes are meant to be public: every guard (hash-lookup keys, budgets, RPM, concurrency, IP bucket) applies to them by design.

## License

MIT
