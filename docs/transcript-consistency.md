# Transcript identity, ordering, and reading position

The daemon owns the transcript. The relay forwards messages; the browser keeps a
rebuildable projection. Array positions are command coordinates (`srcIdx` for
edit, discard, and fork), not message identities.

## Failures addressed

The regression suite first reproduced four independent failures: positional ID
reuse after replacement, a delayed assistant completion overwriting the next
assistant, duplicate tool results attaching to the wrong carrier, and replayed
assistant completion erasing an already delivered result. Additional inspection
found asynchronous snapshot/history races and unconditional layout changes at
turn end.

The fixes establish these contracts:

1. **Durable message identity.** Each new daemon message receives a random
   128-bit `m_` ID before emission/persistence. Streaming start and committed
   assistant use the same ID. Hydration, WAL, snapshots, and fork prefixes retain
   it. Regenerating the same raw index creates a different ID. Existing V2
   messages without IDs receive deterministic IDs when loaded; normal subsequent
   saves persist them. This is not automatic V1 migration.
2. **An ordered actor projection.** Every transcript event carries a
   `{stream, seq}` cursor. The stream changes with the actor incarnation; the
   sequence advances in the actor, not in the gateway or worker. A read captures
   the cursor together with copied live assistant content and uncommitted tool
   results. Committed WAL messages replace those transient overlays.
3. **Snapshot plus suffix, exactly once.** The browser retains at most 512 recent
   event callbacks. A snapshot replaces its authoritative tail, then replays
   only the contiguous suffix after its cursor. Duplicates are ignored; a gap or
   exhausted replay window requests a new daemon snapshot. Events from retired
   actor streams cannot overwrite their replacements. Sequenced deltas retain
   their original boundaries in the relay inbox.
4. **Explicit ownership.** Assistant updates target their message ID. Tool
   results upsert by call ID on the assistant containing that call, including
   delayed results separated by user messages. Snapshot normalization retains
   completed background folds only when both call and background job match.
5. **Async context isolation.** Snapshot commits check version, session, and
   host. History requests echo a request ID and check context again after worker
   normalization. Truncation invalidates pending historical work. Transcript
   metadata changes with its accepted snapshot/event, not with stale responses.
6. **Stable rendering and reading.** Solid reconciles messages by ID. Unpinned
   updates preserve the first surviving visible transcript anchor and offset.
   Initial-load completion cannot force an already unpinned reader to the tail.
   Activity phase changes do not automatically collapse disclosures or move the
   final answer out of its aggregate while unpinned. Explicit disclosure toggles
   still work; pinned conversations retain the normal automatic presentation.

For example, if normalization starts at sequence 40 and deltas 41 and 42 arrive
before it finishes, the browser commits snapshot 40 and applies 41/42 once. If
41 was lost, it requests a new snapshot rather than guessing text overlap.
If discard removes raw index 8, the next message at index 8 has a new ID, so
Solid cannot reuse the discarded message's local state as its identity.

## Executable validation

- `test/transcript-identity.test.ts`: the four original regressions, tail
  replacement, snapshot suffix replay, duplicate suppression, gap recovery,
  actor replacement, and delayed result ownership.
- `test/relay-inbox.test.ts`: sequenced deltas keep their cursor boundaries.
- `cmd/daemon/transcript_identity_test.go`: hydration/index reuse, isolated
  snapshot content with matching cursor, pending-result lifecycle, actor stream
  replacement, and retry before a new stream preserving committed history.
- `packages/core/message_identity_test.go`: streaming ID equals committed ID
  and survives hydration.
- `scripts/test-indirect-transcript-ui.ts`: Chromium with the real transcript
  hook, Solid reconciliation, and real disclosure components. Delays the history
  worker deterministically; verifies DOM identity, single tool result, snapshot
  replay, reading anchor, stale history rejection, discard/index reuse, session
  isolation, and unpinned turn-end disclosure behavior. Runs in the GitHub
  gateway CI job using Playwright 1.63.0.

Run from the repository root:

```sh
bun run lint
bun run typecheck
bun run build:daemon
bun test
go -C indirect-code-daemon test -race ./...
bun run build
bun scripts/verify-release-dist.ts
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chromium bun scripts/test-indirect-transcript-ui.ts
```

The existing `scripts/test-indirect-streaming-ui.ts` also exercises long tool
turns, background/resume cycles, and streaming Markdown rendering.

## Boundaries

The event window is count-bounded, not a durable transport log. Snapshot recovery
requires an available connection; reconnect must fetch current state. In-flight
text is recoverable while the actor lives, but only WAL-committed messages are
durable across process crashes. Old daemons without cursors use the legacy
fallback and cannot provide the new ordering guarantees; update both frontend
and daemon.

Scroll anchoring cannot preserve content that was deliberately discarded or
compacted away; it chooses the next surviving anchor or clamps the old position.
Browser tests use deterministic daemon envelopes, not a real model or every
mobile browser. Full CI, including native OS/architecture lanes and the race
detector, remains required on the final commit. Passing those tests is evidence
for these contracts, not a guarantee of zero UI bugs.

Solid's [reconcile](https://docs.solidjs.com/reference/store-utilities/reconcile)
and [For](https://docs.solidjs.com/reference/components/for) documentation explain
why stable data identity is necessary to retain the corresponding DOM state.
