# Indirect-code daemon — actor model (IMPLEMENTED)

Status: **IMPLEMENTED — this doc is the decision record.** The mutex-based
implementation was deleted (`git rm indirect-code-daemon`, history preserves
it); the actor-model code now lives at `indirect-code-daemon/` (module
`llm-gateway/indirect-code-daemon`). There is no v1/v2 split anymore —
references to "v2" below mean "the current code".

> **Reviewer note (read before re-auditing):** §11 locks every decision
> the owner already took, with rationale. Points marked **DECIDED** are
> closed — do not re-raise them as findings; challenge only the
> implementation, not the decision.

## 0. Why a new project (decided, done)

- The change is too big for in-place migration: actor rewrite + removal of
  MCP/skills/OpenAI-provider/search-backend + frontend swarm-UI removal.
- In-place would leave a v1/v2 Frankenstein behind flags. A new project stays
  focused and testable in parts.
- v1 remains runnable and is the **parity oracle**: same scripted conversation
  on v1 and v2 must produce identical disk state + transcript.

## 1. Frozen borders (drop-in — kept)

These do **NOT** change, so the frontend and gateway never notice the swap:

1. **WS protocol** (`web/src/indirect-code/daemon-protocol.ts`): same message
   names, same envelopes. Removed domains (mcp, skills, swarm, search) simply
   stop having backend handlers — see §2.
2. **Disk format**: `sessions/<id>.jsonl`, `<id>.wal.jsonl`, `projects.json`,
   `config.json`, bg `.log` layout — byte-compatible, so an existing data dir
   opens in v2 with zero migration. WAL replay semantics (`loadSessionFused`)
   are reimplemented identically.
3. **Gateway relay** (`server/routes/relay.ts`): untouched; it only forwards
   bytes keyed by `hostId`.

## 2. Cuts — removed before/with v2 (decided, real removal, no flags)

| Area | Cut |
|---|---|
| `packages/mcp` + `mcp_runtime.go` + `syncMCP` + `getMCPStatus` | delete entirely (never used, no legacy) |
| skills (agent skills wiring) | delete entirely |
| OpenAI provider path in daemon (`packages/provider/openai*.go`, openai clamp) | delete; daemon speaks **Anthropic-native only** (gateway translates) |
| search backend (`search_sessions` handler + endpoint) | delete handler; frontend keeps the UI component inert (renders, does nothing) |
| agent-swarm frontend UI | remove component |
| `history_page` stays, but served from RAM/cache (§6), not fresh disk scan per request | rework, not removal |

Anything referencing the above (docs, tests, fixture bundles) is deleted or
updated in the same commit — no dead code left behind.

## 3. Target architecture (v2)

```
root supervisor
├── session supervisor ── session actor × N
├── bg supervisor ── job (goroutine + done msg, NOT a full actor)
├── ws actor (writer, chan outbound cap ~256)
├── projects actor (owner of projects.json)
└── config (atomic.Pointer[Config], copy-on-write — NOT an actor)
```

### 3.1 Component roles

- **Root supervisor**: starts/stops/restarts the 4 actors. Owns shutdown
  (`WaitGroup` + per-child deadline; logs which child didn't answer — no
  infinite wait). Watched from **outside** the process (systemd/docker/launchd
  + health endpoint reporting "all supervisors answered last ping round?").
- **Session supervisor**: owns `map[id]inbox`. Spawn-on-demand (disk/WAL
  replay if absent), `passivate` on eviction, watchdog pings (§5), `shutdown`.
- **Session actor** (1 per session): owns `record`, `Status`, `gen` (local
  sequence number), `wal`, `Queue` (cap 30), pending approval/question state.
  Turn runs in a **worker-daughter goroutine** (current `runAgentTurn` shape,
  minus MCP/skills); state mutations return as inbox messages. Mailbox is
  dual-lane: `inbox` (data, bounded cap 64–128, explicit busy/drop policy)
  + `control` (cancel/timeout/watchdog/shutdown, cap 8, always accepted).
- **BG supervisor** (real actor): owns `map[jobID]handle`. Serves `bgStart`,
  `bgList` (snapshot copy), `bgCancel`, `bgRead`, `jobExited`; forwards
  `bgJobFinished` to the owning session actor; serves **sleep/wake** (§4).
- **Job** (NOT an actor, no watchdog): OS process (bash/python) + `.log`.
  A waiter goroutine sends exactly one `jobExited` on the supervisor's
  control lane. Crash-safety for jobs: §5.3 (never re-run, preserve logs,
  re-adopt via pidfile).
- **WS actor** (real actor): single writer goroutine, `chan outbound`
  cap ~256. Slow client → drop + counter, never stalls sessions.
  Emergency fatal-path write keeps a tiny mutex outside the actor.
- **Projects actor** (real actor, ~100 lines): sole owner of `projects.json`.
  Messages: `create`, `delete` (cascade-purge sessions inside), `get`,
  `setCollapsed`. Eliminates today's file-level lost-update
  (read-modify-write with no lock).
- **Config** (NOT an actor, no watchdog): `atomic.Pointer[Config]`,
  copy-on-write. Lock-free reads on the hot path; writer swaps pointer.

### 3.2 What is copied from v1 (adapted) vs written new

- **Copy + adapt**: `SessionRecord` types, WAL format + fused-load logic,
  `packages/provider/anthropic.go`, agent turn loop (`packages/core/agent.go`
  minus MCP/skills), `packages/filetrack`, `packages/ignore`, file tools,
  queue/compact/fork/title/question/convert **logic** (locks removed, state
  transitions become messages).
- **New**: all actors, `Envelope` protocol, state machine (§7), watchdog (§5),
  15-min timers (§8), LRU/TTL session cache (§6), pidfile job recovery (§5.3).
- **Not copied**: §2 cuts.

### 3.3 Remaining locks (small, never cross actors)

| Lock | Where | Why |
|---|---|---|
| WAL `walWriter.mu` | inside session worker | shared `bufio.Writer` + file offset; buffer-copy only, no blocking I/O inside |
| WS emergency write mutex | root fatal path | socket is physical shared resource; actor is normal owner |
| `sync.Once` (job `done`), `WaitGroup` (shutdown), `atomic.*` | various | non-blocking primitives, no wait cycles |
| filetrack internals | inside package | library-boundary invariant |

Rule: **no lock spans two actors** → no wait cycle → no deadlock by topology
(today safety = acquisition-order discipline).

## 4. Sleep/wake via bg-supervisor push (decided: option 1, push)

v1 semantic preserved: `sleep(secs)` wakes **early** when any bg job of the
session finishes — the model must not sleep pointlessly.

- The turn worker executing `sleep` waits with `select` on
  `time.After(remaining)` vs a per-sleep channel the **bg supervisor** pushes
  `jobFinished{jobID}` onto (subscribed at sleep start, unsubscribed at end).
- No 500 ms polling of a locked map. `RecentBgFinish`-style freshness (60 s
  grace: a job that finished *just before* sleep started still wakes it) is
  kept: supervisor checks `finishedSince{sessionID, ts}` at subscribe time.
- Pure timeout fallback if the supervisor is unreachable (bounded wait, never
  infinite).

## 5. Crash-safety: watchdog kill == process crash (decided)

**Every actor must be safe against force-kill at any point.** A watchdog kill
is handled exactly like "the process died and came back": replay + resume,
never half-state.

### 5.1 Session actor killed

- Supervisor re-spawns → replay disk + WAL (`loadSessionFused` semantics).
- Died with turn `running` + valid WAL → **resume from WAL** (same as v1 boot
  `resumeTurn`), not discard. Work is preserved.
- Died in `awaitingApproval/Question` → back to the same state; the 15-min
  deadline is **persisted** (`deadlineUnix` in record/WAL), so respawn
  recomputes the *remainder* — restart never bypasses the timeout (§8).
- Commit-WAL failure: internal retry with backoff (3x, as v1), then stay
  `running`-with-WAL (v1 semantic kept); next boot/respawn resumes. Never
  silently mark idle on failed commit.

### 5.2 Supervisors / WS actor killed

- Session supervisor: rebuilds `map[id]inbox` on demand (spawn-on-lookup +
  disk/WAL replay). Nothing persisted to lose.
- BG supervisor: rebuilds by **scanning pidfiles** (§5.3), re-attaching
  waiters to live processes.
- WS actor: reopens `outbound`; in-flight messages during restart are dropped
  + counted; clients re-pull snapshots via existing `{type:"pull"}`.

### 5.3 BG jobs: NEVER re-run after a kill (decided)

Rationale: a kill can't know what the job was doing — re-running a half-done
`rm -rf`, migration, or deploy causes side effects. So:

- **No re-execution, ever.** A killed-while-running job is marked
  `orphaned` (or `finished` if the process actually exited).
- **Logs + state preserved**: `.log` file stays readable; job row keeps
  `status/exitCode/finishedAt`.
- **Recoverable re-adoption via pidfile**: each started job writes a pidfile
  `{jobID, pid, logPath, sessionID, startedAt}` (same dir as logs). On bg
  supervisor (re)start it scans pidfiles: pid alive → re-attach a waiter
  (poll `pidAlive`, since the original `cmd.Process` handle died with the
  supervisor) and keep the job `running`; pid dead → finalize the row from
  the `.log` tail (exit unknown → `orphaned`, log intact).
- The OS process keeps running across a supervisor kill (child of the daemon
  process, not of the goroutine) — re-adoption, not restart, is the mechanism.

### 5.4 Watchdog coverage (only actors are watched)

| Component | Actor? | Watched by | Signal |
|---|---|---|---|
| Session actor | yes | session supervisor | ping → `{alive, lastProgress, stateName}`; 3-level policy (§5.5) |
| Session supervisor | yes | root | `{alive, children, queueDepth}` |
| BG supervisor | yes | root | `{alive, jobs, queueDepth}` |
| WS actor | yes | root | `{alive, queueDepth, dropCounter}` |
| Projects actor | yes | root | `{alive, queueDepth}` (light, same as other infra actors) |
| BG job | no | — | structural exit notice; §5.3 |
| Config | no | — | atomic swap; nothing to wedge |
| Root | top | outside (process manager + health) | — |

### 5.5 Session watchdog policy (3 levels)

- **No reply to ping** → goroutine wedged: kill + respawn (§5.1).
- **Alive, stale `lastProgress`, `state==awaiting*`** → normal (human may take
  hours; §8 timer bounds it).
- **Alive, stale `lastProgress`, `state==running`** → wedged turn: first
  `cancel()` worker ctx; kill actor only if it ignores cancellation.

## 6. Session RAM: LRU + TTL (decided)

`session_eviction.go`'s idle sweep becomes supervisor-owned passivation:

- **Never-used session**: not in RAM. A read (`history_page`, `session_data`)
  loads from disk, serves, and keeps it in an LRU with **TTL 1 min**.
- **`user_prompt` arrives** → session active; TTL suspended while the turn
  runs (incl. `awaiting*` — a human-pending turn is active, bounded by §8).
- **Turn truly ends** (`idle` + queue empty) → back to LRU with
  **TTL 30 min** (decided).
- **Eviction** = `passivate`: `commitWAL`, close WAL, drop from RAM. Next
  message re-spawns transparently (disk/WAL replay).

### 6.1 Capacity (decided by reviewer: memory-based, not fixed count)

Not a fixed "10 sessions". The supervisor enforces a **memory budget**:

- Each resident session reports an estimated footprint
  (`len(messages)` bytes + attachments + WAL buffer — cheap heuristic,
  refined with real numbers in testing).
- Budget default: **512 MB** resident sessions (tunable via env/config).
- Over budget → evict oldest-idle first (LRU), regardless of TTL.
- Safety valve: if a *single* session exceeds the budget, it is NOT evicted
  mid-turn (turns are never killed for memory); the supervisor logs + counts,
  eviction applies to idle residents first.
- Hard cap fallback: max 64 resident actors (prevents fd/goroutine sprawl if
  the heuristic undercounts). Both numbers tunable; first load test calibrates.

## 7. Message protocol (session actor)

### 7.1 Envelope

```go
type Envelope struct {
    SessionID string
    Payload   any      // one of §7.2/7.3
    Reply     chan any // nil = fire-and-forget
}
```

- `Reply` always with `select + timeout` (5 s): dead actor → timeout
  (logged + metric), never a hung caller.
- Producers use non-blocking send on `inbox` (`select/default` → §7.5).
  Control lane always accepted.

### 7.2 Data lane (`inbox`, cap 64–128)

| Message | From | Effect |
|---|---|---|
| `userPrompt{text, attachments, model}` | ws dispatch | `running` → `Queue` (cap 30 else `queue_full`); else start worker |
| `queueOp{op, ...}` | ws dispatch | only when not disturbing a running turn |
| `transcriptChunk{delta}` | worker | → ws actor (even in `awaiting*`) |
| `toolResult{id, payload}` | worker | into pending tool batch |
| `approvalResponse{id, decision}` | ws dispatch | `id != state.id` → drop; else resume worker |
| `questionResponse{id, answers}` | ws dispatch | same correlation |
| `bgJobFinished{jobID, exit}` | bg supervisor | fold into transcript; wake sleeping worker (§4) |
| `stateTimeout{id}` | self (AfterFunc) | §8 |
| `editRegenerate{keep,...}` / `forkReq{...}` | ws dispatch | **only in `idle`** (simpler than v1's branches); `gen++`, cancel ctx, truncate, new turn |
| `readReq{what, reply}` | ws dispatch | `history_page`/`session_data` served from actor RAM (§6); loads from disk only if passivated |
| `tickFlush` | self timer | WAL buffer flush |

### 7.3 Control lane (`control`, cap 8)

`cancelTurn`, `watchdogPing{reply}`, `passivate`, `shutdown` — as before.

### 7.4 State machine

```
idle ──userPrompt──▶ running ──needsApproval──▶ awaitingApproval{id, deadline}
 │                      │  ▲                          │ response(id ok) / timeout(question)
 │                      │  │                          ▼
 │                      │  └──── resume ──── running (question: recommended + notice)
 │                      │                              (approval timeout: ──▶ idle + notice, queue intact)
 │                      ▼
 │                   cancelling ──worker exits──▶ idle ──queue non-empty──▶ running
 └──edit/fork (idle only)──▶ (gen++, truncate) ──▶ idle/running
```

- `gen` = local sequence number; worker callbacks carry `myGen`; mismatch →
  no-op. Stale responses/timeouts (wrong `id`) → dropped.
- Only the finalizer (`running→idle`) promotes the queue head.

### 7.5 Backpressure (mailbox full)

| Class | Policy |
|---|---|
| `userPrompt`, `queueOp` | `busy, try again` |
| `transcriptChunk` | impossible by construction (own worker); counter + log as bug signal |
| `control` lane | never dropped |
| ws `outbound` full | drop + counter |

## 8. Timeout semantics (decided: 15 min per request, persisted deadline)

- Armed on entering `awaiting*` via `time.AfterFunc(15min, inbox <- stateTimeout{id})`,
  stopped on exit. Mailbox order decides response-vs-timeout; loser finds id
  mismatch → dropped.
- **Deadline persisted** (`deadlineUnix` in record/WAL): respawn recomputes
  remainder — restart never bypasses the timeout.
- **Question unanswered**: inject `recommended` (payload must carry
  `recommendedIndices`; fallback TBD if absent — abort turn vs first option,
  see §10.3), resume turn, system notice:
  `"User didn't respond in 15min — proceeding with recommended."`
- **Approval unanswered**: cancel turn (`cancel()` ctx, `state=idle`, `gen++`),
  system notice: `"Approval timed out after 15min — turn cancelled."`
  Queue **intact**.
- Per-request, not per-turn: three approvals answered at 14 min each = 42-min
  turn (progress, not stall).

## 9. Build order (done — all gates passed)

> Historical record: V2.0–V2.4 shipped in order with gates green
> (`go build`, `go vet`, `go test ./...`, `-race`, live E2E vs Meta).
> The cutover happened (v2 promoted to `indirect-code-daemon/`, v1 deleted).
> What follows is the original phase plan, kept for archaeology.

**V2.0 cuts + skeleton.** New module `indirect-code-daemon-v2/`
(`go.mod`, minimal deps: gorilla/websocket, go-diff, x/image, x/net only).
Copy `SessionRecord`/disk-format code + anthropic provider + filetrack/ignore.
Delete-list (§2) enforced from day one — nothing cut is ever copied.
*Gate: `go build ./...`, `go test -race ./...` on copied packages.*

**V2.1 session actor + supervisor + WAL.** Envelope, dual-lane mailbox, state
machine, WAL writer + fused load, 15-min timers, LRU/TTL cache (§6),
watchdog §5.1/§5.5. Turn worker = adapted `runAgentTurn` (Anthropic-only,
no MCP/skills).
*Gate: state-machine unit tests; WAL crash tests (kill -9 mid-turn → resume);
parity vs v1 on scripted conversations (prompt → approval → question →
cancel → edit → fork).*

**V2.2 bg supervisor + jobs + sleep/wake.** pidfile write/scan/re-adopt
(§5.3), push-wake sleep (§4), `bg_*` handlers.
*Gate: job lifecycle tests incl. supervisor-kill → re-adopt (no re-run, log
intact); bg e2e script green.*

**V2.3 ws actor + projects actor + atomic config + read path.** `readReq`
serving `history_page`/`session_data` from RAM; projects CRUD; health endpoint.
*Gate: full WS parity vs v1 (minus removed domains); `-race` clean.*

**V2.4 cutover.** v2 becomes the shipped daemon (build scripts + `dist/`
release point at v2); v1 kept one release as fallback (same disk format, so
rollback = restart with the old binary). Then v1 deleted.
*Gate: `bun test`, `go test ./... -race`, Playwright component scripts green.*

**Rollback (all phases):** disk + WS protocol unchanged ⇒ any phase rolls back
by running the other binary. No migration to undo.

## 10. Open items for reviewer

1. Worker placement confirmed: **worker-daughter goroutine** (minimal rewrite).
   OK?
2. `inbox` cap 64–128 — accept, or tune after first load numbers?
3. Question-timeout fallback when `recommendedIndices` absent: first option vs
   abort turn?
4. Memory budget defaults (§6.1): 512 MB + 64 residents — accept?
5. New module name: `indirect-code-daemon-v2/` or another name?
6. Confirm the two notice strings (§8) + 15-min value final.

## 11. Locked decisions (DECIDED — do not re-raise as findings)

Each entry: the decision, why, and where it lives in code. An audit that
reports these as bugs is auditing the wrong layer — verify the
implementation matches, not the choice itself.

### D1. Launcher was never part of the rewrite (restored, not removed)

- **DECIDED:** `cmd/launcher` + `internal/migrations` + `dist/` release
  artifacts were restored from the pre-rewrite tree. The launcher
  supervises ANY daemon binary via `--version` probing; it never touched
  mutex/actor code.
- A previous cleanup wrongly deleted it as "v1 leftover". That was a
  mistake, corrected in commit `8b2b391`.
- `scripts/build-indirect-all.ts` builds daemon (`-X main.Version`) +
  launcher (`-X main.launcherVersion`) and manifests both. `bun run release
  X.Y.Z` is unchanged. Auto-update keeps working through the launcher as
  before — no operational regression.

### D2. MCP / skills / OpenAI-path / search-backend / swarm-UI: deleted for real

- **DECIDED:** never used, no legacy, no flags. Backend packages gone;
  frontend tabs (MCP/Skills) and Auto-Swarm toggle removed from Settings
  (`SettingsModal.tsx`, `SettingsGeneral.tsx`); `search` answers empty so
  the inert UI never errors.
- `update_config` applies settings only; unknown keys ignored.

### D3. Daemon is Anthropic-native only (constraint, not gap)

- **DECIDED:** the OpenAI provider path was deleted; the daemon speaks
  Anthropic and the gateway translates. Consequence, accepted by owner:
  **"daemon never outside the gateway"** — standalone manual testing and
  gateway-less debugging are harder (use the local gateway +
  `META_TEST_KEY`). Self-hosted single-upstream setup makes this fine.
- Do NOT file "daemon can't talk to provider directly" as a bug.

### D4. Self-update protocol: daemon side removed, launcher side intact

> **Restored (2026-09-25).** A follow-up review found that the deleted
> orchestration was NOT legacy: it was the 2026-09-23 update
> reformulation (v1.0.28, `update_flow.go` + `launcher --update`), which
> the `ex-v2` fork simply predates — the rewrite lost it, it was never
> retired. The full brutal-update protocol is now ported into the actor
> daemon (`update_flow.go`/`update.go`/`handoff.go` + `update_host.go`
> adapting it to `root`/link plumbing; the update flow still never
> touches session state — SIGKILL + crash recovery is the resume
> mechanism). The gap below is closed: auto-check, availability
> broadcast, one-click apply, slot A/B handoff and the `update.done`
> acknowledge all work again, with the v1.0.28 test suite green and the
> handoff/gateway-death e2e scenarios live. The historical decision
> record below is kept as written.

- **What v1 did:** the daemon polled `versions.json` (gateway-first, then
  public mirror), broadcast availability via `daemon_update`, and on apply
  ran the "brutal update" (`update.go` + `handoff.go` + `update_flow.go`:
  clean slot → fetch launcher → spawn `--update-start`, SIGKILL itself,
  copy slot, launcher `--update-end`, promote after first WS connect).
  The launcher executed the swap; the daemon orchestrated it.
- **What the rewrite changed (DECIDED):** the daemon-side orchestration
  (`update.go`, `handoff.go`, `update_flow.go`, manifest polling) was
  deleted with the mutex code — it was deeply coupled to `DaemonServer`
  state (locks, `ActiveSession`, quiesce paths) and would have needed a
  full actor-protocol redesign, not a port. `daemon_update_*` now answers
  authoritative state (`{current: Version, autoUpdate: false}`) so the
  frontend card shows up-to-date instead of erroring (and no
  toast-on-reconnect).
- **What still works:** the launcher (`cmd/launcher`, restored — see D1)
  still fetches, verifies, swaps and supervises any daemon binary. Manual
  update = `build:daemon:all` + launcher swap, same binaries, same
  `dist/` manifest shape (minus the daemon-driven auto-check/apply).
- **Gap, owned:** in-daemon auto-check (10-min poll), availability
  broadcast (`available`/`staged`), one-click apply from the dashboard,
  and the slot A/B handoff are GONE until reimplemented as actor messages
  (a `updateSupervisor` actor driving the launcher over the existing
  protocol is the natural shape — not yet scheduled).
- Do NOT file "daemon_update answers static state" as a bug — file
  missing *launcher-side* behavior (fetch/verify/swap) if it breaks.

### D5. BG jobs are NEVER re-run (side-effect safety beats convenience)

- **DECIDED (§5.3):** a kill can't know what the job was doing — re-running
  a half-done `rm -rf`/migration/deploy is worse than losing the run.
  Killed jobs → `orphaned`, logs preserved, live pids re-adopted via
  pidfile. No re-execution, ever.
- Do NOT file "job not retried after crash" as a bug.

### D6. Watchdog never reaps a possibly-live actor (no dual-writer spawn)

- **DECIDED (F2):** deleting a wedged handle and spawning fresh would put
  two writers on one `.wal.jsonl`. So: passivate keeps the entry mapped
  until `done` closes; watchdog deletes only provably-dead handles;
  `epoch` field exists for incarnation discipline.
- A "reap the wedged goroutine" recommendation contradicts this on
  purpose — Go cannot kill goroutines; the alternative (dual writers) is
  the only true corruption vector. Do NOT file "watchdog doesn't reap" as
  a bug.

### D7. Stuck workers quarantine, they are not force-killed (F3)

- **DECIDED:** after `maxCancelRounds` (4 × 30s ≈ 2min) of ignored context,
  the actor quarantines itself (commit WAL, mark `orphaned`, explicit
  `session_status: orphaned` + route error). A fresh prompt un-quarantines
  (new gen invalidates the stuck worker). Go has no goroutine kill-switch;
  quarantine is the honest terminal state, not silent pinning.
- Do NOT file "no kill-switch" as a bug.

### D8. Tuning numbers are starting points with env overrides (F4)

- **DECIDED:** `cmd/daemon/tuning.go` is the single source (`ICD_*` env
  vars wire every cap/timeout/TTL/budget). Defaults (128/8/256, 15min,
  512MB/64) are explicitly uncalibrated starting points; the bench plan is
  future work, not a ship-blocker.
- Do NOT file "magic numbers" as a bug; file wrong *behavior* with numbers.

### D9. Canonical helpers vs inline timeouts (F5)

- **DECIDED:** `replyWithTimeout` is canonical for plain request/reply.
  `subscribeFinish`/`recentFinish`/`cancelJob` keep inline selects for
  their extra `<-done` arms — forcing the helper would be worse code.
  `envelope.go` documents the rule.
- Do NOT file "helper has zero call sites, delete it" — the comment
  already scopes its use.

### D10. Test seams are test-only and fenced (Decision-4)

- **DECIDED:** `newResumeSnapshot` constructor (no `gen=-1` sentinel);
  `startWorker` substitutable only via `newTestActor`, never reassigned in
  prod paths. Crash coverage is real (`crash_test.go`: helper process +
  `SIGKILL` + WAL replay + resume offer), not just in-process.
- Do NOT file "seam leaks to prod" unless a prod path reassigns it.

### D11. Root watches infra on a loop + snapshot, served on WS (F2 closed)

- Update: `healthSnapshot()` is now served on the socket
  (`{"type":"health"}` → `{type:"health", infra, asOf}`), so dashboards can
  poll without an HTTP surface on the daemon (by design).

### D12. Epoch is enforced, not decorative (report item 1)

- **DECIDED:** `Envelope.Epoch` + actor gate + `workerSnapshot.epoch` +
  `snapshotTurn` discipline. Stale-incarnation mail is dropped; the field
  the report called "dead code" is now the dual-writer guard. Covered by
  `TestEpochDropsStaleWorkerMail`.

### D13. Quarantine path is tested (report item 2)

- **DECIDED:** `TestQuarantinePath` (stuck worker → forced ladder →
  `orphaned` → stale finish ignored → fresh prompt recovers) plus the
  `onWorkerFinished` orphaned-guard the test caught (late exit from a
  quarantined worker changes nothing).

### D14. Tuning vars are wired, not decorative (report item 3)

- **DECIDED:** tickers + stale threshold read `tuneEvictEvery` /
  `tuneWatchEvery`; caps/TTLs/budget/convert-timeout all resolve from
  `tuning.go` (`ICD_*`). `ICD_*` actually takes effect now.

### D15. Singleflight on cold route (report item 5)

- **DECIDED:** `flightGroup` — N concurrent routes for a cold id share one
  load + one spawn (`TestRouteSingleflight`). Documented as sufficient for
  the current profile (1 user, few sessions); revisit if fan-out grows.

### D16. Nits closed (report item 6)

- Timeout-path requeue: drop + `droppedRequeue` counter (no blocking
  goroutine, inbox-first ordering preserved).
- `randomID8`/`randomConvertID`: fallback instead of `panic` on CSPRNG
  failure (crash-worse-than-collision trade, logged).
- `estimateResidentBytes`: stays a heuristic, labeled as such; calibrate
  via perf sim before trusting `ICD_MEM_BUDGET_MB`.

### D17. Prod-clean / dev-trace logging (owner decision)

- **DECIDED:** prod binaries log lifecycle + warnings only. Dev tracing
  (`ICD_TRACE=1` → `<dataDir>/trace/<date>.jsonl`, timestamps, no secrets)
  via `trace()` (no-op when disabled) — see `docs/logging-plan.md`.
  `trace()` is wired at actor dispatch + watchdog quarantine; fuller
  coverage lands with the F4 bench work.

- **DECIDED:** `root.watchdogLoop` (30s) pings bg/projects/ws;
  `healthSnapshot()` serves the last round. No HTTP health endpoint — the
  daemon serves no HTTP by design; recovery of wedged infra is
  restart-scoped (process manager owns it), sessions have their own
  supervisor watchdog.
- Do NOT file "no health endpoint" as a bug; file a missed ping round.

---
*Rewritten 2026-09-24 from full-code read + reviewer decisions. Implemented
fully (V2.0–V2.4 + audit rounds 1–3); §11 locks owner decisions against
re-audit. Change the code or challenge with new evidence — not re-reviews
of closed decisions.*
