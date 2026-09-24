# Daemon logging: prod-clean vs dev-trace (DECIDED)

## The rule

- **prod** (release binaries): only lifecycle + warnings. Startup, connect/
  disconnect, turn start/finish, approvals, bg job transitions, watchdog
  escalations, errors. No per-message dumps, no payload contents.
- **dev** (`ICD_TRACE=1` or `-trace` flag): append-everything JSONL with
  timestamps — every inbox/control message, every WAL event, every state
  transition, every watchdog verdict, every drop. Written to
  `<dataDir>/trace/<date>.jsonl` (never stdout — stdout is for the launcher).

## Why not printf-everywhere

`fmt.Printf` in the hot path costs a syscall per line and interleaves
across goroutines (no timestamps, no structure). The trace sink is one
buffered writer + one mutex, sampled by tests via theory-replay: feed a
trace file to a replayer test and assert the state machine path.

## What gets traced (dev only)

- actor: every `handleData`/`handleControl` payload type + gen/epoch +
  state before/after (never full message bodies for user text — hash or
  length; content stays out of logs by the secrets rule).
- worker: hook entries/exits, approval/question waits + resolutions,
  WAL appends (type + turn, not content).
- supervisor: route hit/miss/spawn, evict decisions + bytes, watchdog
  rounds + verdicts, passivate/quarantine transitions.
- bg: register/finish/cancel/deliver + sleep wake-ups.
- drops: every `default:` drop with a counter name (inbox full, control
  full, ws outbound drop).

## Implementation notes

- One `trace(ev)` helper, no-op when disabled (single atomic load).
- Trace writer: buffered 64KB, flush per turn-index, fsync on commit —
  same durability posture as the WAL, separate file.
- `ICD_TRACE=1` also enables `droppedRequeue`-style counters in
  `session_status` debug payloads (never in prod responses).
- Theory tests: `trace_replay_test.go` loads a golden trace and asserts
  the transition sequence — this is how perf tuning gets evidence
  instead of guesses (feeds F4 bench plan).

## Status

IMPLEMENTED (core). Sink (`trace.go`: JSONL per-day, 0600, flush-per-write
in dev, single-check no-op in prod) + `ICD_TRACE=1` gate + `setTraceDir` at
boot. Wired: actor dispatch/state/WAL/waits/timeouts/cancel/quarantine/
drops, worker approve/question/convert/finish/drop, supervisor
route/evict/watchdog-rounds/passivate, bg register/finish/cancel/deliver/
wake, ws dispatch/health.

## Golden traces (theory-testing) — LIVE, not fiction

The contract is enforced by scenarios that RUN the real actor/bg/supervisor
with tracing on and assert the emitted sequence (`trace_live_test.go`):

| scenario | asserts |
|---|---|
| `scenarioTurn` | exact: msg→state→msg→state |
| `scenarioApproval` | exact: prompt→wait→answer→resume→finish |
| `scenarioStaleApproval` | `actor.approval.stale` then real approval |
| `scenarioTimeout` | wait→timeout→cancel |
| `scenarioQuarantine` | cancel→quarantine→state |
| `scenarioQuestionAnswered` | wait→question |
| `scenarioQuestionStale` | `actor.question.stale` then real answer |
| `scenarioWaiterLost` | `actor.waiter.lost` (consumed waiter) |
| `scenarioBgWake` | register→finish→wake |
| `scenarioBgCancel` | register→cancel |
| `scenarioEvict` | route→evict→passivate |

Delete a `trace()` call and these fail — the goldens are derived from
behavior. `TestTraceSchemaContracts` runs every scenario and enforces each
event's grep-keys; uncovered events must be listed in `knownGaps` with a
reason, so the backlog is explicit and CI never smiles at a silent gap.
`testdata/trace/*.jsonl` remain as human-readable historical backbones.

Workflow (the owner's motto): bug report ships with a trace (`ICD_TRACE=1`
run), the fix ships with a scenario asserting the corrected sequence, and
the schema test guarantees the next debugger can still grep it at 3am.

## Still open (with F4 bench work)

- `ICD_TRACE=1` enabling debug counters in `session_status` payloads.
- `worker.*` scenarios (need a real `turnBridge` + fake provider).
- Drop-path scenarios (`worker.drop`, `actor.drop`) with a saturated inbox.
- ws outbound drop counter trace (`ws.emit` drop path).
- Perf: measure sink overhead under load before trusting it in long
  dev sessions (flush-per-write is crash-safe but syscall-heavy).
- `withTrace` mutates package-level state: never add `t.Parallel` to the
  trace tests without a per-test sink first.
