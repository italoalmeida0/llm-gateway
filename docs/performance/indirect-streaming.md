# Indirect Code streaming and background-tab performance

Measured on 2026-09-20 with headless Chromium 151 (Playwright Chromium build
1243), using the actual Solid transcript components and production CSS.

## Causes and changes

- The previous `streamdown-solid` path reparsed accumulated Markdown on each
  update. `StreamingMarkdown.tsx` now wraps `TarnavMarkdown.tsx`, ported from
  the user's **parity.html renderer** in `tmp/md-bench/src/tarnav`, including
  its DOM/CSS, live syntax highlighting, line gutters, fixed copy controls,
  file/command icons, KaTeX, table exports and malformed-input repairs.
  It feeds only appended characters to `streaming-markdown@0.2.15`, retains
  finished DOM, resets on edits, and flushes when streaming ends. Large
  snapshots yield every 8,192 input characters. The live block strategy runs
  on a set of changed nodes, without scanning previous fences or rows. Fences
  above 16 KB pace highlighting at 120 ms while still streaming, with a
  trailing update during token pauses and an immediate final flush. Source
  code is stored separately from highlighted
  DOM so gutter numbers never accumulate or enter clipboard contents.
- Previously opened disclosure bodies remain mounted to preserve scroll and
  expansion state. They now propagate activity: Markdown and highlighting
  pause when an ancestor closes, and filtered Markdown rows pause as well.
- The old hidden-event queue let status/finalization overtake text, discarded
  events beyond 2,000 entries, and replayed without the advertised Solid
  batch. `relayInbox.ts` coalesces adjacent deltas at ingestion, preserves wire
  order, and flushes bounded batches without dropping data. Visible batches
  use 32 ms timers; hidden batches use 250 ms, subject to browser throttling.
  The transcript ingests state while hidden but derives its view on return.
- USAL 2.0's global mutation observer scans the document for animation targets
  and shadow roots. It is suspended on `/code`, which has no USAL entrances,
  and restarted when leaving. Ordinary CSS animations remain.
- Unchanged historical turns reuse their derived presentation. Worker
  snapshots replay subsequent live events after normalization, reject stale
  results on session switches, and clean up their worker on disposal. Small
  snapshots commit synchronously before subsequent deltas.

No gateway protocol, daemon, or persisted transcript format changed.
The old renderer, its development dependency, patch and fixture adapter have
been removed from the main project. KaTeX CSS and fonts are bundled locally. Table download menus use the app's Portal and
floating-layer lifecycle. Raw HTML renders as text and links/images use a
protocol allowlist. No highlight size cutoff or completed-fence-only mode
is imposed: the parity renderer's live highlighting remains enabled, with
pacing on large fences to reduce repeated work.

## Measured comparison

Before removing the legacy benchmark dependency, separate pages ran 240 updates of 102 characters at a requested 16 ms interval,
totaling 24,480 characters of prose, bold text and file inline code. The old
path includes the previous renderer and global animation observer; the new
path includes the incremental renderer and observer suspension. These are
full-path results, not isolated parser timings.

| Measurement | Previous path | Updated path |
| --- | ---: | ---: |
| Elapsed time, including 200 ms settling | 20,999 ms | 4,204 ms |
| CDP browser TaskDuration | 19,735 ms | 817 ms |
| Synchronous setter p95 | 135.9 ms | 0.1 ms |

Browser task time fell **95.9%** (about 24 times less). Setter timing alone
is not a fair comparison because the new renderer schedules animation-frame
work; TaskDuration includes deferred work, style and layout. This synthetic
workload is not a guarantee for every device or Markdown document.

Additional browser checks:

- 100 turns, 200 messages, about 850 KB of reasoning: normalized and applied
  in 69 ms. Deltas and completion arriving during worker processing survived;
  switching sessions rejected the old snapshot.
- One turn with 120 tool steps, about 450 KB of old reasoning, and four
  hidden/visible cycles adding 108 KB: time to two animation frames after
  returning was 87, 32, 44 and 83 ms. This measures return responsiveness;
  large Markdown bodies continue filling in bounded slices. All 4,000
  incoming deltas were preserved.
- Assertions cover live highlighting before a fence closes; copy without
  duplicated gutter numbers; a copy button outside the scroller; live
  file/command icons; stable KaTeX source and bundled fonts; ragged tables
  streamed three characters at a time; clipboard TSV and downloaded CSV;
  floating-menu cleanup; loose inline-code repairs; final buffered characters;
  edit/reset; DOM identity; collapsed rendering pause; safe URLs/raw HTML;
  and zero page errors.
- A 49,746-character open TypeScript fence, streamed over 120 updates,
  retained live highlighting and all 2,160 numeric tokens after a token pause.
  Pacing reduced browser task time from 6,263 ms to 3,145 ms and the frame-gap
  p95 from 91 ms to 56 ms. Large fences still cost more than prose because
  each scheduled highlight processes the growing fence; this is not a claim
  of constant-time highlighting or smooth 60 FPS for arbitrary code.
- A local side-by-side check against the original parity renderer matched
  computed typography, spacing, colors and positioning for headings, prose,
  code, tables, icons, copy buttons and formulas in both themes. Its seeded
  agent scenario rendered the same 5 headings, 15 code fences, 5 tables and
  10 formulas in both implementations. This comparison uses the gitignored
  experiment; the committed browser gate is self-contained.
- The existing turn UI gate covers disclosure behavior, tool updates, stable
  row identity, final messages and file-change balloons.

## Reproduce current checks

The comparison above is a historical measurement. The browser gate now runs
only the current renderer, preserving the same 24 KB workload and the other
correctness scenarios. Its 5-second browser-task-time ceiling provides generous
headroom over the measured ~0.8 seconds while catching major regressions. The
independent experiment in `tmp/md-bench` retains its own comparison setup.

```sh
bun run build:web
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
bun scripts/test-indirect-streaming-ui.ts

PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_PATH=/path/to/chrome \
bun scripts/test-indirect-turn-ui.ts

bun run lint
bun run typecheck
bun test
```

Playwright remains external. The visibility fixture deliberately overrides
`document.hidden` and dispatches `visibilitychange`: it tests application
suspension without depending on headless Chrome's tab-throttling policy.
