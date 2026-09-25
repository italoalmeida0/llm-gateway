# Daemon actor rewrite review — 2026-09-25

**Verdict: keep the architectural direction, but do not release the current implementation yet.** The rewrite creates useful ownership boundaries, but it currently regresses ordinary workflows and has reproducible process-crash and data-loss paths. These are implementation failures, not reasons to abandon actors or restore the deliberately removed features.

Scope: after `git fetch origin`, compare remote `f46d0baba96f41fc1301caf264dcd7a55adfced1` with local `534db693ab47b9d8bfc0e282679818081c59a144` (10 unpushed commits). Also inspect the pre-existing untracked `cmd/daemon/review_probe_test.go`. Read both `docs/actor-migration-plan.md` and `docs/logging-plan.md`, including the locked decisions. Production source, release binaries, and the existing untracked test were not edited during this review.

## Evidence and limits

The tracked HEAD passed `go test ./... -timeout 120s`, `go test -race ./... -timeout 180s`, and `go vet ./...` in an isolated source export. The workspace passed `bun run lint` and `bun run typecheck`.

Built the remote and local daemon sources into separate temporary binaries. Ran the same external WebSocket commands against each, using a localhost gateway/provider fixture. This exercises real child processes, JSON serialization, the socket dispatcher, actors/workers, HTTP provider requests, and disk persistence. No paid model or real credentials were used.

| Identical boundary scenario | Remote version | Local version |
| --- | --- | --- |
| Rename an idle session, then pull the session mirror | New title returned | Old title returned |
| Upload a text attachment and prompt with its ID | Sentinel reaches provider request | Sentinel absent |
| Request `/compact` after six short turns | Compaction event; command not sent as normal prompt | No compaction; `/compact` sent as normal prompt |
| Approve a read tool using the emitted `callId` | Tool/turn advances | Turn stays waiting |
| Request an interactive question | `question.id` present | `question.id` absent |

Also added 15 focused test functions **only in the temporary export**. They assert intended behavior and fail on HEAD, including two independent sleep-crash cases and three persistence cases. Running these probes with `-race` reproduced the semantic failures without a race-detector report. Several probes deliberately drive state transitions or inject a disk failure; their scope is identified below rather than presented as full application tests.

Evidence files in this directory:

- `daemon-actor-boundary.ts.txt`: external before/after runner.
- `daemon-actor-boundary-results.jsonl`: observed comparison results.
- `daemon-actor-probes.go.txt`: focused Go probes, excluded from the application test suite.
- `daemon-actor-probe-results.txt`: final probe output with `-race`.

Not performed: real-model end-to-end browser flows, cross-platform execution, production load calibration, or an exhaustive audit of every retained tool. The findings below do not depend on those missing checks.

## Findings

### 1. P1 — The restored launcher cannot start the new daemon

`cmd/launcher/main.go:159` unconditionally adds `--slot` to ordinary daemon launches. The flag declarations in `cmd/daemon/main.go:47` removed it. Both a fresh HEAD build and the committed Linux release binary exit with code 2 and `flag provided but not defined: -slot`. The remote build accepts the same argument.

Minimal reproduction: `indirect-code-daemon/dist/indirect-code-linux-amd64 --slot a --version`. Parsing fails before configuration or gateway connectivity matters. The normal launcher uses the same unsupported argument, so this is a startup blocker for the supported installation path.

The launcher update path also still passes removed update flags (`cmd/launcher/update.go:93`). Reconcile the actual launcher/daemon command-line contract and test the shipped pair together. Accepting `--slot` is necessary for normal startup; it does not by itself establish update-path compatibility. This respects D4's accepted removal of daemon auto-update orchestration: the finding concerns the retained launcher, which D1 explicitly promises to preserve.

### 2. P1 — Background completion can panic the entire process

`bg_supervisor.go:323` registers the same sleep channel on every running job in a session. `onFinish` at line 243 closes it once through the finishing job, then closes it again through another job's subscriber map. `onCancel` has the same ownership problem.

Two deterministic reproductions:

- Register two jobs, subscribe one sleep, finish either job: `close of closed channel`.
- Register one job, let the sleep end first through `hostDone`, then finish that job: the same panic. The completed sleep remains registered even though its channel has already closed.

The focused tests recover the panic to report it; production does not recover this supervisor panic, so it terminates the daemon. This does not require overload. The previous implementation used a per-subscription `sync.Once` for all wake paths.

Fix ownership at the subscription level: one close operation, one owner, and explicit removal when a sleep ends. Putting a `sync.Once` only around one of several independent close paths does not solve it.

### 3. P1 — Both human-interaction wire contracts regressed

**Approvals:** `turn_worker.go:404` generates an internal random waiter ID, while `session_actor.go:1116` sends the tool's different `callId` to the browser. `ws_server.go:694` returns that public `callId`; `onApprovalResponse` compares it with the internal waiter ID. A correct browser response is therefore discarded as stale. The real before/after test confirms the remote proceeds and HEAD does not.

**Questions:** `session_actor.go:1129` emits the ID at the top level as `questionId`, but the unchanged frontend reads `question.id` (`web/src/indirect-code/hooks/useTranscript.ts:112`). With no pending question, its initial equality guard compares `undefined` with `undefined` and returns before displaying the new questionnaire. Even without that guard, its response would have no usable question ID. The external test confirms the missing nested ID.

Preserve the actual frontend envelope and use one explicit correlation mapping across the boundary. Existing approval tests retrieve the private pending ID through `hookMsg`, which bypasses the broken public contract and explains their green result.

### 4. P1 — Changing live access to “ask” does not enforce approval

`beforeRequest` refreshes model/options from the actor, but `approveTool` still reads the original `w.snap.options` (`turn_worker.go:404`). A turn started with full access continues approving tools automatically after the user changes its access to ask. The converse can keep requesting approval after access is granted.

The probe starts with full access, applies the real `configureMsg`, calls the real `beforeRequest`, then requests a bash approval. It still returns allowed immediately. The previous `toolApprovalHook` read the live session policy before each tool.

Authorization decisions need current actor-owned policy, including revalidation after a human wait. Updating only the tools advertised to the model is insufficient to enforce execution permissions.

### 5. P1 — Cancellation can lose its terminal message, and the watchdog cannot recover it

`runTurnWorker` (`turn_worker.go:102`) selects between delivering `workerFinishedMsg` and `<-ctx.Done()`. After ordinary cancellation both may be ready, so the terminal message can be discarded even when the inbox has room. The isolated terminal-path probe repeatedly reproduced roughly half the notifications being lost. This is not an estimate of the percentage of real user turns affected; it demonstrates the competing-ready-cases behavior directly.

`doCancel` changes the actor to `cancelling`, but `watchdogRound` escalates only `stateRunning` (`supervisor.go:596`). A worker that ignores cancellation, or an actor that never receives the dropped finish, therefore remains cancelling. Six actual watchdog rounds in the probe never reached quarantine.

Deliver lifecycle completion independently from the cancelled work context, bounded by actor lifetime; include cancelling in the escalation ladder. `TestQuarantinePath` currently sets counters and calls the quarantine path directly, so it proves the final transition but not that the supervisor can reach it. No goroutine kill-switch or reaping of possibly-live actors is proposed.

### 6. P1 — A failed commit allows the next turn to overwrite the recovery WAL

After three failed commit attempts, `finishTurn` (`session_actor.go:627`) clears the WAL handle, marks the session idle, and permits another prompt. `startTurnWithMeta` creates the next WAL through `openWAL`, which uses `O_TRUNC`.

The fault-injection probe makes the committed session file unreadable as JSON, finishes a turn, and sends another prompt. The second prompt is accepted and replaces the first turn's recovery WAL. Thus “keep the WAL for next boot” is not preserved once work continues.

The previous finalizer returned on persistent commit failure and retained recovery state. This is also explicitly promised by plan section 5.1. Keep the actor in a recoverable, non-admitting state until durability succeeds, or use separate durable per-turn logs that cannot overwrite the failed commit. Likewise, a failure to open a WAL should not silently launch an unjournaled turn.

### 7. P1 — Selected attachments never reach ordinary new turns

`startTurnWithMeta` receives attachment IDs, but `snapshotTurn` (`turn_worker.go:71`) does not copy them into `workerSnapshot.attachIDs`. `buildTurnPrompt` subsequently sees an empty selection. Uploading the bytes successfully is therefore not enough.

The focused snapshot probe confirms the missing IDs. More importantly, the external comparison uploads a text file, prompts with its returned ID, and inspects the real outgoing provider request: the remote includes the sentinel content, HEAD omits it. This affects ordinary fresh turns and queued attachment prompts.

Carry the selected IDs through the turn-start snapshot and test images/text at the provider request boundary. The same constructor also omits `lastDate`/`lastMode`; those cause repeated directives, but the missing attachment content is the release-blocking consequence.

### 8. P2 — Acknowledged metadata changes are not durable and mirror reads are stale

Idle rename/configure/queue paths use `appendWALEvent` even when no WAL is open (`session_actor.go:271`, line 294, and `onQueueOp` at line 460). The helper drops nil-WAL writes. The command succeeds in memory; saving may happen much later on passivation or a completed turn.

Meanwhile `onPull("sessions")` reads disk metadata through `listSessionSummaries` (`ws_server.go:748`, `sessions_admin.go:14`), ignoring resident state. The external rename test receives a successful rename followed by the old title from the mirror. Focused reload tests also find the old model and an empty queue after accepted changes. Abrupt process loss before a later save loses those changes.

Use a single persistence funnel for both idle and active mutations, and define how session summaries reflect current actor state while JSON is frozen during a turn. The existing `saveOrAppend` helper is a starting point, but its running event must encode the actual changed fields, and write failures must reach the caller.

### 9. P2 — Background notices reach the record, but not the running model

`onBgNotice` (`session_actor.go:1179`) appends the completion/cancellation notice to `a.rec.Messages`. The live worker owns a separately initialized `core.Agent`; `workerRefreshMsg` returns only model/options. Nothing transfers that new notice into the agent's next request.

The probe delivers a background completion, runs the real `beforeRequest` handshake, and finds no `background_delivery` in the worker's context. The prior code called `agent.AppendUserContextQuiet`, so the running model actually learned which log to read.

The idle wake-up path has a related omission: `snapshotTurn` accepts `promptMeta`, but `run` builds message metadata only through `attachmentMessageMeta`, discarding `background_delivery`. A real fake-provider turn confirmed the completed transcript lacks the delivery marker. That breaks frontend filtering and durable attribution of background notices.

Add an explicit, ordered actor-to-worker context-delivery path with acknowledgement, and preserve wake-up metadata in the actual appended user message. A test inspecting only `a.rec.Messages` or the initial snapshot cannot establish provider-context delivery.

### 10. P2 — Manual `/compact` is an ordinary agent prompt

`onCompactNow` (`turn_attachments.go:296`) posts a `userPromptMsg` whose text is `/compact`. The worker never treats it as a dedicated compaction operation; it only runs the normal automatic-pressure check.

With a short conversation below the pressure threshold, the focused test grew the transcript from 12 to 14 messages and left `Compaction` nil. The external before/after scenario confirms the remote invokes the summarizer while HEAD forwards `/compact` to the ordinary model. In build mode this can also start the normal tool-capable loop instead of the requested maintenance operation.

Restore a dedicated worker command that calls the existing `Agent.Compact`, preserving actor ownership for the resulting state. No new summarization implementation is needed.

### 11. P2 — Real background jobs never provide the PID needed for re-adoption

`slowHook` (`turn_worker.go:541`) obtains the PID from `ctxPID(w.ctx)`. There is no production writer of `ctxPidKey`, and the current `SlowHook` callback receives no PID. The documented re-adoption path is therefore not connected to real bash/python launches.

The probe executes a real `sleep 10` with a short detach threshold and reads its pidfile: `PID=0` while the command is alive. On restart `pidAlive(0)` is false, so live work is classified as orphaned. Existing re-adoption tests manually register `os.Getpid()`, proving the scanner but not the tool integration.

Pass real process identity across the tool/supervisor boundary and test re-adoption plus cancellation of an actual child. Re-adopted handles currently also lack a stop callback; successful discovery alone would not restore cancellation. This finding does not request rerunning orphaned jobs, which remains an accepted prohibition.

### 12. P2 — Eviction can terminate a newly active turn

Eviction chooses idle candidates from an earlier ping. `passivateMsg` is then unconditional in `handleControl` (`session_actor.go:366`), and `doPassivate` cancels the worker and commits immediately. There is no actor-side check that the session is still idle when the command arrives.

The deterministic interleaving probe queues a fresh prompt in the data lane and a previously selected passivation in the control lane. The prompt is accepted and starts a turn; the pending passivation immediately terminates the actor. This is a realistic stale-decision race between routing and eviction, not a claim about its production frequency.

Make idle eviction conditional at the owner, distinct from forced shutdown. Also ensure routing cannot acknowledge commands to a handle that is already closing. Keeping a live handle mapped avoids dual writers, as D6 requires, but does not alone guarantee successful command delivery.

### 13. P2 — The advertised actor count cap is not enforced

`routeCold` notices `n > maxResidentActors` and triggers `evictIdle(false)`. That routine (`supervisor.go:369`) evicts only for memory pressure or TTL expiry. Actor count is not an eviction criterion.

With the count cap set to 2, three tiny idle sessions remain resident after an explicit eviction round while below the memory budget and within TTL. The same behavior applies to the default 64. This is a missing behavior, not a criticism of the chosen tuning values.

Include excess count in oldest-idle selection; keep the accepted policy that active turns are not killed to enforce a cache budget. This can wait behind the correctness blockers, but should be fixed before relying on the cap as a resource guarantee.

## The untracked test file

`cmd/daemon/review_probe_test.go:18` blocks waiting for a WS event that never occurs. `newTestActor` begins idle with generation 0; the test sends an approval request for generation 1 without starting a turn. The actor correctly rejects it as stale and sends an outcome to the waiter, not to WS. A targeted run with `-timeout 2s` confirmed the hang at line 18.

Consequently, the tracked-source suite is green, but the literal current workspace suite includes this hanging test. The file was preserved. Its other probe recovers an expected panic, so a green result there means the defect exists, not that completion is safe. The attached new probes use ordinary desired-behavior assertions instead.

## Architectural assessment

The direction is reasonable for this project. A dedicated projects owner removes competing file read/modify/write operations. Isolating turn execution from session state makes ownership easier to inspect. Generation guards, bounded mailboxes, singleflight loading, atomic configuration reads, and structured traces are useful building blocks. Retaining the core agent, provider, and disk-format machinery limits unnecessary reinvention. There is no demonstrated need for a new actor framework, distributed queue, or out-of-process session architecture for the documented one-user/few-session profile.

However, the current implementation splits truth across actor state, worker snapshots, the core agent transcript, the frozen JSON, WAL events, and frontend mirrors without consistently defining how each becomes current. The observed attachment, permission, background-notice, and metadata failures are consequences of those missing transitions. Adding more features under the same pattern would require developers to remember several independent updates for every change, making the project fragile.

The second recurring issue is treating lifecycle guarantees as incidental channel behavior: cancellation uses the cancelled context to deliver completion, subscription channels have multiple closers, eviction acts on stale state, and failed commits still admit new work. Removing mutex acquisition cycles does not make blocking channel protocols or durability transitions automatically correct.

Compared with the remote version, the new separation is easier to reason about locally, but the old implementation currently has better demonstrated end-to-end behavior. The external test proves that for the five ordinary workflows above. Its direct policy check, live context injection, and failed-commit stop also express contracts more completely than the ports. The right response is to preserve those behaviors inside the new ownership model, not to copy every old lock back.

The tests explain part of the gap. Approval tests retrieve internal IDs; background tests supply invented process identities; the quarantine test jumps to the last rung; wake-up tests inspect a snapshot without running its consumer. These are useful component tests, but they do not prove the promised parity. The retained real crash test and trace scenarios remain worthwhile; a green trace replay only establishes the path that scenario actually exercises.

Accepted decisions were not counted as defects: MCP/skills/OpenAI-path/search/swarm removal, no standalone provider support, no rerun of orphaned jobs, no forced kill of Go goroutines, removal of daemon-driven updates, and provisional tuning defaults. A probe of queue promotion after HTTP 400 was also excluded from the regression list after checking that the prior finalizer likewise promoted non-cancelled failures.

## Practical next steps

1. Reconcile launcher startup, eliminate the background panic, restore approval/question envelopes, and enforce current access policy. These affect basic operation and user control.
2. Make terminal delivery, commit failure, and idle mutation persistence reliable. Preserve the WAL until recovery is durable; do not accept further work that can destroy it.
3. Finish the worker integration: attachment IDs, pending context notices, wake-up metadata, manual compaction, and real process identity.
4. Revalidate eviction at the actor and enforce the idle count cap. Calibrate performance afterward rather than tuning around incorrect behavior.
5. Promote the external before/after scenarios into maintained regression tests, then add cancellation, commit-failure recovery, and multiple-job sleep scenarios. Run the existing Go/race/browser gates after fixes; a real-model smoke test should complement these deterministic contracts.

The design can become a good basis for further development without another rewrite. The current “IMPLEMENTED / parity complete” claim is ahead of what the executable behavior supports.

## Reproducing the attached evidence

From the repository root, export the two revisions to disposable directories, preserving `cmd`, `packages`, `internal`, `go.mod`, and `go.sum`. The review used Go 1.26.5 on Linux. Build each daemon as `daemon-before` and `daemon-after` in the same temporary parent directory. Copy `daemon-actor-boundary.ts.txt` to a temporary `.ts` file and run it with `DAEMON_REVIEW_DIR` pointing at that parent. The runner creates only temporary configurations, local fixtures, and its own daemon processes.

For the focused probes, copy `daemon-actor-probes.go.txt` as `cmd/daemon/reviewer_behavior_test.go` **in the disposable HEAD export**, then run:

```sh
go test -race ./cmd/daemon -run '^TestReview' -count=1 -timeout 60s
```

Failure is expected on the reviewed revision. These artifacts are review evidence, not an assertion that a failing test suite should be committed unchanged to the application.
