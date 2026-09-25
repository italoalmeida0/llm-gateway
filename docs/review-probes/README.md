# V2 review reproductions

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
