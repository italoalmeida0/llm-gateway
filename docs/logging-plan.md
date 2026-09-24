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

ACCEPTED by owner (report: "versão debug enche file de logs append com
timestamp; nada disso vai pra prod"). Not yet implemented — implement
with the F4 bench work.
