# Cross-platform daemon and tool review

## Verdict

The actor design remains a good foundation. The failures were concentrated at
OS boundaries and CI provisioning, not evidence that the actor model needs to
be replaced. Fixing these boundaries and exercising real processes provides
more value than introducing a second execution framework.

Baseline: `1a6b52d` on `dev`. Reference source: the unmodified `tmp/unish`
checkout at `82da4f4`. The existing hardening plan and brutal updater behavior
remain in place.

## Changes and evidence

| Area | Previous behavior | Result |
| --- | --- | --- |
| Clean CI checkout | Gateway integration tests required an unbuilt ignored daemon binary | CI builds the daemon before starting the integration suite |
| macOS lifecycle | `/proc` assumptions made dead children appear alive and missed slot executables | Shared liveness probe excludes zombies; native `ps` discovers executable paths; tests cover spaces, sibling prefixes, and own-PID exclusion |
| Windows identity | PowerShell startup could exceed the identity timeout and orphan a live job | Native process creation timestamps preserve the existing pidfile identity format |
| Windows cancellation | Cancelling the context killed the shell root before its descendants | Cancellation stops the tree before the root disappears; a real external-child test runs in the native matrix |
| WAL recovery | Append-only Windows handles could not truncate a torn tail | Exclusive writer repairs through a writable handle and seeks to the valid boundary; replay and rollback-slot isolation are asserted |
| Python text | Redirected stdio and file defaults depended on the host encoding | UTF-8 defaults cover stdin, stdout, stderr, and text files; explicit `PYTHONIOENCODING` remains supported |
| Search count | Exceeding the row cap hid every count row | The first requested rows remain visible, with the total and cap notice |
| Search bounds | An explicit file bypassed the size limit; cancellation could look like no matches | Explicit files obey the limit; bounded reads handle concurrent growth; cancellation returns an error |
| Recursive filters | Search and inspect approximated globstar differently | Both compile the existing glob matcher once per call, including `src/**/*.ts` |
| Inspect exclusions | A directory missing the include pattern could bypass exclusion | Exclusions prune traversal independently of includes; depth still bounds traversal |
| Unicode paths | Git's quoted porcelain paths were parsed as ordinary text | NUL-delimited status preserves raw filenames and rename destination paths |
| Test synchronization | A crash test expected stderr immediately after observing stdout | The test waits for both independent writes within its deadline |

## What to reuse from unish

- **grep/find:** use their command semantics as a reference. Keep the daemon's
  structured tools in Go, sharing its glob compiler and retaining cancellation,
  output limits, sandbox checks, and stable workspace-relative paths. Copying
  all of unish's CLI parsing into these tools would add complexity without
  improving the model-facing contract. Search `count` retains this project's
  established occurrence-counting behavior.
- **Python Unicode:** unish configures Python child encoding explicitly. Apply
  the same principle to the dedicated Python tool, whose environment is built
  separately and previously missed those defaults. CI pins Python 3.12 and
  tests Unicode through both code and script execution, including accented
  workspace and file names.
- **jobs/processes:** use OS process APIs where available, following the same
  native Windows approach. Keep the daemon's job registry, identity checks,
  and persistent logs: shell-local jobs do not replace restart recovery.
- **Shell integration:** build unish from a fixed commit in the daemon matrix.
  Tests exercise `BashTool` against that executable, including shell syntax,
  quoted filenames, stderr, exit status, a 128 KiB line, and cancellation of
  an external child. No unish implementation or internal test was modified.

## Tradeoffs and scope

- No new runtime dependency or shell-library embedding was needed.
- macOS uses the OS `/bin/ps` for process metadata; unish's `/proc`-based
  process tools are not a replacement for that probe. Metadata failures remain
  conservative for liveness, while recovery requires a verified identity.
- Windows tree termination still relies on the system `taskkill` utility.
  The tests verify ordinary external descendants; deliberate process detachment
  is not a containment guarantee.
- The Git ignore implementation remains deliberately minimal, not full Git
  parity. Shell commands remain available for specialized searches.
- Linux amd64, macOS arm64, and Windows amd64 receive native execution tests.
  The other shipped architectures are cross-compiled, not executed locally.
- The build reports missing `pandoc.wasm`; optional office conversion is not
  available in this workspace. This is separate from the changes reviewed here.

## Validation

Final run links and artifact verification are recorded in
[the progress checklist](cross-platform-daemon-plan.md). A green matrix is
evidence for the behaviors tested, not a claim that every future edge case is
eliminated. The practical improvement over the baseline is reproducible native
coverage of failures previously hidden by Linux-only local testing.
