# Actor-model migration plan — indirect-code-daemon

Status: **PLAN — for review, no code changes yet.**
Goal: replace cross-goroutine `Mutex` state sharing with actors
(goroutine + mailbox), keeping the same external behavior (WS protocol,
HTTP relay, disk format, WAL semantics).

## 0. Context: what exists today

- `cmd/daemon/main.go` — `DaemonServer`, `ActiveSession`, WS dispatch
  (`handleMessage` holds `configMu.Lock()` for the whole dispatch),
  shutdown, truncate path.
- `cmd/daemon/turn_run.go` — `runAgentTurn`, finalizer, `gen` guard.
- `cmd/daemon/queue.go` — bounded FIFO (cap 30), `mutateQueue` under lock.
- `cmd/daemon/session_wal.go` — WAL (`walWriter` + own `mu`), fused load,
  `commitWAL` (idempotent).
- `cmd/daemon/background.go` — `bgJobs` map under `bgMu`, `doneOnce`,
  `WaitForAnyJob`.
- `cmd/daemon/session_eviction.go` — idle sweep under `evictMu`.
- Sync primitives in use: ~24 declarations (`Mutex`/`RWMutex`/`Once`/
  `WaitGroup`/`atomic`) across 129 `.go` files; lock traffic concentrated
  in `main.go`, `turn_run.go`, `background.go`, `packages/core/agent.go`.

### 0.1 Known risks (audit, 2026-09-24)

1. `handleMessage` holds `configMu.Lock()` for the entire WS dispatch —
   one slow message stalls all others. Fix: parse envelope lock-free,
   lock only where config is mutated.
2. Truncate path (`main.go` ~2271) does disk I/O (`truncateTail`)
   while holding `sessionsMu.Lock()` + `act.mu.Lock()` — a disk stall
   freezes every session lookup. Fix: snapshot under lock, I/O after unlock.
3. `gracefulShutdown` does per-session `commitWAL`/`saveSession` (disk)
   while holding `sessionsMu` + each `act.mu`. Fix: parallel per-session
   commit with `WaitGroup` + timeout, no global lock held during I/O.

These three fixes are **Phase 0** (cheap, no actor needed) and should land
before or alongside the pilot.

## 1. Target architecture

```
root supervisor
├── session supervisor ── session actor × N
├── bg supervisor ── job (goroutine + done msg, NOT a full actor)
├── ws actor (writer, chan outbound cap ~256)
└── config (atomic.Pointer[Config], copy-on-write — NOT an actor)
```

### 1.1 Why this shape (decisions already taken)

- **Job is not an actor and has no watchdog.** A bg job is an OS process
  (bash/python) + a `.log` file. If the process is running, it's running;
  if it exited, `cmd.Wait()` reaps it and a `jobExited` message fires.
  There is no goroutine to wedge and no mailbox to flood, so there is
  nothing for a watchdog to observe. The only liveness question is "did
  the exit notice get lost?", and that is answered structurally: the
  waiter goroutine sends `jobExited` on a channel the bg supervisor
  always receives (control lane), so a lost notice is impossible by
  construction. What gets watched is the **bg supervisor** (a real actor,
  §4).
- **WS actor IS a real actor** (goroutine + `chan outbound`), so it gets a
  watchdog like any other actor (§4). **Config is NOT an actor** — it is an
  `atomic.Pointer[Config]` (copy-on-write): lock-free reads, pointer swap
  on write. No goroutine, no mailbox, no watchdog; there is nothing to
  wedge. A torn-read is impossible by construction (pointer swap is atomic).
- **The actor never blocks its mailbox.** "Paused" is a value in the
  `state` field (`awaitingApproval`), not a blocked goroutine. While
  waiting for a human, the actor keeps processing: transcript chunks flow
  to the frontend, `cancelTurn` is served immediately, watchdog pings
  are answered.
- **Bounded mailboxes + separate control lane** (no unbounded channel).
  Go has no native unbounded chan; hand-rolled ones hide a lock and,
  worse, hide backpressure — a flood looks healthy to the watchdog until
  OOM kills the whole process. Instead: `inbox` (data, bounded, explicit
  busy/drop policy) + `control` (cancel/timeout/watchdog/shutdown, small
  cap, always accepted).

### 1.2 Where mutex survives (and why)

| Lock | Lives where | Why it stays |
|---|---|---|
| WAL `walWriter.mu` | inside session actor's worker | append to shared `bufio.Writer` + file offset; microsecond critical section, buffer copy only, no blocking I/O inside |
| WS emergency write | root/shutdown path | socket is a physical shared resource; actor is the normal owner, a small mutex covers fatal paths outside the actor |
| MCP client, filetrack internals | inside those packages | library-boundary invariants; actors don't cross library borders |
| `sync.Once` (job `done`), `WaitGroup` (shutdown), `atomic.*` (flags, config pointer, counters) | various | not state locks; non-blocking, no deadlock cycles |

Rule: **no lock spans two actors.** Every remaining lock lives inside one
box of the diagram. No shared lock ⇒ no wait cycle ⇒ no deadlock by
construction (today safety depends on acquisition-order discipline).

## 2. Message protocol

### 2.1 Envelope

```go
type Envelope struct {
    SessionID string
    Payload   any      // one of the message types below
    Reply     chan any // nil = fire-and-forget
}
```

- Callers that need a response use `Reply` with `select + timeout`
  (e.g. `select { case r := <-reply: ...; case <-time.After(5*time.Second): busy }`).
  A dead actor surfaces as a timeout (logged + metric), never as a hung caller.
- Producers use non-blocking send on `inbox` (`select/default` → busy/drop
  policy per type, §2.4). Control lane is always accepted.

### 2.2 Session actor — mailbox messages

**Data lane (`inbox`, cap 64–128):**

| Message | From | Effect |
|---|---|---|
| `userPrompt{text, attachments, model}` | ws dispatch | if `state==running` → append to `Queue` (cap 30, else `queue_full` error); else start turn worker |
| `queueOp{op, ...}` | ws dispatch | add/remove/reorder/clear — served only when it doesn't disturb a running turn |
| `transcriptChunk{delta}` | turn worker | forward to ws actor (even while `awaitingApproval`) |
| `toolResult{id, payload}` | turn worker | feed back into the turn's pending tool batch |
| `approvalResponse{id, decision}` | ws dispatch | if `id != state.id` → drop (stale); else resume turn worker |
| `questionResponse{id, answers}` | ws dispatch | same correlation as approval |
| `bgJobFinished{jobID, exit}` | bg supervisor | fold notice into transcript; wake `sleep`-ing turn if it waits on this job |
| `stateTimeout{id}` | self (AfterFunc) | §3 — question → resume with recommended; approval → cancel turn |
| `editRegenerate{keep, ...}` / `forkReq{...}` | ws dispatch | bump local `gen`, cancel worker ctx, truncate, start new turn |
| `tickFlush` | self timer | flush WAL buffer |

**Control lane (`control`, cap 8, always accepted):**

| Message | From | Effect |
|---|---|---|
| `cancelTurn{reason}` | ws dispatch | `cancel()` worker ctx, `state=idle`, discard `awaiting*` |
| `watchdogPing{reply}` | session supervisor | reply `{alive, lastProgress, stateName}` immediately |
| `passivate` | session supervisor | `commitWAL`, close WAL, terminate goroutine (state persists on disk) |
| `shutdown` | root via supervisors | `commitWAL`, terminate |

### 2.3 Session actor — state machine

```
idle ──userPrompt──▶ running ──needsApproval──▶ awaitingApproval{id, timer15m}
 │                      │  ▲                          │ response(id ok) / timeout(question)
 │                      │  │                          ▼
 │                      │  └──── resume ──── running (question: inject recommended + notice)
 │                      │                              (approval timeout: ──▶ idle + notice, queue intact)
 │                      ▼
 │                   cancelling ──worker exits──▶ idle ──queue non-empty──▶ running (promote head)
 └──edit/fork──▶ (gen++, cancel, truncate) ──▶ idle/running
```

- `gen` becomes a **local sequence number** (no lock to guard): every new
  turn bumps it; worker callbacks carry `myGen`; mismatch → no-op.
  Stale `approvalResponse`/`stateTimeout` (wrong `id`) → dropped.
- Only the finalizer path (`running→idle`) promotes the queue head —
  same invariant as today, now enforced by single ownership instead of lock.

### 2.4 Backpressure policy (mailbox full)

| Message class | Policy |
|---|---|
| `userPrompt`, `queueOp` | reply `busy, try again` — honest backpressure to the client |
| `transcriptChunk` | must not happen (producer is our own worker); counter + log, investigate as bug |
| `control` lane | never dropped — separate channel, always received |
| ws actor `outbound` full | drop + counter (slow client must not stall sessions) |

### 2.5 Other actors' protocols

- **Session supervisor:** owns `map[id]chan Envelope`. Handles
  `route{sessionID, env}` (spawn-on-demand + replay disk/WAL if absent),
  `tickEvict` (idle → `passivate`), `heartbeat` collection, `shutdown`.
- **BG supervisor:** a real actor (goroutine + mailbox) owning
  `map[jobID]handle`. Handles `bgStart`, `bgList` (reply with snapshot
  copy), `bgCancel{id}`, `bgRead{id}`, `jobExited{id}`. Forwards
  `bgJobFinished` to the owning session actor's inbox. Watched by root (§4).
- **WS actor:** a real actor (goroutine + `chan outbound` cap ~256).
  Handles `send{msg}`, `broadcast{collection-ping}`,
  `closeAndReplace{conn}`. Emits nothing back except drop counters.
  Watched by root (§4).
- **Config:** NOT an actor. No goroutine, no mailbox, no watchdog. Readers
  `cfg := configPtr.Load()`; writers build a new `Config` value and
  `configPtr.Store(&new)`.

## 3. Timeout semantics (decided: 15 min per request)

- Timer is armed on entering `awaitingApproval`/`awaitingQuestion` via
  `time.AfterFunc(15min, func(){ inbox <- stateTimeout{id} })` and stopped
  on leaving the state. Timeout is a normal message: whoever reaches the
  mailbox first (response or timeout) wins; the loser finds a mismatched
  `id` and is dropped. No race between "answer arrived" and "timer fired".
- **Question unanswered in 15 min:** inject `recommended` answers,
  resume the turn, emit a system transcript notice:
  `"User didn't respond in 15min — proceeding with recommended."`
  Queue untouched, turn continues.
- **Tool approval unanswered in 15 min:** cancel the turn (`cancel()` worker
  ctx, `state=idle`), emit a system transcript notice:
  `"Approval timed out after 15min — turn cancelled."`
  Queue **intact** — next user message or queue promotion starts a fresh turn.
  Local `gen++`, so a late approval is discarded by id mismatch.
- Timeout is **per request, not per turn**: three approvals answered at
  14 min each legitimately extend the turn to 42 min — that is progress,
  not stall.

## 4. Watchdog ("tô vivo")

Principle: **every actor (goroutine + mailbox) is watched; anything that is
not an actor is not watched.** That gives:

| Component | Actor? | Watched? | How |
|---|---|---|---|
| Session actor | yes | yes, by session supervisor | ping → `{alive, lastProgress, stateName}` (§4.1) |
| Session supervisor | yes | yes, by root | ping → `{alive, children, queueDepth}` (§4.2) |
| BG supervisor | yes | yes, by root | ping → `{alive, jobs, queueDepth}` (§4.2) |
| WS actor | yes | yes, by root | ping → `{alive, queueDepth, dropCounter}` (§4.2) |
| BG job | no (OS process + `.log`) | no | exit notice is structural (`jobExited` on a control lane that can't be lost); nothing to wedge |
| Config | no (`atomic.Pointer`) | no | pointer swap is atomic; nothing to wedge |
| Root | top of chain | yes, from OUTSIDE the process | systemd/docker/launchd + health check (§4.3) |

### 4.1 Session actor (full 3-level watchdog)

- Each session actor reports on `watchdogPing`: `{alive, lastProgressUnixMilli,
  stateName}`. `lastProgress` advances on any useful message (prompt, chunk,
  tool result, response) — not on the ping itself.
- Supervisor policy:
  - **No reply to ping** → goroutine wedged: kill + respawn from disk/WAL.
  - **Alive, stale `lastProgress`, `state==awaitingApproval/Question`** →
    normal (human may take hours; the 15-min timer in §3 bounds it anyway).
  - **Alive, stale `lastProgress`, `state==running`** → wedged turn
    (provider/tool silence): first `cancel()` the worker ctx; kill the actor
    only if it ignores cancellation.

### 4.2 Supervisors + WS actor (light watchdog)

Small protocol, so a light ping suffices: `{alive, queueDepth}` (+ `jobs`
for bg supervisor, `dropCounter` for ws actor). Root policy:

- **No reply** → actor wedged: restart it. Restarting a supervisor is cheap:
  session supervisor rebuilds `map[id]inbox` on demand (spawn-on-lookup +
  disk/WAL replay); bg supervisor rebuilds by scanning live job handles;
  ws actor just reopens `outbound` (in-flight messages during restart are
  dropped + counted — clients re-pull snapshots via the existing
  `{type:"pull"}` mechanism).
- **Reply, `queueDepth` grows unboundedly across rounds** → actor drowning
  (producer bug or flood): log + alert, apply backpressure policy (§2.4),
  do NOT restart blindly (restart wouldn't fix the producer).
- **WS `dropCounter` rising** → slow client or producer loop: log + alert.

### 4.3 Root (watched from outside)

The root has no parent inside the process. It is watched by the process
manager (systemd / docker / launchd) plus a health endpoint that reports
"did all supervisors answer the last ping round?". Root-internal waits
(shutdown `WaitGroup`) all carry deadlines and log which child didn't
answer — no infinite wait inside the process.

## 5. Migration plan (phases + gates)

**Phase 0 — cheap lock fixes (1–2 days, no actor).**
P0.1 Dispatch: parse WS envelope without `configMu`; lock only on config
mutation paths. P0.2 Truncate: snapshot needed state under lock, release,
then do `truncateTail` I/O. P0.3 Shutdown: per-session `commitWAL` in
parallel (`WaitGroup` + timeout), no global lock held during I/O.
*Gate: `bun test` green, `go test ./...` green, `go test -race ./...` clean.*

**Phase 1 — pilot: session actor + session supervisor (main work).**
P1.1 Add `cmd/daemon/actor_*.go` (new files, no edits to old paths):
envelope, session actor loop, supervisor, state machine, 15-min timers,
dual-lane mailbox. P1.2 Adapt `runAgentTurn` into a worker: it already
takes `ctx`; reroute its state mutations (`BeforeRequest`, `OnChange`,
finalizer) into `inbox` messages instead of direct `act.mu` writes.
P1.3 Dual-run flag: route a configurable subset of sessions (env var,
default off) through the actor path; rest stay on the lock path.
*Gate: parity tests — same scripted WS conversation on both paths produces
identical disk state + transcript; `-race` clean; cancel/approval/eviction/
restart-via-WAL covered.*

**Phase 2 — bg supervisor + ws actor + atomic config.**
P2.1 Move `bgJobs` map into bg supervisor; jobs report via messages.
P2.2 WS writes through ws actor; `wsMu` shrinks to the emergency path.
P2.3 Config behind `atomic.Pointer`.
*Gate: same as P1 + bg e2e script
(`scripts/test-indirect-bg-e2e.ts`) green on the actor path.*

**Phase 3 — cutover + removal.**
P3.1 Actor path becomes default; lock path behind flag for one release.
P3.2 Delete `act.mu`, `sessionsMu`, `bgMu`, `pingMu`, `evictMu`,
`gen`-as-lock-guard; keep WAL/`walWriter.mu`, `Once`/`WaitGroup`/`atomic`,
library-internal locks.
*Gate: full suite (`bun test`, `go test ./... -race`, relevant Playwright
component scripts) green with the flag removed.*

**Rollback:** every phase keeps the previous path working behind a flag
until the next phase's gate passes. Disk format and WS protocol never
change, so rollback is a restart with the flag flipped.

## 6. Test strategy

- `go test -race ./...` from `indirect-code-daemon/` on every phase
  (today: confirm it is in CI; if not, add it in Phase 0).
- New `actor_*_test.go`: state-machine unit tests (approval timeout →
  idle; question timeout → recommended; stale id dropped; queue promotion
  only via finalizer; passivate/respawn replays WAL).
- Parity harness: scripted conversation (prompt → tool approval → question
  → cancel → bg job → evict → restart) run against both paths; diff disk
  state + transcript.
- Existing gates unchanged: `bun test`, Go tests, Playwright component
  scripts; full-stack bg e2e stays a manual gate.

## 7. Open items for reviewer

1. Turn worker placement: **worker-daughter goroutine** (recommended —
   minimal rewrite of `runAgentTurn`) vs. turn inline in the actor loop.
2. `inbox` capacity 64–128 — acceptable, or tune after first load numbers?
3. Question payload must carry `recommendedIndices` for the timeout path —
   confirm the provider/agent layer always supplies them (fallback if absent:
   first option? abort turn?).
4. Confirm 15-min values and the two notice strings (§3) are final.

---
*Written 2026-09-24. Reviewer: approve / request changes per §7 before any
Phase 1 code is written.*
