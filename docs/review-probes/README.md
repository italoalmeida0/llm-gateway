# V2 review reproductions

The first section preserves the original review. For the current source, use
the permanent `TestRecovery*` tests described under
[recovery fixes](#recovery-fixes). The saved probes preserve the historical
failures and can also be run against the fixed tree.

[v2_architecture_test.go.txt](v2_architecture_test.go.txt) preserves the five
diagnostic probes used in the review of `7f2c8c0`. The `.txt` suffix keeps these
known-failing tests out of ordinary builds and test discovery. They use existing
helpers from `cmd/daemon/review_probe_test.go`.

Run this from the repository root. The Go overlay adds the test file for this
invocation only; it does not create a source file in the repository:

```sh
python3 - <<'PY'
import json
from pathlib import Path
import subprocess
import tempfile

root = Path.cwd()
source = root / "docs/review-probes/v2_architecture_test.go.txt"
target = root / "indirect-code-daemon/cmd/daemon/v2_architecture_review_test.go"
assert source.is_file(), "Run from the repository root"
assert not target.exists(), "Overlay target already exists; choose another filename"
with tempfile.TemporaryDirectory(prefix="llmgw-v2-review-") as directory:
    overlay = Path(directory) / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(target): str(source)}}))
    result = subprocess.run([
        "go", "test", "-overlay=" + str(overlay), "./cmd/daemon",
        "-run", "^TestV2Architecture", "-race", "-count=1",
        "-timeout", "40s", "-v",
    ], cwd=root / "indirect-code-daemon")
raise SystemExit(result.returncode)
PY
```

**Expected baseline result: nonzero exit.** The tests assert correct behavior
and fail on the reviewed implementation. No credentials, external model, browser,
or production installation are needed. They use temporary session directories.

| Probe | Observed failure | Review item |
| --- | --- | --- |
| `TestV2ArchitectureHealthySilentProvider` | The request completes without the watchdog; the watchdog cancels the same healthy delayed request | V2-001 |
| `TestV2ArchitectureCriticalWSDelivery` | Actor waits for approval; delivered approval count is zero and drop count is one | V2-002 |
| `TestV2ArchitectureBGCompletionDelivery` | Completion notice disappears when the session inbox is full | V2-003 |
| `TestV2ArchitectureReconnectApproval` | `get_session` omits the still-pending approval | V2-004 |
| `TestV2ArchitectureDispatchIsolation` | The sequential dispatcher delays health behind a busy session read | V2-006 |

The provider probe scales the watchdog interval to 50 ms and the response delay
to 450 ms; it exercises the real worker/provider request. Other probes deliberately
control queues or actor scheduling to reproduce specific boundary failures. They
are not throughput benchmarks or full browser tests.

When implementing fixes, adapt these into permanent tests of the chosen contract.
For example, a deliberate connection reset plus successful resynchronization is
a valid solution to V2-002 even though the original probe expects direct delivery.
V2-003 may use an acknowledged retry that must be driven to completion in the
test. V2-006 needs a real socket test if isolation moves into the read loop rather
than `dispatch`. Do not weaken the observable acceptance criteria to make a
fixture pass, or require an internal implementation solely to preserve a probe.

For V2-005, the original reproduction was the Python block under `Verify checksums
and manifests` in `.github/workflows/release.yml`, executed from the daemon's
`dist` directory. It raised `KeyError: 'launcher'` against the daemon-only manifest.
After the fix, test the shared production validator directly in CI and release.

The V1 automatic-update probe is deliberately excluded: the project owner chose
a manual V1-to-V2 transition, so restoring that behavior is not part of this work.

## Post-fix status (V2 hardening change-set)

The permanent regression tests live in
`cmd/daemon/v2_architecture_test.go`. Two probes assert expectations the
review itself re-scoped (see the guidance above); their chosen contracts
are covered by the permanent tests instead.

| Probe | Status after the fix |
| --- | --- |
| `TestV2ArchitectureHealthySilentProvider` | PASSES (V2-001: declared waits) |
| `TestV2ArchitectureCriticalWSDelivery` | Superseded — the chosen contract is an explicit resync (`TestV2BackpressureResyncRestoresDecision`) |
| `TestV2ArchitectureBGCompletionDelivery` | Superseded — the contract is EVENTUAL delivery, retried until ack (`TestV2BGCompletionRetriedUntilAck`, `TestV2BGNoticeFoldedExactlyOnce`) |
| `TestV2ArchitectureDispatchIsolation` | PASSES (V2-006: per-session dispatch lanes) |
| `TestV2ArchitectureReconnectApproval` | PASSES (V2-004: snapshots restore pending decisions) |

## Runner follow-up at 796d726

These probes support [the 2026-09-26 follow-up](../v2-runner-follow-up.md).
They assert the desired behavior and intentionally fail on the reviewed commit:

- [runner_review_test.go.txt](runner_review_test.go.txt): eight daemon probes
  using real runner subprocesses, the supervisor, actor, and filesystem.
- [runner_state_review_test.go.txt](runner_state_review_test.go.txt): a command
  crossing the real heartbeat interval, checked with the race detector.
- [sse_review_test.go.txt](sse_review_test.go.txt): LF passes; CRLF fails in the
  current SSE adapter. Both pass with `sse.go` from `7f2c8c0`.

Run on **Linux**, from the repository root, with Go and Python 3 available.
The process probes use POSIX shells/signals and clean up their own command
groups. They do not contact a model or use the daemon's real data directory.
The test helper builds a temporary application binary. No implementation files
are edited; the temporary overlay only adds diagnostic test files.

```sh
python3 - <<'PY'
import json
from pathlib import Path
import subprocess
import tempfile

root = Path.cwd()
daemon = root / "indirect-code-daemon"
sources = {
    "cmd/daemon/runner_rereview_test.go": "runner_review_test.go.txt",
    "packages/runner/runner_state_rereview_test.go": "runner_state_review_test.go.txt",
    "packages/provider/sse_rereview_test.go": "sse_review_test.go.txt",
}
replacements = {}
for target, source in sources.items():
    target_path = daemon / target
    source_path = root / "docs/review-probes" / source
    assert source_path.is_file(), "Run from the repository root"
    assert not target_path.exists(), "Choose an unused overlay target"
    replacements[str(target_path)] = str(source_path)

with tempfile.TemporaryDirectory(prefix="llmgw-runner-review-") as directory:
    overlay = Path(directory) / "overlay.json"
    overlay.write_text(json.dumps({"Replace": replacements}))
    result = subprocess.run([
        "go", "test", "-race", "-overlay", str(overlay),
        "./cmd/daemon", "./packages/runner", "./packages/provider",
        "-run", "^TestRereview", "-count=1", "-v", "-timeout", "90s",
    ], cwd=daemon)
    raise SystemExit(result.returncode)
PY
```

Expected evidence at `796d726`:

| Probe suffix after `TestRereview` | Expected failure | Finding |
| --- | --- | --- |
| `RunnerForegroundNotReplayed` | Consumed inline command gains a background notice on restart | V2R-001 |
| `RunnerAssistantCancelNotReplayed` | Silent assistant cancellation gains a notice on restart | V2R-001 |
| `RunnerKillEscalatesAfterLeaderExits` | TERM-resistant descendant survives the runner | V2R-002 |
| `RunnerHardKillDoesNotLeaveCommandRunning` | State says killed while the command still runs | V2R-002 |
| `RunnerRecoveryKeepsExitStatus` | State has exit 7; registry reports orphaned/unknown | V2R-003 |
| `HeartbeatAndTerminalState` | Race in state mutation/serialization after the first heartbeat | V2R-004 |
| `SSELineEndings/CRLF` | Two events become one payload containing CR bytes | V2R-005 |
| `RunnerPythonStdin` | Expected `got:ping`, received `got:` | V2R-006 |
| `WSResyncSurvivesAnotherFullQueue` | Lost repair snapshot leaves no pending repair | V2R-007 |
| `NoticeDoesNotAckFailedPersistence` | Failed session save still emits an acknowledgement | V2R-008 |

These are focused reproductions, not the full acceptance suite. In particular,
the supervisor restart probe models the replacement supervisor without killing
the test process. Add a separate-process daemon SIGKILL test for the final
recovery gate. After changing the design, adapt the fixtures while preserving
their user-visible guarantees.

## Verification at 4958354

The ten original runner follow-up probes, promoted as `TestRegression*`, pass
on `4958354`, including with the race detector. To check those fixes from the
daemon root:

```sh
go test -race ./cmd/daemon ./packages/runner ./packages/provider -run '^TestRegression' -count=1 -v -timeout 150s
```

[runner_verification_4958354_test.go.txt](runner_verification_4958354_test.go.txt)
contains six additional acceptance-path reproductions. They fail on `4958354`
and support the [verification report](../v2-runner-follow-up.md#verification-at-4958354).
Use Linux, Go, and Python 3. The shell/process tests run real temporary runner
subprocesses and clean up their own process groups. No live service or model is
used. Run from the repository root:

```sh
python3 - <<'PY'
import json
from pathlib import Path
import subprocess
import tempfile

root = Path.cwd()
source = root / "docs/review-probes/runner_verification_4958354_test.go.txt"
target = root / "indirect-code-daemon/cmd/daemon/runner_verification_test.go"
assert source.is_file(), "Run from the repository root"
assert not target.exists(), "Choose an unused overlay target"
with tempfile.TemporaryDirectory(prefix="llmgw-runner-verification-") as directory:
    overlay = Path(directory) / "overlay.json"
    overlay.write_text(json.dumps({"Replace": {str(target): str(source)}}))
    result = subprocess.run([
        "go", "test", "-race", "-overlay", str(overlay), "./cmd/daemon",
        "-run", "^TestVerify4958354", "-count=1", "-v", "-timeout", "90s",
    ], cwd=root / "indirect-code-daemon")
    raise SystemExit(result.returncode)
PY
```

| Suffix after `TestVerify4958354` | Expected failure at 4958354 | Finding |
| --- | --- | --- |
| `AdoptedAssistantCancelStaysSilent` | Adopted job retains `background` disposition after assistant cancel | V2R-001 |
| `RunnerDeathAfterAdoptionReapsCommand` | Watcher reports failure while the command keeps executing | V2R-002 |
| `AdoptedStopEscalatesResistantLeader` | Adopted Stop never escalates against a TERM-resistant leader | V2R-002 |
| `ResyncRetainedWhenSnapshotBusy` | Snapshot timeout discards the recovery mark | V2R-007 |
| `NoticeRetryStillRequiresPersistence` | Second delivery acknowledges the unsaved RAM identity | V2R-008 |
| `TerminalRecoveryUsesReadableBrainLog` | Recovered notice advertises a path denied by the session sandbox | V2R-010 |

These are behavioral failures under `-race`, not additional race-detector
reports. The adoption tests exercise a replacement supervisor against actual
runner processes; they do not replace the final separate-process daemon crash
and browser gates.

## Recovery fixes

The six verification cases now pass and live in
`indirect-code-daemon/cmd/daemon/runner_recovery_test.go` and
`runner_recovery_posix_test.go`, named `TestRecovery*`. The persistence test also
checks successful retry and disk reload without duplication; the resync test
checks automatic delivery after the actor recovers, without other socket traffic.
An additional cancellation-persistence test verifies that a failed disposition
write does not stop a job or report a successful silent cancel.

`packages/runner/cancel_posix_test.go` verifies IPC kill escalation with a
TERM-resistant command leader, without the daemon's fallback. Run from the
daemon root:

```sh
go test -race ./cmd/daemon ./packages/runner ./packages/provider -run '^(TestRecovery|TestRegression|TestKillVerbEscalatesBeforeCommandWaitReturns)' -count=1 -v -timeout 150s
```

The full Go race suite has also passed after these changes. The original `.txt`
files remain historical diagnostic fixtures, not the source of the permanent
tests. See [the implementation record](../v2-runner-follow-up.md#implemented-recovery-fixes)
for validation and remaining release gates.
