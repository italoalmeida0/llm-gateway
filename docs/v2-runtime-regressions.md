# V2.0.1 runtime regressions

The previous CI passed reducer, process, and platform suites but did not run the
complete application update or prompt-admission flows. The handoff script also
contained a stale launcher variable and boot arguments. These gaps allowed real
runtime defects to ship; the following regressions now have executable coverage.

| Symptom | Cause | Correction |
| --- | --- | --- |
| Update disconnects and fails with `text file busy` or a Windows sharing error | The downloaded application already runs inside the destination slot. `stageAppTo` opened that same executable with truncation. | Detect the same file and reuse the verified image. When copying is necessary, stage to a separate temporary file before rename. |
| Completed tools reappear as unnamed rows | Core persists a tool result before emitting its display event. The actor added that committed result back into the transient overlay, retaining it into later tail pages that no longer contained its call. | Never retain an already committed result; continue clearing results committed after emission. The browser only applies transient results whose calls belong to the snapshot. |
| `undefined` at turn start/end | The running event omitted `turn.status`; finalization persisted `done`, while the UI expected `completed` or `cancelled`. | Emit a complete running activity and persist the actual outcome. Normalize already released status shapes at the browser boundary. |
| A six-minute sleep looks cancelled | Every tool received a five-minute watchdog allowance. A legitimate longer sleep looked stuck. Retry backoff also lacked its own declared wait. | Derive sleep wait from its actual bounded arguments plus watchdog margin; declare the full retry delay. |
| A request timeout ends a task | Request cancellation/deadline errors were treated as cancellation of the parent turn. | In persistent mode, the parent context owns Stop. Individual request, preparation, and compaction failures back off and retry. Consecutive empty/completion nudges retain their configured caps. |
| Windows reports a session file busy while finalizing | Atomic session replacement can race a reader that has not shared delete access. | Retry only Windows sharing/locking/access-denied replacement errors for a bounded interval, without deleting or rewriting the destination in place. Persistent failures still preserve recovery data and reach the actor's existing retry state. |
| Sending appears to start a task which disappears after refresh | The composer fabricated the user bubble/running state and discarded the draft before admission. Errors had no prompt correlation. | Prompt requests carry a request ID and receive acceptance or correlated rejection. Keep the draft/attachments until accepted; daemon events own the actual bubble and running activity. No automatic resend after an ambiguous timeout. |
| A message sent shortly after Stop disappears or never starts | Stale browser running status selected `queue_add`, bypassing admission and erasing the draft. A cancelled turn deliberately does not drain its queue. | Send every normal composer message through `prompt`; the actor decides whether to start or queue and confirms the result. While cancellation or failed persistence is still pending, reject explicitly and retain the draft. |

## Validation

- `TestStageAlreadyRunningSlotApp` executes a copied test image from its own
  destination slot. It reproduced Linux `text file busy` before the fix; the
  same test runs natively on Windows.
- `TestTranscriptCommittedResultsNeverLeakIntoLaterPages` follows the actual
  WAL-before-display order, rather than only the reverse order previously tested.
- `TestFinishedTurnPersistsItsActualOutcome` reloads completed, cancelled, and
  failed outcomes from disk.
- `TestV2ToolEventsDeclareAndClearWait` covers a six-minute sleep and a
  thirty-minute retry without spending that wall time.
- Core tests distinguish request deadlines/cancellation from parent cancellation
  and verify the consecutive nudge limits.
- Windows tests hold a real session handle without delete sharing while saving,
  then release it; a persistent read-only replacement must preserve the old file.
  The same bounded rename retry is shared with runner state publication:
  polling a state file must not abort launch or disable IPC due to a brief lock.
  `TestStopThenPromptDuringWindowsSessionLock` holds that lock across cancellation,
  verifies explicit rejection without queue/turn mutation and retained WAL, then
  releases it and verifies a fresh prompt survives disk reload.
- `test-indirect-daemon-protocol.ts` runs the real daemon against a local fake
  WebSocket gateway/provider. A real sleep exceeds an accelerated generic tool
  allowance, expires normally, encounters a 503, and continues to explicit
  completion. It also verifies Stop, reload, and prompt rejection, including
  sending follow-ups one and five seconds after Stop, provider receipt, and
  exactly one durable user message. Completion must match the new running
  activity; a delayed idle event from the cancelled turn is not sufficient.
  This runs three times on all six native platforms.
- Chromium exercises snapshots containing stale out-of-page results and rejected
  prompt admission with the draft preserved and no fabricated running turn.
  It also exercises Stop followed by submission while browser status is stale.
- `test-indirect-handoff-e2e.ts` now runs update and rollback with real old/new
  executables in all six native CI lanes. `OLD_DAEMON_BINARY` optionally starts
  from an actual installed release; Linux was also checked against the committed
  2.0.1 executable. The gateway CI job runs both browser fixtures and the real
  daemon protocol test.

These tests cover deterministic local failures without model credentials. They
do not simulate every antivirus, filesystem, or external provider. A permanent
disk failure still surfaces an error; it must not be hidden or reported as a
successful durable commit. Publishing a new version remains a separate release
step after the final commit passes CI.

Deploy the frontend and daemon changes together. Older daemons do not emit
`prompt_accepted`; the updated composer will retain the draft and report a
confirmation timeout rather than invent acceptance. Check the conversation
before retrying an ambiguous send during an upgrade.
