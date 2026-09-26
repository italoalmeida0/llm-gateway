# AGENTS.md — llm-gateway

## What this is

A self-hosted LLM API gateway: a Bun gateway + a Go agent daemon
(`indirect-code-daemon/`, its own `go.mod`) — two projects, one repo; run
each project's gates from its own root. One upstream provider; many users with
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
- **Upstream failover** (migration `009_failover`; auto-skip removed by
  `020_no_auto_key_skip`): every request gets an ordered candidate chain of
  `(provider, provider_key, upstream_model)` and the proxy
  (`server/proxy/index.ts`) walks it — fallback happens only BEFORE the
  first byte reaches the client (error bodies are consumed capped to 16KB
  to be classified; 2xx streams relay untouched, no mid-stream failover).
  - `provider_keys`: N upstream keys per provider, ordered by `priority`.
    **No-skip policy: nothing is ever removed from rotation automatically.**
    Classification (`server/failover.ts` → `classifyHttpError`) only decides
    whether THIS request moves to the next candidate: billing (HTTP 402 or
    quota/billing phrases in any 4xx), auth (401/403 without those hints —
    often transient moderation/geoblock, not a dead key), rate_limit (plain
    429), transient (5xx/408/network) all fail over; `model_not_found`
    (incl. provider-specific wrong-id rejections: synthetic "hf: prefix"/
    "not a valid model ID", openrouter "No endpoints found") fails over
    without touching key state (the key is healthy — it correctly rejected
    a foreign id); other 4xx = client error → delivered as-is, no failover.
    Failures only bump the admin-visible `fail_count` + audit
    (`provider_key.failed`); the client always gets the REAL upstream error
    (Retry-After forwarded when the provider sends one) plus
    `x-gateway-attempts`, and owns backoff/retry. The ONLY skip is an
    explicit admin `disabled` (`keyUsable`). **The last key of a provider
    is never deleted** (`providers.api_key_enc` is NOT NULL).
  - **Sticky winner** (`server/failover.ts` → `stickyGet/Set/Clear`, TTL
    `KEY_STICKY_TTL_MS` default 10min, sliding, in-memory only): per routing
    lane (`model:<proto>:<public-id>` in router mode,
    `pass:<proto>:<requested-id>` in passthrough) the candidate that
    answered last goes FIRST on the next request — steady state is 1
    attempt instead of re-trying a known-bad key first. A failed winner is
    dropped mid-request (the loop already continues); an all-failed sweep
    clears the lane; expiry (inactivity) or any admin mutation
    (`stickyClearAll` on key/provider/target changes) restarts from
    priority order.
  - `model_targets`: N ordered `(provider_id, upstream_model)` rows per model
    — the per-model cross-provider fallback chain; `body.model` is rewritten
    per attempted target. Managed via `PUT /api/admin/models/:id/targets`
    (+ `targets` on model create/PATCH; legacy `providerId`/`upstreamModel`
    writes sync the top-1 target).
  - **Mirror rule**: `models.provider_id`/`models.upstream_model` and
    `providers.api_key_enc` are denormalized mirrors of the top-1
    target/key, recomputed by `refreshModelMirror` /
    `refreshProviderKeyMirror` after every mutation — pre-failover readers
    (sync, admin listing) keep working. A model with zero targets is
    "orphaned" (same semantics as a deleted provider).
  - bun:sqlite `.changes` INCLUDES FK-cascaded rows — count deletions by
    existence, never by `.changes`, when cascade tables are involved.
  - Exhausted/failing everything → the client gets the LAST upstream error
    (sanitized + `x-gateway-attempts`), or 503 only when no attempt could
    reach an upstream at all (every lane circuit-broken).
- **Protocol translation is hub-and-spoke** (`server/proxy/gateway-ir.ts`):
  every ingress protocol (chat/anthropic/responses) decodes ONCE into the
  gateway IR; every attempt (incl. same-protocol — dialects still differ)
  encodes IR→egress in order ingress-protocol → chat → anthropic →
  responses. Streams go through `IRStreamTranslator` (one SSE parser +
  writer per protocol); errors re-envelope via the IR. Protocol N+1 = one
  decoder + one encoder + one SSE parser/writer, never N×N bridges (the old
  `anthropic-bridge.ts`/`responses-bridge.ts` are deleted). Per-target quirks
  (`max_tokens`↔`max_completion_tokens`, `reasoning_effort`/`reasoning`
  forwarding, tool-id ≤64, Gemini `thought_signature`, strip_params) live in
  the universal `target-profile.ts` pass. Passthrough affinity
  (`scoreAffinities` in `server/models.ts`) routes known id-shapes to their
  provider first (hf:*→synthetic, etc.); the per-lane sticky winner (above)
  then keeps the hot path on the last-good candidate. Full ModelInfo
  `/v1/models` compat (codex strict struct) is
  patched in the proxy models path.
- **DSML tool-call recovery** (`server/proxy/dsml.ts`): DeepSeek V4/V4.1 wrap
  tool calls in DSML (`<｜DSML｜tool_calls><｜DSML｜invoke name="…"><｜DSML｜parameter
  name="…" string="true">…` — the bar is full-width ｜ U+FF5C) and serving
  stacks that skip the server-side conversion leak the markup into assistant
  CONTENT instead of tool_calls. The gateway recovers it at the response edge
  on every path: streams (inside `IRStreamTranslator` — the marker tail is
  held until the block closes or the stream ends, never partially emitted),
  translated buffered bodies (post-`decodeResponseToIR`) and same-protocol raw
  bodies (`patchRawResponseDsml` — bytes untouched unless a recovery rewrote
  them). Conservative by design: only when the request declared tools (and
  tool_choice ≠ none), a candidate must CLOSE (`</｜DSML｜invoke>`) before it
  commits, the name must match a declared tool (the missing-invoke-open
  variant reconstructs it ONLY when exactly one declared tool fits the
  recovered parameter names and its required args), rejected/incomplete
  candidates restore byte-verbatim, and the documented long-context
  corruptions — wrappers misspelled as `toolcalls`/`tool`/`calls`, missing
  start wrapper, ASCII `|DSML|` pipes — are tolerated while orphan closing
  tails (bare `</｜DSML｜…>` debris) are absorbed, never leaked. Recovered args
  get harness hygiene (optional nulls dropped, JSON-in-a-string unwrapped);
  native tool_calls stay byte-faithful.
- **Usage accounting** (`server/usage.ts`): buffered writes (flush 1s/100 events),
  `usage_daily` aggregates (plus `usage_model_daily` — per key/date/model rollup
  and `usage_model_provider_daily` (migration 011) — the SAME rollup one
  dimension deeper: `(provider_id, provider_key_id, upstream_model)`; the proxy
  stamps every event with the failover candidate that answered, and the AG Grid
  breakdown queries (`/api/usage/breakdown`, `/api/admin/usage-breakdown`) read
  it, NOT raw `usage_events`; pre-011 rows have empty provider fields and show
  as "—"). Per-key spend cached 2s — enforcement is *eventually
  consistent* by design; total-exhaustion additionally flips `api_keys.status`
  optimistically in the proxy hot path. Tokens are tracked in THREE buckets,
  never one lump sum: `in_tok` (cache-free input), `cache_tok` (cached input,
  billed at cache rate upstream), `out_tok`. OpenAI's `prompt_tokens` includes
  the cached share — the proxy splits it via `prompt_tokens_details.cached_tokens`;
  Anthropic's `input_tokens` is already cache-free and its
  `cache_read/cache_creation_input_tokens` BOTH land in `cache_tok`.
  **Key budgets (`daily_limit`/`total_limit`) cap OUTPUT tokens only** — input
  and cache are visibility metrics, they never consume a key's budget; say
  "output" in every budget label/message. **Zero-usage inference**
  (`splitKvInput` in `server/tokens.ts`, via the btdby4 `kvCache`
  provider): providers sometimes report all-zero usage while content
  flows (observed live: MuseSpark 400k-context turn billed as
  in:0/cache:0 while the provider dashboard showed every bucket). Zeros
  are never trusted blindly — when the upstream says 0 but bytes crossed
  the wire, the gateway infers from btdby4 (output from the streamed
  sample or response text, input/cache split from the request body) and
  always flags the event `estimated`. The input/cache split simulates a
  REAL KV cache on the EGRESS side (the provider that answered): one
  `kvCache` call counts the request JSON with the real BPE engine and
  resolves the longest stable block prefix against a trie with fork
  branches, LFU eviction and TTL — keyed by gateway key + provider +
  provider key + upstream model + egress lane, per-protocol isolation
  built in (10min TTL, 400MB cap). The wasm owns ALL cache state; the
  gateway keeps no fingerprint, no Map, no LRU of its own.
  Nonzero upstream figures are NEVER overridden.
  `PRAGMA optimize` runs at the
  end of `migrate()` — without planner stats, hour-window aggregates on big
  `usage_events` degrade into full index scans.
- **Model registry & routing** (`server/models.ts`, migration `007_models`):
  `models` = public id → ordered `model_targets` (see failover above), with
  rich metadata as validated JSON columns; `settings` KV holds
  `routing_mode`. Creating a SINGLE-capability provider auto-imports its
  `GET /models` (8s timeout, tolerant 3-shape parser, `INSERT OR IGNORE` —
  best-effort, never blocks creation, never clobbers admin edits). A
  DUAL-capability provider instead returns a `preview` of both lists and the
  dashboard asks how to import: `POST /api/admin/providers/:id/sync-models`
  with `{mode}` — `"both"` (default) marks every listed model `proto='both'`,
  `"separate"` ties each model to the protocol whose endpoint listed it
  (duplicates: first capability wins). Proxy reads a 5s `routerSnapshot()`
  cache (mode + all models + enabled providers with decrypted keys); admin
  mutations call `invalidateModelCache()`.
  - `passthrough` (default): model names forwarded untouched; `/v1/models`
    proxies upstream. Zero behavioral change for existing setups.
  - `router`: unknown/disabled model → 404; orphaned (no targets left — e.g.
    its provider was deleted and targets cascade away) or provider/key
    unavailable → 503; body `model` is rewritten per attempted target (only
    when different — byte-fidelity rule stands); usage is recorded under the
    PUBLIC id; `/v1/models` is generated from the registry in the rich format
    (never forwarded upstream).
  - Registry ids are global; `proto` is `openai` | `anthropic` | `both`
    (migration `008_model_proto_both`). A `"both"`-mode sync upgrades
    pristine auto rows (`updated_at = created_at`) of the same provider to
    `'both'`: once an admin edits the row, sync never touches its proto
    again. Orphaned rows (provider_id NULL) never merge either. A model id
    CAN be renamed (PATCH `{id}` — the PK is updated in place, nothing
    references it); usage history keeps the old id, and renaming an
    auto-imported id does not stop the next sync from re-adding it (the
    upstream still lists it).
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
- **Indirect Code** (`web/src/indirect-code/IndirectCodePage.tsx` + `indirect-code-daemon/` Go
  binary + relay in `server/routes/relay.ts`): the gateway is a dumb fan-out
  pipe (daemon → all of the user's clients; client → target daemon by hostId).
  **The Go daemon owns ALL truth** (sessions/projects/config on its disk). The
  page mirrors it with SignalDB (`@signaldb/core|solid|sync|indexeddb`,
  user-sanctioned) via `web/src/indirect-code/store/sessions.ts`
  (`hooks/useMirror.ts`): one store per hostId, IndexedDB persistence
  (`rc:<host>:<collection>`), pull-through-sync. **No pushes and
  no per-field WS events for mirrored data**: mutations are daemon commands
  (`create_session`, `delete_project`, `rename_session`, …); every persistence
  funnel on the daemon (`saveSession`/`saveProjects`/`saveConfig`/
  `purgeSession`) emits a 300ms-debounced `{type:"change", collection}` ping
  (`notifyChange`), and clients re-pull full snapshots over
  `{type:"pull", id, collection}`. Deletions are real deletions: deleting a
  project cascades `purgeSession` over every conversation inside it
  (transcript + attachment dir — purging marks the active turn stale first so
  its deferred save can't resurrect the file). Foreground UX wiring: the
  transcript (`agent_event`, `session_content`, attachments, search) stays
  event-driven (streaming is not mirroring); tool results are hoisted onto
  their assistant carrier for display (`srcIdx` maps rendered messages back to
  raw daemon indices for edit/delete/regenerate). Slash palette only lists
  commands that are not already configurable in the UI. The composer can be
  minimized (chevron in the turn-status row, `ui.composerCollapsed` — one
  global `llmgw-rc-composer-collapsed` preference): the input box, toolbar and
  footer hide and the WHOLE task-plan block folds away (no header, no partial
  read — collapsed means gone), leaving only the `Working` status row plus the
  chevron. Never available in a new conversation
  (`draftMode`) or behind a blocked workspace — the chevron is hidden there.
  - **Daemon project** (`indirect-code-daemon/`, Go 1.26: `cmd/daemon` +
    `packages/agent|core|provider|…`; external deps are gorilla/websocket,
    sergi/go-diff, x/image, x/net — keep both projects' dep lists minimal).
    ONE multi-call binary (the old `cmd/launcher` is merged into `cmd/daemon`):
    the default role is boot (checkup/migrate/verify → self-spawns the worker
    and supervises it — NO downloads at boot), `--worker` runs the daemon
    itself. Routing (`workerMode` in `cmd/daemon/main.go`) is explicit:
    `--worker`/`--update-start`/`--update-end`/`--slot` select the worker
    role, everything else is boot — no legacy invocation shapes. Release
    publishes ONE app artifact
    `indirect-code-<goos>-<goarch>`; `versions.json` has ONE `daemon` field
    carrying those assets (there is no separate launcher concept anywhere
    in the protocol) — version skew is impossible by construction.
    V1→V2 migration is manual (automatic V1 upgrades are out of scope by
    owner decision); release validation runs the shared
    `scripts/verify-release-dist.ts` in CI AND release.
    Background tasks are CRASH-ONLY (`packages/runner`,
    `docs/runner-protocol.md` + `docs/runner-plan.md`): every command
    (bash AND python) runs through a self-copied `--runner` instance that
    starts IMMEDIATELY (never waiting for a parent), appends live output
    to `runners/out/<sessionId>__<jobId>__<startedAt>.log` (GC-exempt —
    the filename is the identity) and COPIES it to `brain/` at any
    terminal transition (copy, never move). The state file
    (`runners/<job>.state.json`: pid, status, exit code, IPC transport)
    is the recovery contract; the IPC (loopback TCP + token, 5 frozen
    verbs) is an optimization only. The registry adopts live runners at
    boot (orphans — unlinkable AND old — are SIGKILLed and cleaned),
    folds terminal states into the retained-notice chain (redelivered
    until the session acks them; the `background_delivery` identity makes
    redelivery idempotent — exactly one wake-up turn, ever), and GCs
    hourly. Background tasks (bash/python only): a
    command outliving `AutoBackgroundAfter` (10s) detaches — the tool
    returns a placeholder naming the brain `.log`, output streams there
    (append, never deleted); finish/error delivers a completion notice
    (system-reminder, NEVER with result text — the model reads the `.log`);
    the model's `bg_cancel` stays silent (its caller learns from the tool
    result) while a dashboard Stop delivers a cancellation notice; `sleep`
    wakes early on any job transition. The frontend folds terminal
    snapshots into the originating row client-side (`detached` mark — the
    server never sends it, so `normalizeSessionMessages` carries folds
    across snapshots and the page re-requests `bg_list` on session open).
- **Animations**: `usal` (see `web/src/motion.ts` — config once, `once:true`
  + `forwards:true`; helpers `usal()`/`usalItems()`/`CountUp`). USAL observes
  DOM mutations, no manual restarts needed. **Never put `data-usal` on
  Modal/toasts** (retained transforms break `position: fixed`, same gotcha as
  fill-mode below). Icons are inline stroke SVGs in `ui.tsx` (`currentColor`)
  — do not reintroduce runtime icon CDNs.
- Static legal pages: `web/public/*.html` copied into `dist/`.

## Hard rules

- **Write code and files in English.** Code, comments, commit messages, PR
  descriptions, docs, and user-facing strings must be in English. Chat
  conversation with the user may be in any language — match the user's language.
- **NEVER add AI attribution to anything.** No `Co-Authored-By: Claude`
  (or any assistant) trailers, no "generated with AI" notes, no assistant
  signatures anywhere — commits, PRs, docs or code. The owner authors
  this project and every commit stands on its own. Never add such
  trailers out of habit; the user has explicitly forbidden them.

- **Never log or serialize secrets**: upstream provider keys (AES-encrypted at rest),
  plaintext gateway keys (SHA-256 hash is the lookup key; an AES-encrypted copy
  `api_keys.token_enc` exists ONLY for the owner/admin `/reveal` endpoints and
  every reveal is audit-logged), TOTP secrets, GATEWAY_SECRET.
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
  `qrcode` (TOTP QR), `btdby4-wasm` (universal WASM token-count estimation when an
  upstream reports no usage — used ONLY on that estimate path, user-sanctioned;
  same BPE engine as the indirect-code daemon, per-protocol counters + images +
  encrypted-reasoning; one 8MB wasm ships inside the npm package, zero native deps —
  linux/mac/windows, glibc/musl),
  `usal` (scroll/entrance animations, user-sanctioned), `sortablejs`
  (drag-and-drop ordering, user-sanctioned — only imported
  by `web/src/sortable.ts`; rows carry `data-id` + a `[data-handle]` grip,
  the reordered ids are POSTed to the matching `/reorder` / `PUT …/targets`
  endpoint), `@signaldb/core|solid|sync|indexeddb` (Indirect Code offline
  mirror, user-sanctioned — only imported by
  `web/src/indirect-code/store/sessions.ts`) and
  `solid-charts` (charts, user-sanctioned — composable SVG
  `Chart`/`Axis`/`Bar`/`Area`/`Line` components in `web/src/charts.tsx`; colors
  are passed from the `--chart-*` CSS vars so white/dark flip for free; chart
  entrance animations live in the stylesheet because the library does not
  animate series natively yet).
   Floating layers (tooltips, `<Select>` menus, popover menus) run on
   `@floating-ui/dom` (user-sanctioned — the vanilla build, never the React
   one) through `web/src/floating.tsx`: `anchorFloat()` (flip + shift +
   autoUpdate, optional `matchWidth`/`maxHeight` via `size()`; rAF-deferred
   setup + visibility guard so Portal timing can never throw on detached
   nodes) and the single z-index scale `Z` (modal 50 < toast 60 < floating 70
   — Modal/Toasts read it too). Every overlay mounts in a `<Portal>` so
   nothing is clipped by an ancestor's overflow or stacking context;
   `anchorFloat` positions via **left/top, not transform**, so the
   `anim-float-in` entrance (transform-origin set from the resolved placement)
   is safe on the positioned element itself. Call it from a `ref` callback
   inside `<Show>` — the cleanup is owned by the Show and autoUpdate stops on
   close. Menus that need one (e.g. RemoteCode) build a tiny local component
   on top of `anchorFloat`. The `Tooltip` UI-kit component replaces native
   `title` (IconBtn/Btn/ThemeToggle/rail use it; hover-capable pointers +
   keyboard focus only, touch taps don't pin tooltips). Lint/typecheck gate:
   `bun run lint` (eslint flat config — TS + eslint-plugin-solid; refs are
   why `no-unassigned-vars` is off for web, and AG Grid cell renderers are
   why `solid/reactivity` + `solid/components-return-once` are off) and
   `bun run typecheck` (`tsc --noEmit`) must both stay clean.
  Usage AND entity tables are AG Grid (`ag-grid-community` + `solid-ag-grid`,
  user-sanctioned — wrapper in `web/src/aggrid.tsx`): usage breakdowns, recent
  requests, admin top users/models, user + admin keys, admin users, admin
  models (row selection + checkbox bulk-delete) and the audit log.
  `UsageGrid` needs a `storageKey` per grid — it persists column
  order/sizes/sort/filters to localStorage and restores on next visit (Reset
  layout button at the bottom). Option props are module constants and the grid
  only mounts once rowData is set: solid-ag-grid@0.0.230's prop-diff effect can
  fire before the grid api exists (crash `__internalUpdateGridOptions`) and
  inline object literals would retrigger it. The Recent-requests grid instead
  uses the **infinite row model** (`datasource` prop): blocks are fetched from
  `/api/usage/events` on scroll (limit/offset), and the grid's sortModel /
  filterModel is translated to SQL server-side through a strict column
  whitelist (`buildEventFilter`/`buildEventOrder` in `server/usage.ts` —
  never interpolate user input; unknown cols/malformed JSON degrade silently).
  `e.id DESC` is always appended to ORDER BY so OFFSET blocks stay
  deterministic. solid-ag-grid pins
  `ag-grid-community@31.1.1` EXACTLY — keep the top-level dep on the same
  version or bun nests a second copy and types diverge. Theme flips via the
  `ag-theme-quartz(-dark)` class; the `--ag-*` CSS variables are remapped to
  the semantic tokens in `style.tailwindcss.css` (never hardcode hex).
  `@fontsource-variable/inter` is a bundled dev asset (no runtime CDN).
   Indirect Code Markdown uses `streaming-markdown@0.2.15` (the user-tested
   thetarnav parser) via `components/StreamingMarkdown.tsx`, wrapping the
   parity.html port in `components/TarnavMarkdown.tsx`: incremental DOM,
   bounded snapshot slices, live block highlighting, gutters/copy, file and
   command icons, KaTeX (local CSS/fonts), and aligned tables without controls.
   Code headers have compact copy buttons. The pinned parser patch preserves
   literal backtick runs inside inline code/table cells and matching LaTeX
   delimiters for same-line or multiline display math. Pause rendering
   while hidden/collapsed; keep raw code separate from highlighted DOM.
   Preserve the `data-streamdown` attributes for existing theme rules; they
   are CSS hooks, not a dependency on the removed renderer. Browser gates use
   only the current renderer.
   Relay events share one ordered, lossless batch (`relayInbox.ts`); never
   let status/snapshot events overtake buffered deltas. USAL's global DOM
   observer is suspended on `/code` because that workspace has no USAL
   entrances. Bun-native or hand-rolled beats a new dep.

## Commands

- CI: `.github/workflows/ci.yml` runs on `dev`/`main` pushes and PRs — gateway
  gates (lint/typecheck/test/SPA build) on Linux plus the full Go suite NATIVE
  on every shipped OS/arch (linux amd64/arm64, windows amd64/arm64, macos
  arm64/amd64 — the daemon/launcher ship per-platform), the full suite on a
  musl userland (Alpine) plus a glibc-free proof of the shipped linux
  artifacts (exec on bare Alpine + `statically linked` assert), and the
  complete race detector on Linux. The release workflow reuses this matrix as
  its gate (`workflow_call`).
- Release by tag (replaces the manual `bun run release <version>`): push a tag
  `ind-vX.Y.Z` (Indirect Code) or `vX.Y.Z` (gateway) —
  `.github/workflows/release.yml` runs the full CI matrix, builds every
  daemon/launcher platform, verifies `SHA256SUMS.txt`/`versions.json`, creates
  the GitHub Release with the artifacts, and commits `indirect-code-daemon/dist/`
  back to `main` so the VPS listener serves `<gateway>/r/`. Run it manually with
  `dry_run=true` to build+verify without publishing.
- After implementation changes, always leave fresh local builds available for
  the user to test: `bun run build` (SPA into `dist/` + every daemon platform),
  `bun run build:web` for the SPA alone, `bun run build:daemon` for a
  single-platform daemon binary. `dist/` and `indirect-code-daemon/bin/` are
  gitignored local artifacts; the release binaries in
  `indirect-code-daemon/dist/` (+ `SHA256SUMS.txt`) ARE committed — refresh
  them via `bun run build:daemon:all` whenever daemon code changes. The gateway
  backend runs directly with `bun start`; it does not require a separate build.
- `bun run dev` / `bun run dev:web` — backend :3000 / frontend dev :5700 (proxies /api,/v1)
- `bun run build` — full release: SPA into `dist/` + all daemon platforms into
  `indirect-code-daemon/dist/`
- `bun run lint` — ESLint 10 flat config (`eslint.config.js`: TS + eslint-plugin-solid); keep it at zero
- `bun run typecheck` — `tsc --noEmit`; keep it at zero
- `bun test` — must stay green (unit + black-box integration with fake upstream;
  covers the Bun side only — Go and browser gates below are separate)
- From `indirect-code-daemon/`: `go test ./...` must stay green (real commands,
  tight `AutoBackgroundAfter` overrides). No Go linter is configured and
  `gofmt` is not enforced (baseline has unformatted files) — match the
  surrounding style, don't reformat unrelated files.
- `bun run bench` — perf harness; do not let non-stream overhead regress wildly
- `bun run perf:sim` — day-by-day growth sim (real gateway+upstream, HTTP
  measurements per checkpoint up to 10y; `PERF_MAX_DAYS=N` to shorten)
- `bun run perf:tuning` — `build|measure|sql <dir>` on a persistent big dataset
- `bun scripts/load_test.ts [dir] [days=365] [--live] [--reuse]` — exact-scenario
  scale audit (20 users × 500 reqs/day, 10M/100M/500K tokens, 50 audit rows per
  user-day): seeds `days` of history, times every dashboard query + the flush
  write path before/after migration-013 indexes, optional live HTTP pass;
  writes a markdown report
- `bun run fake-upstream` — fake provider for manual testing (:3399, key `sk-fake-secret`)
- `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-turn-ui.ts`
  (also `test-indirect-composer-ui.ts`, `test-indirect-settings-ui.ts`,
  `test-indirect-wco-ui.ts`, `test-indirect-collapse-ui.ts`) — component checks in real Chromium against
  fixture bundles (fast, no model). Playwright is always an external install,
  never an app dependency.
- `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-bg-e2e.ts [finish|cancel]` —
  full-stack background check (real gateway + daemon + model + Chromium on
  `#/code`: finish-fold/duration, manual-cancel notice, zero page errors).
  Needs `dist/` + daemon binary built and `META_API_KEY` in `.env`;
  `CHROMIUM_PATH` falls back to PATH and the Playwright browser cache.
  Slow (~3 min, real model latency) — manual gate, not part of `bun test`.
- `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-compaction-e2e.ts [manual|auto|chain|overflow|all]` —
  full-stack compaction check (real gateway + daemon + Meta model + Chromium
  on `#/code`: manual `/compact`, proactive auto-compact at a low threshold,
  chained second compaction, reactive 400-overflow retry via the
  `E2E_FORCE_OVERFLOW` admin hook; asserts the dedicated balloon renders with no
  duplicate `## Context Summary` user bubble, no raw `<system-reminder>` leak,
  zero page errors). Shrinks the registry model's `context_length` so a small
  window fires fast; heavy seeds read the `test/books` corpus (~1.1M tokens).
  Needs `dist/` + daemon binary built and `META_API_KEY` in `.env`.
  Slow (real model latency, ~15 min for all) — manual gate, not part of `bun test`.
- `META_API_KEY=… bun scripts/test-usage-parity.ts` —
  usage parity check (throwaway gateway + real Meta provider, all 3 native
  protocols): direct Anthropic vs gateway Anthropic must match exactly;
  gateway OpenAI-chat must report `prompt_tokens` = in+cache and
  `prompt_tokens_details.cached_tokens` = cache total; gateway Responses
  must report the same via `input_tokens_details`; the gateway's own
  `/api/usage/breakdown` must record all legs with non-zero cache.
  Repeats each leg so the 2nd call reports cache_read > 0.
  Needs `META_API_KEY` in `.env`. Fast (~1 min) — manual gate, not part of `bun test`.
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
- Solid memos evaluate EAGERLY: a `createMemo` reading a `const` declared
  below it throws a TDZ `ReferenceError` on first render (broke every tool row
  on expand) — declare row-model helpers ABOVE the memos. tsc/eslint/`bun test`
  cannot catch this; only the browser does (the bg-e2e script asserts zero
  page errors for exactly this reason).
- BG jobs survive daemon restarts via pidfile re-adoption (never re-run);
  unacknowledged completion notices are retained on disk and retried until
  the session folds them into its transcript. Session deletion drops
  pending notices — a late delivery must never resurrect a deleted
  session.

## Testing philosophy

Integration tests spawn REAL child processes (gateway + fake upstream) and drive
HTTP — assert behavior at the boundary, including security (lockouts, traversal,
budget exhaustion, revocation). When you add a route, add its black-box test.
Go tests (`go test ./...` from `indirect-code-daemon/`) follow the same spirit
with real commands and tight `AutoBackgroundAfter` overrides — no mocks for
process behavior. Browser checks are Playwright scripts, never `bun test`:
`scripts/test-indirect-*.ts` for components (fixture bundles, fast) and
`scripts/test-indirect-bg-e2e.ts` for the full stack (slow, real model).
