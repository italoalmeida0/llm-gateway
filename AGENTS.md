# AGENTS.md — llm-gateway

Two projects: Bun gateway (`server/`, `web/`) and Indirect Code Go daemon
(`indirect-code-daemon/`, separate `go.mod`). Current focus: Indirect Code
frontend + daemon. Run checks from the appropriate project root.

## Scope and architecture

- Gateway (`server/index.ts`): `/v1/*` proxies LLM requests; `/api/*` serves
  dashboard and relay; `/*` serves the SPA. `server/routes/relay.ts` is only a
  fan-out pipe: daemon → user's clients, client → daemon selected by hostId.
  **The daemon owns sessions, projects and config on disk.** Do not make the
  gateway or browser an alternate source of truth.
- Indirect Code frontend: `web/src/indirect-code/`; daemon: `indirect-code-daemon/`
  (`cmd/daemon`, `packages/agent|core|provider|runner|…`, Go 1.26).
- Browser mirror: SignalDB in `store/sessions.ts` / `hooks/useMirror.ts`, one
  store per hostId, persisted in IndexedDB. Mutations are daemon commands;
  `saveSession`/`saveProjects`/`saveConfig`/`purgeSession` send debounced (300ms)
  `{type:"change", collection}` pings; clients pull whole snapshots with
  `{type:"pull", id, collection}`. No pushes or per-field WS mirror events.
  Project deletion cascades `purgeSession` for every conversation; a late turn
  must not recreate deleted data.
- Transcript streaming (`agent_event`, `session_content`, attachments, search)
  remains event-driven, not part of mirroring. Tool results display on their
  assistant carrier; `srcIdx` maps display messages to raw daemon indices.
  Collapsing the composer hides input, toolbar, footer AND the entire task plan;
  it is unavailable in `draftMode` or a blocked workspace.
- Frontend: SolidJS + Tailwind v4. Use semantic theme tokens (`ink-*`,
  `accent-*`, `brand-*`, `card`/`elev`/`line`), not hardcoded hex. UI kit in
  `web/src/ui.tsx`; `usal` helpers in `web/src/motion.ts`. Never put `data-usal`
  on Modal/toasts: retained transforms break fixed positioning. Modal entrance
  uses fill-mode `backwards`, not `both`. Solid memos evaluate eagerly: declare
  dependencies above `createMemo` (typecheck cannot catch initial-render TDZ).
- Daemon process helpers: `packages/proctable` powers `KillTree` (including
  setsid'd descendants); `packages/linereader` replaces `bufio.Scanner` for
  unbounded input such as SSE. Kills escalate TERM → grace → KILL + tree sweep;
  POSIX signal exits report 128+signal. Windows children need UTF-8 env/stdio.
  Keep Go dependencies minimal; no cgo.
- One multi-call binary: default role boots/checks/migrates/verifies and
  self-spawns the worker; boot never downloads. `--worker`, `--update-start`,
  `--update-end`, `--slot` select worker mode. Release artifact is
  `indirect-code-<goos>-<goarch>`; `versions.json` has one `daemon` field.
  V1→V2 migration is manual; release and CI run
  `scripts/verify-release-dist.ts`.

## Daemon actor invariants

`cmd/daemon` uses one `sessionActor` goroutine per session (`inbox` + priority
`control`), supervised by `root` → `sessionSup`/`bgSup`/`ws`/`projects`.
`epoch`/`gen` reject stale worker messages; `cancelRounds` can quarantine.

1. Each actor owns its state; communicate through mailboxes, never a lock
   spanning actors.
2. Watchdog kill is a crash: recover from disk/WAL, not partial memory state.
3. Mailboxes are bounded; full inboxes answer busy or drop with a counter.
4. Drain `control` first; never silently lose an accepted cancellation.
5. Trace respawns, quarantines, dropped messages and stale-worker rejections.
6. Liveness uses progress (`lastProgress` + declared waits), not CPU time;
   upgrades use slot swap, not hot loading. Do not build a mini-OTP framework.

## Runner and background tasks

- Protocol details: `docs/runner-protocol.md`, `docs/runner-plan.md`.
  Every bash/python command runs in a self-copied `--runner`, starting immediately.
  It appends to `runners/out/<sessionId>__<jobId>__<startedAt>.log` (filename is
  identity, GC-exempt) and COPIES the log to `brain/` at terminal transitions.
  `runners/<job>.state.json` is the recovery contract; loopback IPC is only an
  optimization. Runner records pid/pgid and reaps the whole command tree before
  recording completion.
- Durable `runners/<jobId>.disposition` is `background`, `inline`, or
  `suppressed` (absent = inline). Only background outcomes wake the agent.
  Recover runner jobs ONLY via state files; adopt live runners at boot, kill
  unlinkable/old orphans. Retain terminal background notices until a durable
  transcript fold is acknowledged; `background_delivery` deduplicates retries.
- At `AutoBackgroundAfter` (10s), return a placeholder naming the brain log;
  completion notices contain NO result text. Model `bg_cancel` stays silent;
  dashboard Stop delivers a cancellation notice. `sleep` wakes on transitions.
  Frontend folds terminal snapshots into the original row;
  `normalizeSessionMessages` preserves folds across snapshots. Session deletion
  drops pending notices; late delivery must never resurrect a session.

## Gateway constraints (when touching gateway code)

- SQLite migrations in `server/db.ts` are append-only. `bun:sqlite` `.changes`
  includes FK cascades: count deletions by existence. Never log/serialize
  provider keys, plaintext gateway keys, TOTP secrets or `GATEWAY_SECRET`.
- `/v1/*` errors use the matching OpenAI/Anthropic envelope; dashboard errors
  use `{success:false,error}`. Audit every admin/user mutation. Budgets are
  SQLite-backed and cap OUTPUT tokens only; report input/cache/output separately.
  Gateway key delete is soft by default; usage ledger survives deletion.
- Failover (`server/failover.ts`) only before first byte reaches client. Never
  auto-disable/skip a provider key: only explicit admin `disabled` skips.
  Billing, auth, rate limit, transient and model-not-found errors may advance
  this request; other 4xx do not. Return real upstream errors + Retry-After;
  keep 2xx streams incremental. Sticky winner is per routing lane, in memory.
- `model_targets` is the ordered fallback chain; top target/key are mirrored
  into `models`/`providers` via `refreshModelMirror`/
  `refreshProviderKeyMirror`. `server/proxy/gateway-ir.ts` translates protocols
  through one IR; target quirks live in `target-profile.ts`. DSML recovery in
  `dsml.ts` requires declared tools, a closed invoke and a matching tool name;
  incomplete candidates restore bytes, native tool calls remain untouched.
- `server/usage.ts`: rollups drive breakdown queries, not raw events. OpenAI
  prompt tokens INCLUDE cached tokens; Anthropic input tokens do not. Estimate
  only all-zero upstream usage when content crosses the wire; never replace
  nonzero upstream figures. No summed "total tokens" display.
- Model registry (`server/models.ts`): `passthrough` forwards names; `router`
  rejects unknown/disabled (404) and orphaned/unavailable (503), rewrites model
  per target, records public ids. Mutations invalidate `routerSnapshot()`.
  Model ids may contain `/`: encode UI ids, match bulk-delete before `/:id`.
- Proxy request bytes stay untouched except OpenAI stream
  `stream_options.include_usage`, chosen by `route.upstreamPath`. SSE relay is
  pull-based; hold concurrency slot until stream ends. Do not count client
  disconnects as circuit-breaker failures. Clamp upstream Content-Type to
  json/sse/plain and strip upstream security headers. Set Bun `idleTimeout`
  above `LIMITS.proxyStreamIdleMs` (240 > 180s; max 255).
- Build SPA with `plugins/solid-plugin.ts` (Babel 7/isTSX, not Babel 8).
  Avoid new crypto libs. `streaming-markdown@0.2.15` is patched; preserve
  `data-streamdown` CSS hooks. Keep `ag-grid-community@31.1.1` pinned exactly
  to the `solid-ag-grid` version. `@floating-ui/dom` overlays use `<Portal>`;
  z-index order: modal 50 < toast 60 < floating 70; position via left/top.

## Commands and handoff

- Gateway root: `bun run lint`, `bun run typecheck`, `bun test`,
  `bun run build:web`. Daemon root: `go test ./...` (real child processes;
  no Go linter configured). Add black-box tests when adding gateway routes.
- After implementation changes leave local builds: `bun run build:web` for SPA;
  `bun run build:daemon` for local daemon; `bun run build:daemon:all` for daemon
  changes (refreshes committed `indirect-code-daemon/dist/` and SHA256SUMS.txt);
  `bun run build` builds both SPA and all daemon platforms.
  `dist/` and `indirect-code-daemon/bin/` are gitignored local builds.
- `bun run dev` / `bun run dev:web` start backend :3000 / frontend :5700;
  `bun start` starts backend without a separate build.
- Browser UI checks are external Playwright scripts, not `bun test`:
  `PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-<name>-ui.ts`.
  Full-stack `test-indirect-bg-e2e.ts [finish|cancel]` and
  `test-indirect-compaction-e2e.ts [manual|auto|chain|overflow|all]` require
  `dist/`, daemon binary and `META_API_KEY`; run manually when affected.
- CI: `.github/workflows/ci.yml` runs gateway gates, native Go matrix,
  musl/glibc-free checks and race detector. Release tags: `ind-vX.Y.Z` for
  Indirect Code, `vX.Y.Z` for gateway; `.github/workflows/release.yml` builds
  and verifies artifacts, with `dry_run=true` for non-publishing validation.
- Write code, docs, commits and user-facing strings in English; conversation
  may match the user. Never add AI attribution to code, docs, commits or PRs.
- Handoff: if a change requires credentials, publishing a release or running
  slow real-model/browser gates unavailable locally, stop and report the exact
  command and missing prerequisite; never claim that gate passed.
