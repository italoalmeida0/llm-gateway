# Daemon crash recovery: contracts, implementation, and validation

Reviewed on 2026-09-26 against `dev` at `2b6d934`.

This document retains the five-part design review of the baseline above. The
implementation status below describes the subsequent changes on `dev`. Historical
"current behavior" sections refer to the reviewed baseline, not the new code.
Acceptance scenarios are a design checklist; only tests explicitly listed in the
implementation section exist today. Passing the existing suite does not imply
that every proposed fault-injection experiment has been performed.

The [CI run for the reviewed baseline](https://github.com/italoalmeida0/llm-gateway/actions/runs/36233759481)
passed all nine jobs: gateway, six native daemon platforms, Linux race detector,
and Alpine/musl including release artifact verification. That is evidence for
the covered behavior, not proof that every crash boundary is covered.

The architectural direction is sound: actor ownership, generation fencing,
WAL recovery, independent runners, file-backed output, and delivery deduplication
should remain. No database migration, new runtime dependency, distributed queue,
separate launcher artifact, or automatic V1 migration is proposed here.

## Implementation on dev

| Contract | Implemented behavior | Executable evidence |
| --- | --- | --- |
| CO-01 | Checked atomic state/disposition publication; synced source log; bounded publication retries; atomic brain projection; wrapper exit 75 on uncertain publication; corrupt state filenames traced and preserved | Runner `TestCrashContractHardKillAfterCommitRetainsOutcome`, `TestCrashContractTerminalPublicationRetriesSameOutcome`, `TestCrashContractPermanentPublicationFailureIsUnacknowledged`, `TestCrashContractCopyFailureIsNotSuccess`, `TestCrashContractCorruptStateRemainsVisible`; durable `TestFailedCopyPreservesPreviousPublication` |
| CO-02 | Birth identity persisted for runner and command bootstrap; matching required before adoption/signalling; Linux pidfd and Windows process handle signals; conservative handling of unverifiable legacy records | Daemon `TestCrashContractMismatchedRunnerCannotKillSentinel`, plus native process/recovery tests |
| CO-03 | Boot owns an authenticated loopback health deadline; completed infra/session watchdog rounds renew it; two minutes without health kills only the worker; existing three retries/backoff retained and reset after ten stable minutes | Daemon `TestCrashContractParentKillsWedgedWorkerOnly`, `TestCrashContractHealthyWorkerAndShutdown`, existing supervisor declared-wait/quarantine and runner-update tests |
| CO-04 | Private `--runner-command` bootstrap waits for a pipe release; command identity must be persisted first; Windows assigns the blocked bootstrap to a runner-owned kill-on-close Job Object and waits for its process count to drain | Runner `TestCrashContractHardKillBeforeReleaseCannotRunPayload`, `TestCrashContractIdentityFailureNeverReleasesPayload`, existing cancellation/tree tests |
| CO-05 | Durable execution receipts for bash/python/write/edit; stable scope in the turn WAL; runner launch claims; known outcomes cached; unresolved outcomes block further mutations in the same turn, including fresh model call IDs | Daemon `TestCrashContractReceiptDeduplicatesIntent`, `TestCrashContractLostResultDoesNotRepeatExternalEffect`, `TestCrashContractReceiptRecoversRunnerAndRepairsOutput` |

### Recovery records and operational behavior

- `runners/<job>.state.json` adds `processIdentity`, `commandIdentity`,
  `outputReady`, and `outcomeUnknown`. Additive fields preserve existing readers.
  A terminal command record can precede output projection readiness. Recovery
  repairs the copy before issuing its notice. Missing terminal evidence means
  **unknown outcome**, not an invented command exit code.
- `executions/<session>/<scope>/<scope>_<call-hash>.json` stores a fingerprint,
  phase, and completed tool result. Arguments are hashed, not stored verbatim;
  tool results retain their normal potentially sensitive output. These are
  private files (0600) outside the model's brain directory. Execution records do
  not mutate session snapshots or bypass actor/WAL ownership.
- `runners/<execution-id>.launch` is an exclusive launch claim. A crash between
  claim and initial runner state deliberately leaves an uncertain operation.
  It must not cause an automatic relaunch.
- The same call ID with different arguments is rejected. A new call ID after a
  normally recorded completion represents a new intent. An unresolved prior
  effect blocks all four mutating tools within that recovered turn. A new user
  turn gets a new scope; the operator must verify effects before choosing to
  repeat an uncertain action. Read tools remain available for that verification.
- Receipts and launch claims are retained conservatively. They are not deleted
  by short-term runner-state GC. Do not delete them to clear a stuck retry while
  its turn can still recover. A future retention policy must prove the turn can
  no longer replay; this change does not add automatic receipt GC.
- An interactive first-pairing prompt declares one bounded 15-minute startup
  wait. It does not emit a fake healthy actor heartbeat. After startup, normal
  completed health rounds restore the two-minute deadline. Direct `--worker`
  invocation has no boot parent monitor; normal entry must use the default role.

### Running the checks

From `indirect-code-daemon/`:

```sh
go test ./...
go test -race ./... -count=1 -timeout 300s
go test ./cmd/daemon ./packages/runner ./internal/durable -run 'TestCrashContract|TestFailedCopy' -count=1
```

From the repository root:

```sh
bun run lint
bun run typecheck
bun run build:daemon
bun test
bun run build
bun scripts/verify-release-dist.ts
```

The GitHub `CI` workflow must pass on the actual pushed `dev` commit: gateway,
six native daemon OS/architecture jobs, Linux race detector, and Alpine/musl.
A cross-build alone does not validate native Job Object or process-signalling
behavior. No release publishing or automatic V1 migration is part of this work.

### Limits that remain explicit

1. These changes target process crashes and checked filesystem failures. They
   do not claim arbitrary power-loss durability. POSIX records sync files and
   containing directories; Windows syncs files but has no portable directory
   fsync contract here. Normal WAL text appends retain their prior flush policy.
   No VM power-cut or filesystem-corruption campaign has been run.
2. Linux pidfds and Windows handles bind a signal to an incarnation. macOS
   birth-time verification still has a check/signal race. POSIX group/tree
   cleanup is not kernel containment: simultaneous loss of runner and bootstrap,
   or descendants deliberately escaping and reparenting, can prevent safe
   ownership proof. Unverifiable ownership must not authorize a blind PID kill.
   Strict hostile-descendant containment would require a separate OS-specific
   design (for example, delegated Linux cgroups).
3. Storage fault tests inject publication failure and failed partial copying;
   they do not individually intercept every kernel fsync/rename failure. Native
   matrix tests are necessary for Windows Job Object/rename and macOS behavior.
4. The external monitor tests use real child processes with shortened deadlines;
   they prove watchdog isolation/renewal, not every production deadlock. Existing
   recovery tests separately exercise WAL/session/runner restoration.
5. Arbitrary remote effects cannot be made exactly-once locally. Unknown means
   **stop and reconcile**, not "safe to retry". Provider/server idempotency keys
   remain the right mechanism when the external API supports them.

The Windows active-process check uses the documented
[Job Object accounting structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information).

## Priorities and evidence

| ID | Priority | Contract to strengthen | Evidence at the reviewed commit |
| --- | --- | --- | --- |
| CO-01 | High | Acknowledged completion must have recoverable evidence | Confirmed control flow: failed terminal state writes still reach `sendDone`; some other persistence errors are ignored |
| CO-02 | High | Recovery must never signal an unrelated process | Confirmed numeric PID/group adoption; reuse consequences require a dedicated test |
| CO-03 | High | A permanently wedged actor must reach a bounded recovery decision | Confirmed warning-only root watchdog and no external progress monitor in `execDaemon` |
| CO-04 | High for a strict runner-crash guarantee | No user command may start before recovery ownership is established | Confirmed spawn-before-identity-write window; the remaining hard-kill window needs its own deterministic reproduction |
| CO-05 | High for tools with external effects | An unknown outcome must never be treated as proof that execution did not happen | Confirmed generic missing-result repair and independently generated runner IDs; duplicate external effects are a risk to reproduce |

These are engineering priorities, not measured incident frequencies. The recent
early-TERM race was reproduced and fixed; CO-04 concerns **SIGKILL or abrupt
termination**, which cannot be handled by moving a signal handler earlier.

## Failure model and terminology

Before implementation, specify what each acknowledgement promises:

| Failure | Expected recovery | Important limit |
| --- | --- | --- |
| Browser or relay disconnect | Re-pull state and resume viewing existing work | Delivery to a socket is not a durable receipt |
| Daemon worker crash | Reload sessions/WAL; adopt independent runners | A runner must not be tied to the daemon worker's lifetime |
| Runner crash | Reconcile its execution and stop owned command processes where ownership is established | A signal handler cannot catch a hard kill |
| Storage error | Report degraded persistence, retain evidence, and prevent unsafe progress | Restarting does not repair a full or read-only disk |
| Host reboot/power loss | Recover committed records according to a declared durability policy | Flushing a Go buffer is different from syncing storage |
| External operation completed but its reply was lost | Reconcile or report an unknown outcome | A local journal cannot make an arbitrary remote action exactly-once |

Use three different terms: **observed** means the current process saw an event;
**persisted** means recovery can read its record under the stated failure model;
**delivered** means a consumer durably incorporated that record. Process death
must not cause one of these meanings to be silently substituted for another.

The current WAL append path calls `flush()` for each event, while `Sync()` occurs
on close. It therefore deserves a different host-power-loss promise from a
synced commit. Do not describe every WAL append as power-loss durable. Choose
explicit sync boundaries for execution intent, completion receipts, and delivery
acknowledgements; ordinary streamed text can keep a documented weaker policy.

## CO-01: make durable completion a real boundary

### Current behavior and failure scenario

Relevant paths:

- [`runner.Run`](../indirect-code-daemon/packages/runner/run.go): command identity
  and transport updates ignore `WriteState` errors; terminal publication logs an
  error but proceeds to copy the log, send `done`, and return the command code.
- [`WriteState` / `WriteDisposition`](../indirect-code-daemon/packages/runner/state.go):
  temporary-file writes and rename; their directory durability policy differs
  from the session store, which attempts to sync its directory.
- [`repairTerminalCopy`](../indirect-code-daemon/cmd/daemon/runner_adopt.go): copy
  and sync failures do not become a recovery result that callers can inspect.
- [`appendWALEvent`](../indirect-code-daemon/cmd/daemon/store_wal.go) and
  [`saveOrAppend`](../indirect-code-daemon/cmd/daemon/session_actor.go): related
  acknowledgement boundaries to audit alongside runner completion.

A command completes successfully, then the state replacement fails with ENOSPC
or EIO. The connected consumer can observe success while the durable record
still says running. If the runner exits, recovery cannot reconstruct the exit
code from that old record. A failed brain-log copy creates another mismatch:
the notice can advertise a path whose contents are incomplete or absent.

This is visible in the code; the full disk-failure scenario has not been executed
as part of this document.

### Proposed implementation

1. Define one explicit publication result for critical state writes. Report
   whether replacement occurred and whether the requested durability boundary
   completed. A failure after rename is an uncertain commit, not necessarily
   proof that the old file remains in place.
2. Use a small atomic-record helper: unique temporary file in the target
   directory, complete write, checked sync, checked close, replacement, and
   platform-appropriate directory/metadata durability. Preserve existing session
   semantics. Do not silently ignore unsupported operations and claim the
   strongest guarantee on every OS/filesystem.
3. Distinguish the command's exit from the runner's ability to publish it.
   Keep the observed outcome in memory while retrying persistence with bounded
   backoff. While publication is pending, emit a storage diagnostic and do not
   send a normal durable-completion acknowledgement. No command re-execution.
4. If a retry succeeds, publish exactly that outcome and then notify. Repeating
   publication of the same job outcome must be idempotent. If storage remains
   unusable past the operational deadline, fail the runner wrapper explicitly;
   preserve the old record and logs. Recovery must represent an unknown outcome,
   rather than inventing the command's exit code. The wrapper's storage failure
   is not evidence that the command itself failed.
5. A failed command-identity write must prevent release of user code once CO-04's
   launch gate exists. Until then, stop the just-created child and report the
   failure; document that this cannot undo effects already performed.
6. Treat the brain copy as a repairable projection of the original log. Return
   copy errors, retry them, and publish the file atomically so readers cannot
   observe a half-copy. Advertise output readiness separately when necessary.
   Keep the source log and the existing sandbox boundary intact.
7. Make corrupt/unreadable state visible as a recovery problem. `LoadStates`
   currently skips read errors; a skipped record must not be interpreted as
   proof that the execution never existed. Preserve the artifact for diagnosis.

An in-memory `completion_pending` condition is useful but is not itself durable.
Adding a second receipt file on the same full filesystem cannot magically make
the failed write succeed. The design must have an honest unknown-outcome path.

### Established example

SQLite documents ordered persistence operations and the distinction between
atomic visibility and durable commit. Its commit protocol is a useful reference
for deciding when a success acknowledgement is justified. The proposal here
borrows that discipline; it does not propose replacing the daemon store with
SQLite. [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html).

### Practical acceptance tests

**CO-01-A — failed completion publication, then recovery**

Run a real command that creates a unique marker exactly once and exits with a
known code. Pause at a test barrier before terminal publication. Fail each write,
sync, close, replacement, and directory-sync boundary in turn. Assert that no
ordinary completion acknowledgement is emitted while publication is uncertain.
Restore storage, release the retry, and assert the exact exit code is recovered.
Restart the daemon twice: one transcript delivery, one marker, unchanged source
log. Repeat with permanent storage failure: a visible unknown/degraded outcome,
never an invented success and never a second command execution.

**CO-01-B — crash after replacement but before acknowledgement**

Hard-kill the runner after the durable outcome exists and before `done` is sent.
Recovery must deliver the stored outcome once. Kill the daemon after transcript
incorporation but before its delivery ACK; redelivery must not add another row.

**CO-01-C — output projection repair**

Interrupt the brain copy at several byte boundaries, including a zero-byte
destination. On recovery compare the complete byte digest with the source log,
then open the advertised path through the actual session file-tool permissions.
Inject a copy failure and verify that readiness is not falsely announced.

**Pass condition:** every acknowledged outcome survives the declared recovery
scenario; unacknowledged or uncertain outcomes remain explicit and never trigger
an automatic second execution.

## CO-02: identify process incarnations, not only PID numbers

### Current behavior and failure scenario

[`runner.State`](../indirect-code-daemon/packages/runner/state.go) carries numeric
`PID`, `CmdPID`, and `CmdPgid`, without an OS process-birth identity.
[`adoptRunners`](../indirect-code-daemon/cmd/daemon/runner_adopt.go) branches on
PID liveness; [`reapStoredCommand`](../indirect-code-daemon/cmd/daemon/reap_unix.go)
can signal the stored group number.

After the original process exits, those numbers can describe an unrelated
process. Recovery could adopt the wrong process, wait forever for it, or signal
it during orphan cleanup. A matching executable name alone is insufficient:
two legitimate executions can run the same binary.

### Proposed implementation

1. Persist a process identity alongside each PID: OS boot identity where
   available, process creation identity, and the logical job ID. Record the
   runner and command identities separately. Application `StartedAt` is not the
   kernel's creation identity.
2. Reuse the existing platform probes in `packages/agent/tools/process_identity_*`
   where suitable, moving shared code to a neutral process package if required.
   Audit the macOS fallback: formatted `ps lstart` has limited precision and
   should not be described as a perfect kernel capability.
3. Use a typed probe result: matching, absent, mismatched, or inaccessible.
   Permission failure must not mean dead. Mismatch must never authorize a kill.
4. On Linux, consider pidfds for the final live-process signal operation; on
   Windows, retain an opened process handle after validating creation identity.
   Checking metadata and then calling a numeric-PID kill still has a race.
   Reopening after restart requires revalidation; serialized handle numbers are
   meaningless in a new process.
5. Define group ownership separately. A legitimate group may survive its
   leader, so requiring a living leader can leak children. Conversely, a stored
   PGID is not a permanent ownership token. Prefer an owned OS container where
   supported, or explicitly verify surviving members and document the remaining
   race. A pidfd for one process does not identify an entire group.
6. Old state files lacking identity remain parseable. Treat destructive cleanup
   as unverified unless ownership can be established independently. Surface the
   uncertainty; do not synthesize a trusted birth identity from the current PID.

### Established examples

Linux provides pidfds to refer to a particular process, including a signal API
that avoids targeting a later process through a recycled PID. This is a
live-process capability, not a cross-reboot receipt.
[pidfd_open](https://www.man7.org/linux/man-pages/man2/pidfd_open.2.html),
[pidfd_send_signal](https://www.man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).

Windows distinguishes process identifiers from process handles, which can be
used to operate on a specific process object. Pair reopening with creation-time
validation in recovery.
[Microsoft process handles and identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers).

### Practical acceptance tests

**CO-02-A — stale state targeting an unrelated live process**

Start a harmless sentinel helper owned by the test. Write a runner record with
the sentinel's numeric PID but a different birth identity/job. Exercise adoption,
Stop, orphan cleanup, and GC. The sentinel must continue answering an IPC ping;
there must be no successful adoption or kill. This tests the reuse consequence
without relying on the OS to recycle a PID during a short CI run.

**CO-02-B — matching identity and leaderless group**

Verify a real matching runner is adopted. Separately create a group with a
TERM-resistant child whose leader exits. Cleanup must terminate the actual child
while preserving an unrelated sentinel group. Compare birth identities as well
as PIDs in the test's process inventory.

**CO-02-C — lookup/signal race and inaccessible metadata**

Use a controlled process-probe seam to replace the identity between validation
and the signal step. No signal may reach the replacement identity. Add native
handle/pidfd tests, unavailable-feature fallbacks, permission failures, and old
records without identity. Missing capability must produce a documented reduced
guarantee, not a passing test that silently skips all cleanup behavior.

**Pass condition:** zero signals to unrelated processes, correct handling of
valid owned descendants, and explicit handling of unverifiable identities.

## CO-03: let supervision recover from a process that stays alive but is wedged

### Current behavior and failure scenario

[`root.watchdogLoop`](../indirect-code-daemon/cmd/daemon/root.go) records and logs
unresponsive infrastructure actors. The unresponsive-session branch in
[`watchdogRound`](../indirect-code-daemon/cmd/daemon/supervisor.go) correctly keeps
the actor mapped to prevent a second WAL writer, but does not force termination
of a permanently blocked owner. [`execDaemon`](../indirect-code-daemon/cmd/daemon/exec.go)
waits for process exit; it does not independently monitor progress.

[`boot.go`](../indirect-code-daemon/cmd/daemon/boot.go) already retries unexpected
worker exits three times with increasing delay. It cannot use that mechanism
while the worker remains alive. Its crash count also spans the boot process's
lifetime rather than a rolling interval; adding automatic watchdog restarts
should include an explicit policy for recovery after long healthy operation.

### Proposed implementation

1. Keep mailbox round trips and declared-wait semantics. An idle session, a
   human approval, or a provider call inside its deadline is not a deadlock.
   A busy queue alone is not evidence that restarting will help.
2. Use consecutive failed progress rounds, a recovery budget, and explicit
   healthy-reset rules. Start with conservative documented thresholds; test
   with shorter injected durations, not production sleeps.
3. For an infrastructure actor that remains wedged, capture bounded diagnostics,
   stop accepting new work, and request worker-process replacement. Never spawn
   another actor while the old owner might still write the same WAL.
4. Put the final deadline outside that worker. A parent/child health channel
   should carry sequence/incarnation information and depend on completed health
   checks, not an unrelated ticker that keeps beating during a deadlock. A lost
   or stale health report eventually triggers termination and replacement.
5. Terminate **only the daemon worker** in this path. Leave independent runners
   available for adoption. Do not accidentally sweep their process tree as if
   this were an explicit user cancellation of all jobs.
6. Bound restart frequency with a rolling window and backoff, retaining a clear
   failed state when the budget is exhausted. Preserve the existing explicit
   Stop and updater-handoff behavior. A persistence outage is a degraded-storage
   condition first, not a reason to restart every few seconds.
7. Keep this in the existing boot/worker binary. A full actor runtime or a new
   standalone supervisor application is unnecessary.

Diagnostic recording must be best-effort and time-bounded: an unavailable disk
must not prevent the final restart decision. Avoid traces containing prompts,
tool arguments, process environments, or IPC credentials.

### Established examples

systemd's service watchdog connects missing health notifications to service
failure and a configured restart policy. This illustrates why an external owner
is useful when the monitored process can no longer cooperate.
[systemd service documentation source](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).

Erlang/OTP supervisors bound restart intensity within a time period and escalate
when repeated restarts fail. Borrow the bounded policy and ownership principle;
Go goroutines cannot be forcibly terminated like isolated Erlang processes.
[OTP supervision principles](https://www.erlang.org/doc/system/sup_princ.html).

### Practical acceptance tests

**CO-03-A — permanently blocked actor**

Use a test barrier to block a real actor while its goroutine and daemon process
remain alive. Launch through the real boot role. Assert warning/degradation,
then one worker replacement inside the declared deadline. The old worker must
be dead before the replacement opens the session for writing. Recover a seeded
WAL and verify its exact acknowledged contents.

**CO-03-B — worker-wide freeze**

Freeze the worker with SIGSTOP on POSIX; use a controlled whole-worker pause or
native equivalent on Windows. The parent must recover without receiving a
cooperative shutdown reply. The supervisor itself must remain responsive.

**CO-03-C — negative and integration cases**

Long legitimate provider wait, approval wait, idle session, and temporary queue
pressure must not restart the worker. Repeated actual wedges must exhaust the
restart budget rather than loop. Healthy operation resets the budget according
to the chosen policy. Test explicit Stop and update handoff separately.

Keep a background runner writing numbered output during replacement: its
identity must remain unchanged, no command may be relaunched, and its eventual
completion must appear exactly once in the session.

**Pass condition:** a permanent wedge has a bounded recovery outcome, healthy
waits remain stable, and recovery never creates concurrent session owners.

## CO-04: close the gap between process creation and recoverable ownership

### Current behavior and failure scenario

[`runner.Run`](../indirect-code-daemon/packages/runner/run.go) starts the command,
then records `CmdPID`/`CmdPgid`. The new early signal subscription fixes ordinary
TERM during startup. A hard kill between `cmd.Start()` and identity publication
still bypasses all Go cleanup and can leave a command that the stored record
does not identify.

Writing a `starting` flag alone does not close this gap: the child can already
perform external actions while the flag contains no recoverable ownership.

### Proposed implementation

Prototype a small launch gate within the existing multi-call binary. The precise
native mechanism is a design decision to validate, not a completed guarantee.

1. Persist launch intent with a stable execution ID before spawning anything
   that can execute user code. Use exclusive ownership of that ID.
2. Start a trusted internal bootstrap that can only report readiness and wait
   on a private pipe. It must not invoke a shell or user Python before release.
   EOF or a startup deadline makes it exit without executing the payload.
3. Establish the bootstrap/process-container identity and publish the recovery
   record. Publication failure closes the gate and cleans up the bootstrap.
4. Only after that boundary send the release token. On POSIX, evaluate replacing
   the bootstrap with the payload using `exec`, preserving its tracked PID/group.
   On Windows, evaluate a controlled child launch associated with a Job Object.
5. An unconfirmed release is an uncertain execution, not permission to spawn a
   second payload. Recovery uses the original execution ID and stored evidence.
6. Separate daemon lifetime from runner lifetime. Losing the daemon must preserve
   the runner. Losing the runner must stop its owned command tree or leave a
   verifiable ownership record for reconciliation, according to the OS contract.

The private launch pipe is an ownership mechanism, separate from optional
parent/runner TCP delivery. Restrict inherited handles/descriptors: an accidental
extra writer can prevent EOF and strand a bootstrap. Test that condition.

### Established mechanisms and their limits

Windows supports creating a process with its primary thread suspended. Job
Objects manage groups of processes and can terminate members when the last
owning handle closes. These are useful building blocks, but creating suspended
and then assigning a job still needs crash handling between those steps. Put
the payload job under the runner, and control handle inheritance so restarting
the daemon does not destroy active tasks.
[Process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Linux cgroup v2 provides `cgroup.kill` for terminating a contained hierarchy,
including concurrent forks. Availability and delegation are deployment
constraints; requiring root or systemd for every desktop install would be a
substantial product change. Treat this as an optional stronger backend unless
the supported deployment contract explicitly permits it.
[Kernel cgroup v2 documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html).

Linux parent-death signals can help with a direct child, but they have timing,
thread-parent, and inheritance constraints. They are not a portable whole-tree
ownership solution. In particular, do not attach runner death to daemon death.
[PR_SET_PDEATHSIG](https://www.man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html).

On macOS, the private bootstrap gate and native identity validation still need
their own implementation and tests. POSIX groups and parent-PID walks alone
cannot promise containment of arbitrary detached descendants. Explicitly define
the supported behavior for double-fork/setsid rather than claiming universal
cleanup from a Linux or Windows implementation.

### Practical acceptance tests

Use a test-only binary with named barriers at these boundaries:

| Barrier | Kill target | Required observation after recovery |
| --- | --- | --- |
| Intent durable, bootstrap not created | Runner | No payload marker; no command executed |
| Bootstrap created, identity not persisted | Runner | Bootstrap exits on EOF/deadline; payload marker absent |
| Identity persisted, release not sent | Runner | No payload execution; recorded ownership resolves cleanly |
| Release sent, acknowledgement absent | Runner | Zero or one execution, never automatic second launch; uncertainty is explicit |
| Payload running | Daemon worker | Same runner and payload survive and are adopted |
| Payload running | Runner | Owned descendants die or are reconciled within the supported platform bound |
| Terminal record persisted, notice absent | Daemon or runner | Stored result is delivered once |

The payload creates a marker with exclusive creation, increments a durable test
service counter, and spawns a resistant child. An independent harness inventories
the child identities and output after restart. Check both no duplicate effects
and no live owned descendants. For unsupported escape behavior, require an
explicit capability limitation rather than an unconditional passing assertion.

First demonstrate the current hard-kill window with a barrier before identity
publication. Keep a corresponding regression that fails when the launch gate is
bypassed. Fixed delays and hoping to hit the race are insufficient acceptance.

**Pass condition:** no user payload before ownership commit; ambiguous release
never triggers blind retry; cleanup guarantees match the native capability.

## CO-05: recover tool outcomes without duplicating external effects

### Current behavior and failure scenario

[`startRunner`](../indirect-code-daemon/cmd/daemon/runner_client.go) generates a
new random job ID for each launch. [`runner.Spec`](../indirect-code-daemon/packages/runner/spec.go)
does not currently establish a durable tool-call-to-execution mapping.
[`repairToolUseResultPairs`](../indirect-code-daemon/packages/core/message.go)
repairs a missing result with a generic aborted-call message so the transcript
remains acceptable to a provider.

Suppose a command successfully submits a deployment, sends a message, or changes
a file, then the daemon crashes before its tool result is persisted. The generic
repair cannot determine whether the action happened. The resumed model may try
again. This is a risk of duplicate effects, not a claim that the existing code
unconditionally re-executes every missing tool result.

### Proposed implementation

1. Assign an execution identity before launch, tied to a stable logical turn
   and tool invocation. Persist the mapping to the runner/job. Include session
   identity and branch/fork semantics; actor `epoch`/`gen` change on recovery and
   are unsuitable as the sole idempotency key.
2. Record the intended operation and its fingerprint before release. The same
   key with materially different arguments must be rejected, not reused as if
   it were the same operation. A retry of the same invocation reuses the key;
   a deliberately new user action receives a new key.
3. Resolve outcomes from durable evidence: prepared, running, completed, or
   unknown. Reuse an existing live runner or its recorded result. A missing
   transcript row is not evidence that execution never started.
4. When evidence is insufficient, report that execution may have happened and
   block automatic re-execution of that invocation. Prefer read-only verification
   of the external state. Require an explicit decision before repeating an
   effect that cannot be safely deduplicated. Do not apply this extra decision
   to ordinary known-safe read-only operations.
5. For remote APIs that support idempotency tokens, pass a stable token and
   preserve their retention and parameter-matching rules. A local receipt cannot
   implement remote exactly-once behavior by itself.
6. For arbitrary bash/python, document the limit: wrappers cannot undo an
   already-sent HTTP request or a non-transactional file append. Preserve the
   original log and uncertainty instead of rewriting history as “not executed.”
7. Retain execution receipts for at least the supported replay horizon. Make
   compaction, session edits, fork, deletion, and GC rules explicit so a pruned
   transcript cannot accidentally authorize the same execution again.

Conceptual decision table:

| Durable evidence for the same invocation | Recovery action |
| --- | --- |
| Definitely prepared and never released | Continue the original gated launch if policy allows |
| Live verified runner | Adopt it; no second launch |
| Completed receipt | Reconstruct the result and deduplicate transcript delivery |
| Release/external effect may have happened, result absent | Mark unknown and reconcile; no blind re-execution |
| Same key with a different operation fingerprint | Reject the conflicting request |

### Established example

AWS describes client-provided request identifiers for safe retries, including
EC2 operations. The identifier distinguishes a retry from a new intent, and its
record must be coordinated with the operation's effects. The daemon can adopt
the stable-identity idea while recognizing that arbitrary shell effects are
outside a local atomic transaction.
[Amazon Builders' Library: idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

### Practical acceptance tests

**CO-05-A — remote success, lost local result**

Use a separate fake HTTP service with a persistent side-effect ledger. Let a
tool create one resource, then hard-kill the daemon after the service commits
but before the transcript records the result. Restart through boot and use a
scripted provider that requests the same invocation again. With remote
idempotency support, the resource count must remain one and the original result
must be recoverable. Without that support, recovery must expose uncertainty and
prevent an automatic duplicate request.

**CO-05-B — intentional repetition versus retry**

The same execution key and arguments return the existing outcome. The same key
with different arguments fails explicitly. A new logical invocation with the
same command is permitted and creates its own effect. Repeat after transcript
compaction, actor respawn, and session fork to test key scoping.

**CO-05-C — file effects and receipt loss**

Use an append-only test file and a separately persisted observer count. Kill at
launch release, after append, after runner completion, and after transcript
incorporation. Assert the recovery decision from the table above. Deliberately
remove or corrupt the receipt in a fixture: the outcome must become unknown,
not automatically “safe to execute.”

**Pass condition:** a transport retry or recovery never becomes a second external
effect without either verified idempotency or an explicit new execution decision.

## Test infrastructure and release gates

### Make failure positions deterministic

Use a small test-only fault interface and a helper binary built with an explicit
test build tag. Production builds must not expose environment-variable crash
switches. Each barrier tells the harness that a named transition has been reached
and waits for release or forced termination. Keep the ordinary shell and runner
paths underneath the instrumentation.

Use barriers for scheduling and a separate injectable file-operation boundary
for errors such as ENOSPC, EIO, short write, failed sync, failed rename, and a
failure after rename. Fault injection must run once and persistently after the
selected operation. Confirm the injector was actually reached.

SQLite's test strategy includes I/O fault injection at successive operations,
both single failures and persistent failures, plus crash testing. That is the
useful model here: systematically enumerate boundaries instead of relying only
on random process kills. [How SQLite is tested](https://www.sqlite.org/testing.html).

### Use an independent observer

The harness must outlive the killed component and own its temporary directory,
fake provider, and side-effect service. Inspect disk files using a fresh process
after recovery. Track child birth identities, not just names or numeric PIDs.
Retain the original failure before test cleanup kills remaining fixtures.

For each case assert:

- Complete acknowledged transcript/receipt contents, including multiplicity.
- Number of actual payload launches and external effects.
- No unrelated process killed and no supported owned descendant left running.
- Correct original logs and permitted final output paths.
- One active owner per session, with old owners dead before replacement.
- A bounded recovery time or a visible terminal degraded/unknown condition.
- A second restart changes neither the effect count nor delivery count.

Merely checking “no panic,” “the process exited,” or “the JSON parses” is not a
sufficient recovery test. Include a negative control: disable the guard under
test and verify that the regression detects the intended failure.

### Separate process-crash tests from power-loss tests

SIGKILL leaves the kernel and its page cache alive. Container termination also
does not establish power-loss durability. For the stronger host-failure claim,
use a disposable VM and controlled storage backend, cut the VM at persistence
barriers, then reopen the same virtual disk in a fresh VM. Record filesystem,
mount options, and storage/cache settings with results. A real ENOSPC check can
use an isolated quota/loopback filesystem; never fill the developer's main disk.

Power-loss validation is a separate scheduled/manual gate unless the project
chooses to promise that guarantee for every interactive event. Ordinary process
crash recovery should not require a new privileged runtime dependency.

### Commands and CI placement

Existing baseline gates, from `indirect-code-daemon/`:

```sh
go vet ./...
go test ./... -count=1 -timeout 900s
go test -race ./... -count=1 -timeout 1200s
```

Suggested future test prefix: `TestCrashContract`. These commands become useful
only after the proposed tests exist; currently a matching command could pass
without executing any tests:

```sh
go test ./cmd/daemon ./packages/runner -run '^TestCrashContract' -count=20 -timeout 1200s
go test -race ./cmd/daemon ./packages/runner -run '^TestCrashContract' -count=5 -timeout 1200s
```

Inspect `go test -list` or JSON test events and require every expected case to
run. Native Windows tests must terminate real Windows processes and exercise the
chosen ownership backend; excluding POSIX-only tests is not equivalent coverage.

Put portable deterministic cases in the existing six native lanes and Alpine.
Keep Linux race coverage. Put privileged cgroup and VM power-loss tests in
separately identified jobs with capability checks and explicit skip accounting.
Use seeded repeated crash sequences for a longer nightly/manual run, retaining
the seed and event schedule as artifacts when it fails.

After production daemon changes, refresh the local binary and all six committed
release artifacts using the existing build commands. Run the full GitHub CI on
the actual `dev` commit and record its SHA and URL. A local pass, cross-compile,
old green run, or skipped native case does not complete the release gate.

## Implementation order and completion criteria

1. Add narrowly scoped fault seams and reproductions for CO-01 and CO-02.
   Implement checked publication and verified process identity first.
2. Add bounded supervision in CO-03, including negative cases for legitimate
   waits, update handoff, and background-runner survival.
3. Prototype CO-04 on each OS before promising a common guarantee. Ship the
   smallest mechanism that meets the declared ownership contract, documenting
   optional stronger containment separately.
4. Implement CO-05's stable execution mapping and unknown-outcome handling;
   connect it to the launch gate and durable completion records. Remote
   idempotency remains provider/operation specific.
5. Require the complete native CI and repeated barrier tests. Add VM power-loss
   evidence only for the durability claims actually promised.

A work item is complete when its reproduction fails on the old behavior, its
positive and negative acceptance cases pass on the supported platforms, recovery
is idempotent across a second restart, and documentation describes the remaining
limits. These are additions to the current design, not a requirement to build
a general actor framework or promise recovery from every possible hardware fault.
