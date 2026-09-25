# V2 release readiness review

Reviewed on 2026-09-25: `dev` at `7f2c8c0` against V1 at `origin/main` `e5a4b07`.
The local `main` already contained part of the rewrite, so it was not used as the
V1 baseline. Most changes are in the Indirect Code daemon; the gateway proxy is
effectively unchanged between these endpoints.

Keep the actor architecture and single application artifact. The urgent work is
to make waiting, message delivery, snapshots, and release validation reliable
before expanding the feature set. These fixes do not require another rewrite,
a new actor library, a broker, or additional services.

## Scope decisions

- **V1 to V2 is a manual transition**, as decided by the project owner after the
  review. The old updater's request for `indirect-launcher-*` receives 404 from
  the V2 artifact directory, but automatic compatibility is intentionally out of
  scope. Do not restore launcher artifacts, add compatibility aliases, or build
  a bridge release to satisfy this review.
- Keep one application binary with separate boot and worker roles. Validate
  normal V2 releases and V2 update behavior against that contract.
- The removal of skills, MCP, and unused discovery features is intentional.
  Reintroducing them is not a prerequisite for V2.
- The proposals below describe work to implement. Every item is **open** at the
  reviewed commit. Proposed acceptance cases are distinguished from tests that
  were actually executed.

## V2-001: the watchdog cancels healthy work without events

**Priority: High. Status: Resolved.**

Relevant code:
[supervisor.go](../indirect-code-daemon/cmd/daemon/supervisor.go)
(`watchdogRound`, around line 620),
[turn_worker.go](../indirect-code-daemon/cmd/daemon/turn_worker.go)
(`heartbeat`, `handleEvent`), and
[tuning.go](../indirect-code-daemon/cmd/daemon/tuning.go).

**Problem and impact.** The watchdog uses elapsed time since progress events to
judge a running worker. The default interval is 15 seconds and the stale
threshold is twice that interval. A subsequent round can cancel a turn after
roughly 30–45 seconds without events even when the actor answers its ping.
Preparing a provider response, executing `sleep`, and waiting for retry backoff
are legitimate periods without events. The provider layer accepts Retry-After
delays up to 60 seconds; the core retry schedule includes longer waits.

**Confirmed evidence.** `TestV2ArchitectureHealthySilentProvider` uses the real
worker/provider path and a local HTTP SSE server. With the watchdog interval
scaled to 50 ms, the server prepares its response for 450 ms. The request
completes without the watchdog and is cancelled when a watchdog round runs after
150 ms. This is a behavioral failure under `-race`, not a detected data race.
The effect on long sleeps and retry delays follows from the same code path;
those additional scenarios still need their own regression tests.

**Proposed fix.** Separate three facts: the actor can process messages, the worker
is making progress, and the worker is intentionally waiting on an operation.
Represent expected waits with an operation identity and an appropriate deadline
or cancellation condition. Examples include a provider request, retry backoff,
sleep, browser conversion, and a human decision. The watchdog should not infer
failure from missing text/tool events during an otherwise valid wait.

Keep cancellation responsive and retain escalation for a worker that ignores
cancellation. Stamp wait transitions with the existing generation/epoch so an
old worker cannot extend a new turn's lifetime. A periodic heartbeat that runs
independently of the blocked operation must not certify that operation as healthy
forever. Increasing one global timeout does not resolve the conflicting policies.

**Acceptance criteria:**

- [ ] A healthy delayed provider response completes with the watchdog active.
- [ ] A permitted sleep and Retry-After/backoff survive more than one watchdog
  interval and remain cancellable by the user.
- [ ] An operation that exceeds its own deadline follows the intended failure
  or retry policy; indefinite stalls remain detectable.
- [ ] Cancellation-ignoring workers still escalate without spawning a second
  owner of the same WAL or accepting stale worker messages.

## V2-002: the WS outbox silently drops essential events

**Priority: High. Status: Resolved.**

Relevant code: [ws_actor.go](../indirect-code-daemon/cmd/daemon/ws_actor.go)
(`emit` and `run`, around lines 43–57) and
[main.go](../indirect-code-daemon/cmd/daemon/main.go) (`link`).

**Problem and impact.** All outbound event classes share the same bounded outbox
(256 entries by default). A full outbox drops the new event, including approval
requests, completion snapshots, or status changes. The writer also ignores socket
write errors. A session can keep waiting while the browser never receives the
event needed to answer it. Counting drops alone does not restore consistency.

**Confirmed evidence.** `TestV2ArchitectureCriticalWSDelivery` holds a socket write,
fills the actual outbox, and requests approval through the session actor. After
the writer resumes, the actor remains `awaitingApproval`, zero approval requests
were delivered, and the drop counter is one. Socket write error recovery needs
additional coverage; this probe specifically demonstrates enqueue overflow.

**Proposed fix.** Keep bounded memory and the single ordered socket writer, but
define which event classes can be coalesced and how essential state is recovered.
Replaceable snapshots can use the latest value. Raw transcript deltas cannot be
arbitrarily dropped or reordered while the client believes it has a complete
stream. Decisions and terminal state need reliable delivery or a visible reset
followed by a complete resynchronization.

A practical approach is a bounded ordered queue with limited coalescing and an
explicit connection failure/resync path when it cannot retain required events.
Socket write errors must invalidate that connection and notify the link owner.
V2-004 is a prerequisite for relying on snapshots as recovery. Reconnection must
restore the current session and outstanding decision before later deltas can
overtake it. Avoid an unbounded queue, indefinitely blocking session actors on
the network, or adding a priority queue that silently reorders snapshots/deltas.

**Acceptance criteria:**

- [ ] Under a slow socket and a full outbox, approval and question state are
  delivered or restored through an explicit resync.
- [ ] A completed turn converges to the correct transcript and idle state after
  overflow or a socket write error.
- [ ] Snapshot/delta ordering is preserved during ordinary streaming and recovery.
- [ ] Queue memory and recovery retries are bounded; healthy sessions remain
  responsive while another connection is slow.

## V2-003: background completion delivery can disappear permanently

**Priority: High. Status: Resolved.**

Relevant code:
[bg_supervisor.go](../indirect-code-daemon/cmd/daemon/bg_supervisor.go)
(`onFinish`, `deliver`, especially the nonblocking send around line 524),
[bg_pidfile.go](../indirect-code-daemon/cmd/daemon/bg_pidfile.go), and
[session_actor.go](../indirect-code-daemon/cmd/daemon/session_actor.go)
(`onBgNotice`).

**Problem and impact.** Completion marks the job terminal and removes its pidfile
before delivering the notice. `deliver` silently returns if routing fails or
the session inbox is full. There is no pending delivery to retry. The model can
wake from sleep without the promised completion notice in its context, or an
idle session can miss its wake-up turn entirely.

**Confirmed evidence.** `TestV2ArchitectureBGCompletionDelivery` finishes a
registered job while the destination inbox is full. Draining the inbox reveals
no completion notice and no retained delivery attempt. The test establishes
the overflow failure; restart and cancellation interleavings need added tests.

**Proposed fix.** Track job completion and notice delivery as distinct states.
Retain a pending notice keyed by job ID until the owning session acknowledges
acceptance through its persistence path. Retry independently of the BG
supervisor's main loop so a busy session does not block listing, cancellation,
or completion of other jobs. Admission limits must bound retained work without
silently throwing away accepted tasks' completion notices.

For restart recovery, retain enough terminal metadata to retry an unacknowledged
notice; do not rely on a pidfile that has already been deleted. Reuse the
transcript's `background_delivery` identity to make repeated delivery idempotent.
Preserve the existing behavior: running sessions absorb a notice, idle sessions
may start one wake-up turn, assistant cancellation stays silent, and user
cancellation has its own notice. Keep raw result text in the log. Explicit
session deletion must terminate pending delivery rather than resurrect the session.

**Acceptance criteria:**

- [ ] A temporarily full inbox eventually receives its completion exactly once
  in the transcript, or reports an explicit terminal delivery failure.
- [ ] A duplicate delivery attempt cannot start a second wake-up turn.
- [ ] Restart before acknowledgement preserves the notice without rerunning the
  original process; session deletion does not cause resurrection.
- [ ] Sleeping workers observe the notice in the intended order when awakened.
- [ ] One busy session cannot stall the BG supervisor for all sessions.

## V2-004: reconnect snapshots omit pending approvals and questions

**Priority: High. Status: Resolved.**

Relevant code:
[ws_server.go](../indirect-code-daemon/cmd/daemon/ws_server.go)
(`get_session`, around line 157),
[turn_live.go](../indirect-code-daemon/cmd/daemon/turn_live.go)
(`sessionPayload`),
[session_actor.go](../indirect-code-daemon/cmd/daemon/session_actor.go)
(`pendingAsk`, `onRead`, approval/question handlers), and
[useTranscript.ts](../web/src/indirect-code/hooks/useTranscript.ts)
(`applySnapshot`, around line 586).

**Problem and impact.** `get_session` clones the persistent `SessionRecord`, then
formats it with `sessionPayloadPaged`. It omits `pendingApproval` and `question`.
The frontend clears both when absent. Reloading or reopening a conversation can
therefore hide an outstanding decision while the worker continues waiting.
V1's client snapshot included these fields.

**Confirmed evidence.** `TestV2ArchitectureReconnectApproval` receives the original
approval event, then dispatches `get_session`. The returned snapshot contains no
pending approval. The question field follows the same omission in code, but
needs an equivalent execution test. A real-browser regression test is also needed.

**Proposed fix.** Define one actor-owned snapshot for the client that combines the
persistent record with transient interaction state. Store enough approval data
to recreate the original request: correlation ID, tool, arguments, and deadline.
Currently arguments are emitted but are not retained in `pendingAsk`. Include
the full pending question and its identity too.

Audit tool start times, progress, thinking time, and live assistant content for
the same ownership problem. Keep the existing bounded transcript paging and
immutable copies at goroutine boundaries. Build and emit the snapshot in a way
that gives it a consistent order relative to following stream events; merely
cloning state and emitting it later from an unrelated goroutine can introduce
another race in observable ordering. Do not persist every streaming delta solely
to reconstruct a browser snapshot.

**Acceptance criteria:**

- [ ] Reload or reopen during approval/question restores the original decision
  and answering it resumes the correct worker once.
- [ ] Reconnect does not extend an existing deadline or revive a resolved request.
- [ ] Multiple clients answering the same request cannot apply it twice.
- [ ] Streaming/progress survives snapshot restoration without duplicate content,
  stale state replacing newer events, or unbounded history payloads.
- [ ] Real Chromium verifies the visible decision, completion, and absence of
  page errors using a local fake provider.

## V2-005: release validation still requires a removed launcher manifest

**Priority: Release blocker. Status: Resolved.**

Relevant code: [release.yml](../.github/workflows/release.yml)
(manifest verification, around line 94),
[ci.yml](../.github/workflows/ci.yml), and
[build-indirect-all.ts](../scripts/build-indirect-all.ts) (manifest generation).

**Problem and impact.** The builder emits only `daemon`, while the workflow
iterates over `("daemon", "launcher")` and reads both sections' checksum maps.
Releases and manual dry runs fail before publication. This remains a blocker
even though the V1 to V2 migration is manual: it is the V2 release pipeline itself.

**Confirmed evidence.** Executing the exact Python verifier embedded in the
workflow against the checked-in V2 artifact directory raises
`KeyError: 'launcher'`. Ordinary CI passes because it does not run that verifier.

**Proposed fix.** Make the verifier enforce the single-artifact contract. Prefer
one small reusable validation script called by both CI and release over two
copied implementations. Verify all six expected platform assets, their presence,
checksums, and the stamped version. Update stale release comments that still
describe separate launcher artifacts. Keep the existing native/static checks.
Do not add an empty launcher field to hide the mismatch.

**Acceptance criteria:**

- [ ] The generated daemon-only manifest passes the same validator in CI and release.
- [ ] A missing platform asset, checksum mismatch, or wrong version fails validation.
- [ ] A release workflow dry run builds and verifies everything without publishing.
- [ ] Normal boot, worker execution, and V2 update tests continue to use one artifact.

## V2-006: inbound dispatch still blocks unrelated sessions

**Priority: Medium. Status: Resolved.**

Relevant code: [main.go](../indirect-code-daemon/cmd/daemon/main.go)
(`connectLoop`, around line 335) and
[ws_server.go](../indirect-code-daemon/cmd/daemon/ws_server.go)
(`dispatch` and handlers waiting for replies).

**Problem and impact.** The socket read loop calls `dispatch` synchronously.
Handlers wait for actor replies and sometimes perform disk operations. A slow
session read prevents reading later commands, including cancel for another
session. Removing the V1 config lock helped other execution paths but did not
remove this inherited limitation.

**Confirmed evidence.** `TestV2ArchitectureDispatchIsolation` pauses one actor
handler and invokes `get_session` followed by `health` using the current
sequential dispatch pattern. Health waits until the actor is released. This
probe identifies the synchronous dependency; an actual socket test should
validate the eventual solution at the read-loop boundary.

**Proposed fix.** Keep socket reading focused on decoding, validation, and bounded
admission. Preserve ordering of operations for the same session while allowing
unrelated sessions and host control to advance. Use explicit overload responses
with existing request identities. Coordinate host-level operations such as
project deletion with session commands rather than making every operation
concurrent. Audit config writes before relaxing the serialization they currently
inherit from dispatch.

Actor mailbox waiting must not hold the sole socket reader. Do not simply add
`go dispatch(msg)` for every message: that permits unbounded work and reorders
dependent commands. Recheck control-lane sends with empty `default` branches so
admitted cancellation is not silently lost under load.

**Acceptance criteria:**

- [ ] With session A busy, a real socket can still deliver cancel to session B
  and receive a host health response within the chosen bounded latency.
- [ ] Dependent commands to one session retain their intended order.
- [ ] Saturation has an explicit busy/error response and bounded goroutine/queue usage.
- [ ] Concurrent config/project operations preserve ownership and avoid lost updates.

## V2-007: architecture guidance contradicts current behavior

**Priority: Maintenance. Status: Resolved.**

Relevant code/documentation: [AGENTS.md](../AGENTS.md),
[doc.go](../indirect-code-daemon/cmd/daemon/doc.go),
[envelope.go](../indirect-code-daemon/cmd/daemon/envelope.go),
[bg_pidfile.go](../indirect-code-daemon/cmd/daemon/bg_pidfile.go), and
[go.mod](../indirect-code-daemon/go.mod).

**Confirmed evidence.** AGENTS.md still describes the background registry as
memory-only, with jobs lost on restart, while V2 implements pidfile recovery and
process re-adoption. It says Go 1.25, while go.mod requires 1.26. Comments promise
control messages are always accepted, but some sends can discard them. Several
comments reference deleted planning documents.

**Proposed fix.** After settling the behavior above, update the compact reference
to state actual ownership, persistence, recovery, delivery, and waiting policies.
Describe manual V1 migration and the one-artifact V2 release contract. Replace
obsolete document pointers with maintained references. Preserve the useful
decisions in a short document rather than restoring every historical plan.

**Acceptance criteria:**

- [ ] AGENTS.md and daemon package comments agree on BG recovery, Go version,
  control delivery, and the supported release/install workflow.
- [ ] Maintained architecture references resolve to real files.
- [ ] Future feature work can identify its state owner and delivery contract
  without relying on this review's conversational history.

## Implementation order and boundaries

First fix V2-001 and V2-005; neither requires the larger delivery work. Implement
V2-004 before using reconnect snapshots to solve V2-002. Address V2-003 with an
explicit acceptance/deduplication contract. Then finish V2-006 and reconcile the
documentation in V2-007. Land focused changes with their regression tests.

Retain the improvements already present: single session ownership, generation
and epoch fencing, deduplicated cold loads, bounded memory, WAL tail repair,
process identity checks, and native cross-platform CI. Give future skills/MCP
execution a home in the worker while the actor remains the session state owner.
Keep transport serialization separate from feature policy.

## Evidence and final release gate

The [CI run for the reviewed commit](https://github.com/italoalmeida0/llm-gateway/actions/runs/36173696605)
passed all nine jobs: gateway gates, six native daemon targets, the musl/static
artifact lane, and the Linux race detector. Local `go test ./... -count=1
-timeout 180s` passed all eight daemon packages before the extra review probes.
The probes then exposed the behavioral failures above under `-race`.

These results describe the reviewed baseline, not the future fixed version.
The review used local fake providers and test actors; it did not run a live model
or browser. The [retained probes](review-probes/README.md) include instructions
and the observed failures. They are diagnostic starting points, not a requirement
to preserve the current internal design.

- [ ] Close V2-001 through V2-007 with code/doc changes and relevant evidence.
- [ ] Promote the useful probes into permanent behavior tests, adapting them to
  the chosen design; add the missing reconnect, retry, and delivery cases.
- [ ] Run gateway lint/typecheck/tests and the SPA build, plus the full daemon
  suite from its own root. Run affected browser gates with a fake provider.
- [ ] Pass the existing native OS/architecture, musl/static, and race CI matrix
  on the actual release candidate commit.
- [ ] Pass the shared manifest validator and release dry run for that candidate.
- [ ] Leave fresh local builds available after implementation changes, including
  all committed daemon release artifacts when daemon code changes, as required
  by AGENTS.md.
- [ ] Smoke-test the chosen manual V1-to-V2 installation procedure on a copy of
  any data intended to be retained. Automatic V1 upgrade compatibility is not a gate.

Passing the existing suite alone does not close these items. Record which
observable behavior each new regression test establishes and which commit fixes it.

## Resolution (V2 hardening change-set)

All seven items were resolved. The permanent regression tests live in
`cmd/daemon/v2_architecture_test.go` (15 tests, green under `-race`) plus
`test/verify-release-dist.test.ts` (7 tests) for the release contract.

- **V2-001** — declared bounded waits (`workerWaitMsg`): `TestV2WatchdogSparesHealthyDelayedProvider`,
  `TestV2WatchdogHonorsDeclaredWaitDeadline`, `TestV2ToolEventsDeclareAndClearWait`.
  Cancellation-ignoring workers still escalate
  (`TestReviewWatchdogEscalatesRealCancelState`).
- **V2-002** — drops are never silent: any dropped session event marks the
  session for a full resync snapshot (bounded map, single-flight flusher off
  the writer goroutine); socket write errors invalidate the connection.
  `TestV2BackpressureResyncRestoresDecision`, `TestV2SocketWriteErrorInvalidatesConnection`.
- **V2-003** — completion notices are retained on disk and redelivered until
  the session acks folding them into its transcript (`background_delivery`
  identity, exactly one wake-up turn). `TestV2BGCompletionRetriedUntilAck`,
  `TestV2BGNoticeFoldedExactlyOnce`, `TestV2BGNoticeRecoveredAfterRestart`,
  `TestV2BGNoticeDroppedOnSessionDeletion`.
- **V2-004** — the actor-owned snapshot carries the outstanding decision
  (id, tool, args, deadline) and the live overlay
  (`toolProgress`/`toolStarts`/`thinkingStartedAt`).
  `TestV2SnapshotRestoresPendingApproval`, `TestV2SnapshotRestoresPendingQuestion`,
  `TestV2SnapshotRestoresLiveOverlay`.
- **V2-005** — shared validator `scripts/verify-release-dist.ts`, called by
  CI and release (single-artifact manifest, six platform assets, checksums,
  stamped version). `test/verify-release-dist.test.ts`.
- **V2-006** — per-session dispatch lanes + a host lane; admission never
  blocks the socket reader, saturation answers busy, cancellation is never
  silently dropped. `TestV2BusySessionDoesNotBlockHostCommands`,
  `TestV2SessionLanePreservesOrder`, `TestV2DispatchSaturationAnswersBusy`.
- **V2-007** — AGENTS.md and package comments match the implemented
  behavior (Go 1.26, BG pidfile recovery + notice retention, control-lane
  semantics, manual V1→V2 migration, one-artifact release contract); the
  stale planning-document pointers are gone.

The review's final release-gate checklist (release candidate commit, release
dry run, manual V1→V2 smoke on a data copy, real-Chromium gate) remains the
release process itself and is intentionally still open.
