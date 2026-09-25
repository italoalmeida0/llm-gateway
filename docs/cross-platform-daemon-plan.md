# Cross-platform daemon validation

Baseline: `dev` at `1a6b52d`, failed [CI run 36135104975](https://github.com/italoalmeida0/llm-gateway/actions/runs/36135104975).
Reference: `tmp/unish`, cloned at `82da4f40f8f9100325a7593e40013757ca1ed7aa` (ignored local checkout).

## Progress

- [x] Read the existing hardening decisions and inspect each failed CI job.
- [x] Clone unish and inspect its platform implementations and CI.
- [ ] Build the daemon before gateway integration tests in clean CI checkouts.
- [ ] Fix process liveness and slot discovery on macOS; test actual child processes.
- [ ] Replace Windows PowerShell process identity probes with native APIs.
- [ ] Repair and resume torn WAL files on Windows without losing valid events.
- [ ] Provision pinned unish in CI and exercise the real shell/tool boundary on every OS.
- [ ] Audit relevant unish builtins and document useful reuse and remaining limits.
- [ ] Run local gateway, daemon, race, and unish validation.
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

Pending implementation and native CI results.
