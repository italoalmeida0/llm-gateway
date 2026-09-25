# Cross-platform daemon validation

Baseline: `dev` at `1a6b52d`, failed [CI run 36135104975](https://github.com/italoalmeida0/llm-gateway/actions/runs/36135104975).
Reference: `tmp/unish`, cloned at `82da4f40f8f9100325a7593e40013757ca1ed7aa` (ignored local checkout).

## Progress

- [x] Read the existing hardening decisions and inspect each failed CI job.
- [x] Clone unish and inspect its platform implementations and CI.
- [x] Build the daemon before gateway integration tests in clean CI checkouts.
- [x] Fix process liveness and slot discovery on macOS; test actual child processes.
- [x] Replace Windows PowerShell process identity probes with native APIs.
- [x] Repair and resume torn WAL files on Windows without losing valid events.
- [x] Provision pinned unish in CI and exercise the real shell/tool boundary on every OS.
- [x] Audit relevant unish builtins; keep that repository unchanged per user clarification.
- [ ] Validate Python UTF-8 stdin/stdout/stderr and files on all platforms.
- [ ] Fix demonstrated search/inspect filter, output cap, and Unicode issues.
- [x] Run local gateway, daemon, race, and unish validation.
- [ ] Run GitHub CI for both repositories; fix failures and record final run links.
- [ ] Refresh local and committed build artifacts and write the final assessment.

## Acceptance criteria

All three native daemon jobs, the Linux race job, and gateway gates must pass for
the reviewed revision. Platform failures must be fixed rather than hidden with
new test skips. unish integration must use a pinned source revision and run real
commands, including failure and cancellation paths. No release tag or production
deployment is part of this task.

## Findings

- Gateway tests start `indirect-code-daemon/bin/indirect-code`, which is ignored
  and was never built by the gateway job.
- Unix liveness treats macOS zombies as live; slot discovery assumes Linux `/proc`.
- Windows process identity invokes PowerShell with a two-second timeout; CI
  classified its own live process as orphaned.
- Windows cannot truncate the append-only WAL handle used during tail repair.
- The download test hardcodes a Linux asset even when running on macOS.
- Windows intentionally requires unish, but the daemon matrix does not install it.

## Validation and assessment

First fix revision: `0001c23`; [CI run 36138483090](https://github.com/italoalmeida0/llm-gateway/actions/runs/36138483090).
Windows, Linux, gateway, and Linux race jobs passed. macOS found a fixture race:
stdout was observed before the child reached the separate stderr write. The test
now waits for both outputs with its existing deadline.

Local first pass: 382 Bun tests, lint, typecheck, full Go suite and race detector
passed. The real unish tool boundary passed (quoted Unicode paths, arrays,
stderr/exit code, 128 KiB line preservation, external-child cancellation).

unish reference validation: [run 36137889326](https://github.com/italoalmeida0/unish/actions/runs/36137889326)
passed Linux/macOS/Windows plus parity at `ab0be91` (only asset changes since the
reviewed source pin). Local parity: 372 cases, zero failures, nine documented
expected differences. No files or tests were changed in the unish repository.

The user clarified that unish is a reference for this daemon's tool behavior,
not a request to extend unish's internal tests or implementation. Further work
stays in the gateway repository.

Second pass in progress: Python defaults to UTF-8 while preserving an explicit
PYTHONIOENCODING override; search preserves capped count rows, enforces explicit
file size limits, propagates cancellation, and avoids splitting UTF-8 output;
search/inspect share precompiled recursive glob semantics; inspect honors
exclusions during traversal and parses raw NUL-delimited Git filenames.
