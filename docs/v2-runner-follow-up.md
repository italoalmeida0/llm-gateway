# V2 follow-up: runners and crash recovery

Reviewed on 2026-09-26 at `796d7267ea99bb4d688edf493fc5a3e26071f534`,
after the fixes to the [first review](v2-release-readiness.md) and the
introduction of independent runners. This document supersedes the earlier
"all resolved" release assessment. It does not propose implementation changes
to the manual V1-to-V2 transition.

**Assessment:** keep this direction, but fix the lifecycle and recovery defects
below before release. A separate process, durable output, and a persisted result
are useful improvements. The main remaining problem is inconsistent ownership:
process state, background registration, and delivery state sometimes disagree.
These are bounded fixes; another rewrite or an external queue is unnecessary.

**Status (2026-09-26): all ten findings resolved.** Each fix is a permanent
regression test promoted from the diagnostic probes
(`cmd/daemon/runner_regression_test.go`,
`packages/runner/runner_state_regression_test.go`,
`packages/provider/sse_regression_test.go`). See
[Resolution](#resolution) at the end.

## What improved

- Commands can outlive the daemon; the runner owns the wait status and keeps
  output in a regular file. This removes dependence on the daemon's pipe reader.
- Keeping the original log and repairing an interrupted terminal copy is a good
  recovery mechanism. Preserve the copy semantics and the GC-exempt originals.
- The single artifact and additive protocol avoid unnecessary version coupling.
  File recovery should remain sufficient without a socket connection.
- The earlier watchdog, pending approval/question snapshots, inbound dispatch
  isolation, and shared release validator have real regression coverage now.
- Native CI across the shipped platforms, musl coverage, and the race gate are
  valuable. The limitations below concern missing scenarios, not lack of effort
  on CI.

## Evidence and priorities

The exact reviewed commit passed all nine jobs in
[CI run 36208978397](https://github.com/italoalmeida0/llm-gateway/actions/runs/36208978397).
The existing local suite also passed: `go test ./... -count=1 -timeout 180s`
across all eleven Go packages. Additional diagnostic probes reproduced the
failures below without modifying implementation files. Their source and command
are in [the probe instructions](review-probes/README.md#runner-follow-up-at-796d726).

Linux was used for the new process/signal probes. The existing CI is evidence
for its existing tests on other platforms, not evidence that these new scenarios
pass there. No real model, production data, or release publication was used.

| ID | Priority | Finding | Evidence |
| --- | --- | --- | --- |
| V2R-001 | High | Restart creates background notices for foreground results and silent cancellations | Two subprocess probes |
| V2R-002 | High | Cancellation or runner death can leave the command executing | Two subprocess probes |
| V2R-003 | High | Legacy pidfile recovery masks the runner's real outcome | Subprocess + supervisor probe |
| V2R-004 | High | Heartbeat races terminal state publication | Race detector |
| V2R-005 | High | CRLF SSE events are merged and corrupted | Current/previous parser comparison |
| V2R-006 | Medium | Python loses its supplied stdin | Production starter probe |
| V2R-007 | High | The WS recovery snapshot can itself be silently lost | Actor + full outbox probe |
| V2R-008 | High | A failed transcript write still acknowledges a completion notice | Injected filesystem failure |
| V2R-009 | Medium | Runner binary publication is not atomic | Code inspection |
| V2R-010 | Medium | Log paths and resumed output do not match the promised recovery flow | Code inspection |

All items are **open at the reviewed commit**. “Code inspection” explicitly
means the complete runtime scenario was not reproduced in this review.

## V2R-001: persist execution disposition separately from process outcome

**Where:** `cmd/daemon/runner_adopt.go:71`, `runner_client.go:63`, and
`bg_supervisor.go:onCancel` / `onAck`.

Every command now leaves a runner state, including commands that returned
inline. On boot, `adoptRunners` creates a completion notice for every terminal
state. The state does not distinguish a consumed foreground result, a detached
job, or a cancellation whose notice must be suppressed. Transcript
`background_delivery` deduplication cannot suppress events that were never
supposed to exist.

**Reproduced:** `echo inline-ok` finished and its result was consumed. A new
supervisor still created a background wake-up notice. An assistant cancellation
also created a notice on restart, despite `bg_cancel` promising silence.
These notices can start unwanted model turns and accumulate after ordinary
daemon updates/restarts. This does not mean the shell command is automatically
re-executed; the direct defect is an unsolicited completion delivery.

**Fix:** record the tool-call identity and delivery disposition durably:
foreground pending/consumed, detached, notification suppressed, or delivered.
The daemon should own this delivery record; the runner should own the process
outcome. Separate records avoid adding another writer to the runner's state.
Reconcile both on restart. When a crash leaves a foreground result unconsumed,
recover it against the original tool call instead of inventing a new completed
background task. Persist assistant cancellation suppression before discarding
the registration. Session deletion must also prevent regenerated notices.

**Acceptance:** restart after a short successful command, a short failed
command, assistant cancellation, user cancellation, and a genuine detached
completion. Only the latter two should produce their applicable notifications,
and a repeated restart must not produce extra deliveries. Also cover the crash
between command completion and foreground result persistence.

## V2R-002: own the whole process lifetime through cancellation and crashes

**Where:** `packages/runner/proc_unix.go:25`, `packages/runner/run.go:139`,
`cmd/daemon/runner_role.go`, and `runner_adopt.go:98` / `watchAdopted`.

The POSIX kill path sends TERM, schedules KILL in three seconds, and returns.
If the shell leader exits immediately, `Run` returns and `runnerMain` calls
`os.Exit` before that timer runs. A descendant that ignores TERM survives.
Walking parent PIDs after the leader disappears also cannot reliably find
descendants that have already been reparented.

**Reproduced:** a shell waiting on a TERM-resistant child exited after Stop;
the child was still alive beyond the escalation window. Separately, SIGKILL
of the runner left its command executing, while reconciliation published
`killed`, exit `-1`, and a completion notice. The original test for runner
death checks the notice and the retained log, not whether the command stopped.

This can leave builds, file writes, or other side effects running while the
session believes the operation ended and starts replacement work.

**Fix:** keep the runner alive until cancellation escalation and descendant
cleanup finish, even when the leader exits early. Capture descendant identities
before signalling. Persist enough command/process-group identity to reconcile
runner death; either stop verified surviving commands or explicitly track them
as still running with an unknown final outcome. Do not report a terminal job
while its command continues. An exact exit code after killing its only waiter
may be unavailable; reporting that uncertainty is appropriate.

The new runner state also uses only PID liveness, whereas the older pidfile
path uses `tools.ProcessIdentity`. Preserve generation/boot identity checks
before adopting or signalling a recovered PID. A reused PID is not ownership.
This PID-reuse concern was identified by inspection, not by forcing OS PID reuse.

**Acceptance:** stop a normal tree, a TERM-resistant child whose leader exits,
and a child outside the leader's process group. SIGKILL the runner and verify
both the reported state and the surviving command policy. Keep assertions about
actual processes, not only the notification text. Repeat the relevant ownership
and cancellation scenarios on Windows and macOS.

## V2R-003: make runner state the sole recovery authority for runner jobs

**Where:** `cmd/daemon/bg_supervisor.go:run` / `onRegister`,
`bg_pidfile.go:readopt` / `watchReadopted`, and `runner_adopt.go:113`.

New detached runner jobs still write legacy `.pid.json` registrations. Boot
runs `readopt()` before `adoptRunners()`. The old path populates `b.jobs`, then
`adoptOne` returns early because that job already exists. Its state watcher is
never installed; the old watcher only knows that a PID disappeared.

**Reproduced:** a registered runner survived a supervisor restart and exited
with code 7. The durable runner state contained 7, but the recovered registry
reported `orphaned` and “exit status unavailable”. This defeats one of the main
benefits of the new runner and can also select the wrong cancellation path.

**Fix:** route each job through exactly one recovery implementation. Prefer
runner state whenever present. Stop producing legacy pidfiles for runner jobs,
or make the legacy reader skip/upgrade those records. Supporting old local
pidfiles, if desired, does not require them to remain authoritative over a new
runner. This is about V2's current runtime, not automatic V1 migration.

**Acceptance:** create a real detached job through the production registration
path, restart while it runs, and assert the final registry status, exact result,
and notice for exits 0 and 7 and for cancellation. Test completion both before
and after the replacement supervisor starts. Merely asserting that one notice
arrives is insufficient.

## V2R-004: serialize heartbeat and terminal state writes

**Where:** `packages/runner/run.go:129` and `state.go:WriteState`.

The heartbeat goroutine mutates and serializes `st` while the main goroutine
mutates the same object for finalization. Both writers also use the same
`<job>.state.json.tmp` path. The ticker is stopped only when `Run` returns;
stopping a ticker neither joins its goroutine nor orders an in-flight write.

**Reproduced:** a real command lasting 10.2 seconds, beyond the ten-second
heartbeat interval, triggers race reports between terminal mutations and
heartbeat JSON serialization under `go test -race`. The observed failure is a
data race; loss/corruption of a terminal record is a possible consequence, not
an observed disk corruption in this probe.

**Fix:** use one state owner/write loop, or hold one lock across mutation,
serialization, and atomic replacement. Stop and join heartbeat work before
publishing the final state, and prevent any subsequent running-state write.
Handle publication failures explicitly instead of silently announcing durable
completion. Keep recovery of the interrupted brain copy.

**Acceptance:** run across multiple heartbeat intervals under `-race`, finish
near a heartbeat, cancel near one, and inject state-write failures. Repeated
reads must see valid JSON and a final state must never regress to running.
If testing the subprocess itself for races, build that subprocess with `-race`:
the current `buildRealApp` helper invokes ordinary `go build`.

## V2R-005: retain SSE newline semantics when removing the line-size cap

**Where:** `packages/provider/sse.go:40` and `packages/linereader/linereader.go`.

The replacement line reader deliberately preserves CR, but `readSSE` still
recognizes an event boundary only when the returned line is empty. A CRLF
separator returns `"\r"`. Events merge until EOF and the CR also remains in
event names and data. The problem applies on Linux too; it depends on the
upstream bytes, not the host operating system.

**Reproduced:** an event carrying `{"text":"hello"}` followed by `[DONE]`
became a single event with data `{"text":"hello"}\r\n[DONE]\r` and name
`message\r`. LF passes. Both cases pass using the previous `sse.go` from
`7f2c8c0`. Joined payloads can fail JSON decoding and delay or lose model output.

**Fix:** normalize SSE line endings in the SSE adapter while keeping the
general line reader byte-transparent. At minimum, restore CRLF parity; test
any additional SSE line-ending support explicitly. Keep support for large
individual events rather than reinstating the old size cap.

**Acceptance:** LF and CRLF streams deliver the same event sequence incrementally,
before EOF, with correct names, JSON data, terminal markers, and usage comments.
Include a payload above the old cap.

## V2R-006: forward the Python stdin payload through the runner

**Where:** `cmd/daemon/runner_client.go:73`, `packages/runner/spec.go:Spec`,
and `packages/runner/run.go` command construction.

`PythonTool` passes `ExecSpec.Stdin`; the direct starter consumes it. The runner
mapping drops it, the runner spec has no corresponding field, and the command's
stdin is unset.

**Reproduced:** Python `print('got:' + sys.stdin.read())` with `stdin: "ping"`
returns `got:` with exit 0 through the production starter. Existing Python
stdin tests exercise the direct starter and therefore remain green.

**Fix:** carry stdin through the launch spec and connect it to the command.
Keep it out of the durable job metadata and logs. Also make the Python
stdout/stderr contract explicit: the runner currently merges them although
the tool description promises separate captures.

**Acceptance:** run inline and script Python modes through `runnerStarter`,
with nonempty and Unicode stdin, in both foreground and detached execution.
The result must match the direct starter's supported semantics.

## V2R-007: a failed resync must remain pending

**Where:** `cmd/daemon/ws_server.go:102` / `buildSessionData` and
`ws_actor.go:60` / `takeResyncs`. This reopens **V2-002**.

`takeResyncs` clears a session's recovery mark before building its snapshot.
The resulting `session_data` envelope contains `session.id`, but no top-level
`sessionId`. If that snapshot overflows too, `sidOf` cannot identify the
session to re-mark it. A busy/timeout result from `buildSessionData` is also
treated like a deleted session and discarded.

**Reproduced:** after a decision event overflowed, forcing the recovery snapshot
through another full outbox dropped the snapshot and left the recovery set
empty. The browser still needs a reload to discover the decision.

**Fix:** retain recovery state until successful admission/delivery, carry the
session identity explicitly, and distinguish a missing session from a transient
read failure. Retry on the next capacity signal or bounded timer; avoid a tight
loop that continuously rebuilds a snapshot while the queue stays full.

There is a related snapshot limitation by inspection: `liveTracker` accumulates
partial assistant text, reasoning, and tool arguments, but `liveSnapshot`
serializes only tool progress/start times and the thinking timer. Reconnect and
resync cannot restore the in-flight response prefix. Preserve this transient
content too, with an ordering/cursor rule so a stale snapshot cannot overwrite
newer deltas or revive a resolved approval. The pending-decision fields added
for **V2-004** are useful, but they are not a complete stream-recovery contract.

**Acceptance:** overflow the decision and its first repair snapshot, stall the
snapshot read temporarily, and then drain the queue. The browser must converge
without reload. Reconnect during text/reasoning/tool-argument streaming and
interleave a decision answer with snapshot production.

## V2R-008: acknowledge only a durable transcript fold

**Where:** `cmd/daemon/session_actor.go:1343` / `onBgNotice` / `noticeDelivered`.
This reopens the durability edge of **V2-003**; the successful-write retry fix
remains useful.

In a running session, `onBgNotice` appends the identity to RAM, ignores the
error from `saveOrAppend`, and sends `bgAckMsg` anyway. A later retry sees the
RAM identity and acknowledges again without proving persistence succeeded.
The supervisor then removes its retained notice.

**Reproduced:** a forced filesystem rename failure set `persistErr`, yet the
supervisor received an acknowledgement for that notice. The observed defect
is premature acknowledgement. For runner jobs, a later boot may recover again
from their retained state, but that independent record does not make this
delivery contract durable and may eventually be collected.

**Fix:** preserve a pending/durable distinction for delivery IDs. Only acknowledge
after the WAL/session write succeeds; on failure keep the notice pending without
re-appending it to RAM on every retry. Retrying a save must eventually publish
the durable identity before retiring delivery. Apply the same identity rule
to the wake-up turn's WAL header and its eventual opening message.

**Acceptance:** fail the transcript write, resend the notice, restore storage,
and restart around those boundaries. A failed save must not retire the notice;
successful recovery must append/deliver once, without an extra model turn.

## V2R-009: publish the executable only after copying finishes

**Where:** `cmd/daemon/runner_client.go:31` and `fetch.go:copyFileContents`.
Evidence: code inspection; no interrupted-copy experiment was run.

The copy opens the final executable path with `O_TRUNC`. Any subsequent caller
accepts a nonempty file as ready. A concurrent first command can observe a
partial binary; a daemon crash or failed copy can leave that partial file
accepted indefinitely. This concerns publication, not authenticity verification.

**Fix:** copy to a unique temporary file in the same directory, close/sync it,
then publish atomically. Serialize first-use staging per root/version and
handle platform rename constraints. Incomplete temporary copies should be
ignored/cleaned on retry. This preserves the owner's decision to avoid binary
verification; no hash/signature check is required for this fix.

**Acceptance:** race two first commands and interrupt the initial copy.
The next attempt must launch a complete executable without manual cleanup.

## V2R-010: complete the recovered-output and readable-path contract

**Where:** `cmd/daemon/runner_adopt.go:adoptOne`, `runner_client.go:startRunner`,
`turn_worker.go:slowHook` / sandbox initialization, and `packages/runner/run.go`.
Evidence: code inspection; no full browser/model recovery test was run.

- `adoptOne` installs a completion watcher, but no output tail or IPC output
  consumer. The parent uses the socket for `DialKill` only. A restarted daemon
  does not resume `bg_output` delivery as the plan describes.
- The broadcaster calls `ReadAt` on the file opened with `O_WRONLY`; that read
  fails. The existing slow-parent test checks that the command and log complete,
  not that any `out` frames reach the socket.
- Production `slowHook` returns the `runners/out` path and never switches the
  registry to `BrainLog` on completion. A jailed session allows its workspace
  and brain directory, not that shared output directory. Its normal file tools
  can reject the path that the completion notice tells the model to read.
  The foreground-window test substitutes a hook returning `BrainLog`, so it
  does not validate the production path choice.

**Fix:** finish the file-first path before expanding IPC. Reattach a bounded
file tail with a defined replay offset and lifecycle cleanup. Publish an
accessible completed log path after copy/repair, and define scoped access to
that session's live job logs where needed. Do not grant access to the whole
runner directory, which also holds transport metadata. If keeping socket
output, use a readable handle and test actual frames and replay; serialization
and write deadlines must make the slow-client claim true.

The proposed future redesign of the model-facing placeholder can stay out of
scope. The existing notification/read path should still work in the meantime.

**Acceptance:** restart during a noisy job and observe subsequent output in a
real client; then finish and read its reported log through a jailed session.
Repeat in file-only mode. If socket output is advertised, assert actual output
frames, a reconnect cursor, and a reader slow enough to exhaust socket buffers.

## Release order and coverage

1. Fix lifecycle disposition, process ownership, competing recovery, and state
   publication together (V2R-001 through V2R-004). They define what a recovered
   job actually means.
2. Fix protocol/tool parity and reliable session delivery (V2R-005 through
   V2R-008), and finish atomic staging/readable output (V2R-009/V2R-010).
3. Promote the diagnostic probes into permanent regression tests, adapted to
   the chosen implementation. Cover production seams: real starter, real
   registration, real restart, actual process cleanup, and actual output bytes.
4. Run the full native CI on the resulting candidate, then the existing release
   artifact dry run, browser smoke, and manual V1-to-V2 install on a data copy.

The existing runner tests are useful components, but their names sometimes
promise more than their assertions establish. The parent-death test stops the
supervisor rather than killing a separate OS daemon process; the tree test uses
cooperative descendants; the foreground test does not restart afterwards; the
race-sensitive runner subprocess is built without instrumentation. Add these
missing boundaries rather than multiplying tests of the same happy paths.

Keep the implementation small: one owner for execution, one durable delivery
decision, and repeatable reconciliation. Surviving a crash is only part of the
contract; restart must also preserve the meaning of completed and cancelled work.


## Resolution

All ten findings were fixed and the probes promoted to permanent tests
(renamed `TestRegression*`). Summary of the chosen design:

- **V2R-001 execution disposition** — a durable sidecar
  (`runners/<jobId>.disposition`) records how an outcome is consumed:
  `background` (notify), `inline` (silent — the default for an absent
  file), `suppressed` (silent assistant cancel). The tool writes it on the
  sync return / detach; the supervisor writes it on cancel; adoption
  notifies ONLY for `background`. Recovery can no longer invent a wake-up.
- **V2R-002 process ownership** — the runner records the command's
  `cmdPid`/`cmdPgid` in the state immediately; cancellation is a fast TERM
  request and the guaranteed reap (TERM → grace → KILL + ppid sweep) runs
  synchronously before the terminal record. The parent reaps the command's
  group from the durable identity when the runner itself died (F6) and on
  Stop, so a hard-killed runner cannot leave the command running.
- **V2R-003 sole recovery authority** — runner jobs carry `Runner: true`
  in the legacy pidfile and are skipped by `readopt`; their state file is
  the only recovery source, so a stale pidfile cannot mislabel the exit
  status.
- **V2R-004 state publication** — one mutex owns state mutation +
  serialization, and the heartbeat is stopped and joined before the
  terminal write.
- **V2R-005 SSE newlines** — CRLF/CR is normalized in the SSE adapter
  (the shared linereader stays byte-transparent for GNU-style tools).
- **V2R-006 Python stdin** — the stdin payload flows through the runner
  spec and is wired to the command (kept out of the durable state/log).
- **V2R-007 resync durability** — the resync event carries a top-level
  `sessionId`, so a resync dropped against a still-full queue re-marks its
  session; the flusher is one pass per trigger (no spin).
- **V2R-008 durable ack** — the notice is acknowledged only after the
  transcript fold persists; a failed save keeps it pending for retry.
- **V2R-009 atomic publish** — the runner binary is staged to a temp file
  and renamed, so a partial copy is never adopted as ready.
- **V2R-010 recovered output** — the broadcaster opens the out log
  read-write (frames flow), adopted jobs resume an output tail, and the
  completion notice points at the readable brain copy.

Remaining release-process gates (unchanged): full native CI on the
candidate, the release artifact dry run, the browser smoke, and the manual
V1-to-V2 install on a data copy.
