# Runner plan: 100% recoverable background tasks

Status: **DRAFT — owner review requested before implementation.**
Scope: background tasks (long-running terminal/tool commands) become
independent *runner* processes that survive parent death, runner death
and updates — a real crash-only design.

This plan is written to be read in full: every flow, the protocol, the
file formats and the testing strategy are spelled out so the owner can
flag what is missing or wrong BEFORE code is written. Decisions the
owner should confirm are collected in [Open decisions](#open-decisions).

---

## 1. Goal

Today a background task already survives a daemon SIGKILL (pidfile
re-adoption + preserved logs + retained completion notices), but the
recovery is passive: the live stream does not resume, the exit code of an
adopted process is lost, and delivery degrades to polling files.

Runners make the task itself the owner of its lifecycle:

- The task keeps running and keeps its output intact through ANY parent
  death (SIGKILL, crash, deliberate brutal update).
- A restarted parent re-adopts live tasks and resumes streaming where it
  left off (no gaps, no duplicates).
- Real exit codes are always known (the runner is the direct parent of
  the command).
- Updates never orphan tasks: versioned runner binaries self-clean when
  their generation dies out.

## 2. Design principles (agreed with the owner)

1. **The FILE is the contract.** State file + log file are the durable
   surface. Everything (output, kill, liveness, completion) is possible
   with files alone. The socket is a latency optimization on top.
2. **The SOCKET is an optimization.** If it never comes up, or dies, or
   is from another protocol version, the system still works — it just
   falls back to file mode.
3. **Never verify the self-copied runner binary.** The project is open
   source; verification is bypassable theater and it slows the hot path.
   Copy if missing, run it.
4. **Immediate state file.** Durability never waits. The 10s window is
   ONLY the agent's foreground hold (same semantics as
   `AutoBackgroundAfter`): the tool call waits up to 10s, then detaches
   and tells the agent to go background.
5. **"All or nothing" applies to the BUILD version, never to protocol
   compatibility.** One artifact, one version. Protocol growth is always
   additive and tolerant (rules below).
6. **Never verify → never trust for security either.** The runner IPC is
   loopback + token; it is an integrity/robustness mechanism, not a
   security boundary against the local user.

## 3. Disk layout

```
<root>/                       (the existing home: slots/, brain/, logs/)
  runners/
    indirect-code-runner-<version>[.exe]   one self-copied binary per
                                           runner version (the multi-call
                                           binary copied under this name)
    <jobId>.state.json                     one state file per task
    out/                                   LIVE task logs — GC-EXEMPT
      <sessionId>__<jobId>__<startedAtMs>.log
```

**Live logs live in `runners/out/`, not in `brain/`** (decided D8): while
the task runs, its output is appended to `runners/out/<name>` — reserved
on the runner side, never handed to `brain/` yet. Only on a TERMINAL
transition (finished, died, or cleaned) is the final log **COPIED** (not
moved — essential per the owner) to the session's `brain/` location. The
out copy stays: `out/` is never touched by GC.

The filename is the identity (decided D8): `<sessionId>__<jobId>__<startedAtMs>.log`
— parseable and attributable even if the state file and the task itself
have already been cleaned.

Interim compatibility: the job's internal `LogPath` points at the `out/`
file while running and at the `brain/` copy after the terminal
transition, so today's tail/read machinery keeps working unchanged. The
model-facing read/placeholder redesign is the owner's future work (out
of scope here).

## 4. State file (`runners/<jobId>.state.json`)

Written immediately when the runner starts; rewritten atomically
(tmp+rename) on status transitions. Unknown fields MUST be ignored by
readers; the format is additive.

```json
{
  "v": 1,                    // state file schema version
  "proto": 1,                // IPC protocol version this runner speaks
  "runnerVersion": "1.0.34", // binary version (GC key)
  "jobId": "…", "sessionId": "…",
  "kind": "bash", "label": "build",
  "pid": 1234,               // runner pid (the command is its child)
  "startedAt": 1760000000000,
  "logPath": "<root>/brain/<sid>/… .log",   // output source of truth
  "transport": { "type": "tcp", "port": 41234, "token": "…" },
  "status": "running",       // running | done | killed
  "exitCode": null,          // set BEFORE the done transition
  "endedAt": null,
  "heartbeatAt": 1760000000000
}
```

Notes:

- `pid` makes "is this runner alive" a file-only question (`pidalive`).
- `transport` is optional: absent ⇒ the runner runs in file-only mode.
- `status: done` with `exitCode` set is THE completion record. It is
  written before any signal is sent, so a crash at any point cannot lose
  the outcome. This record also feeds the existing retained-notice
  machinery (see §8).

## 5. IPC protocol v1 (frozen)

Transport: **loopback TCP** bound to `127.0.0.1`, authenticated by a
bearer token. Token mechanics (decided D2): the RUNNER generates it
with `crypto/rand`, writes it ONLY into its state file (mode `0600`,
same user), and expects it as the first field of `hello`; the parent
reads it from the state file and sends it. This closes the loopback
socket against other local processes. The runner LISTENS, the parent
DIALS — a restarted parent only needs files to find every live runner.

Framing: one JSON object per `\n`-terminated line, one writer per
direction.

### Verbs (there are exactly five — forever)

| # | Direction | Type | Payload | Purpose |
|---|-----------|------|---------|---------|
| 1 | runner → parent | `hello` | `proto`, `jobId`, `pid`, `logCursor` | Announce + handshake. `logCursor` = byte offset the parent should replay from. |
| 2 | runner → parent | `out` | `off` (byte offset in the log), `chunk` | Output. The log file is written FIRST; `off` lets the parent dedup against what it already has. |
| 3 | both | `ping` | — | Liveness. Runner heartbeats (≈2s); parent may ping too. |
| 4 | parent → runner | `kill` | `reason` | Cancel the task (kills the command's process group). |
| 5 | runner → parent | `done` | `exitCode`, `endedAt` | Terminal. Also written to the state file first. |

### The two compatibility rules that make this eternal

1. **Receivers ignore message types and fields they do not know.**
   Growth is always additive; nothing ever breaks.
2. **`proto` handshake**: if the two sides do not agree on `proto`, they
   silently fall back to file-only mode (no socket traffic). A future
   protocol v2 lives alongside v1; a v1 parent simply does not speak to
   v2 runners over the socket and recovers everything from files.

**No application-level ACK — ever.** TCP gives ordered, lossless
delivery while the connection lives (and kernel-flushed socket buffers
survive even SIGKILL of the runner). Anything that IS lost — parent
dies too, machine reboots, slow consumer — is repaired from the files:
`out.off` + `hello.logCursor` make gaps detectable and replayable from
the log, and `done`/`exitCode` live in the state file before any signal.
Socket sends are best-effort and NEVER block the runner (the log is the
buffer): a slow parent delays latency, never the task.

Deliberately NOT in the protocol (files handle it): output history (the
log), kill fallback (pid + process group), liveness fallback (pidalive),
completion (state file), delivery acks (offsets + files). The protocol
never becomes load-bearing.

## 6. Flows

### F1 — starting a command
1. Ensure `runners/` exists (create if needed).
2. Ensure `runners/indirect-code-runner-<version>[.exe]` exists; if not,
   copy the running binary there. **No verification** (principle 3).
3. Spawn the runner detached (own process group), with `--runner
   --job <id> --session <sid> --log <path>` plus the command.
4. Runner: bind loopback listener → write the state file (immediately)
   → **start the COMMAND at once** (decided D1: never wait for a parent;
   the runner is ready for anything — a parent killed at the exact
   second of launch must not create a delayed or half state) → stream to
   the log always, to the socket whenever a parent is attached.
5. The tool call holds for the 10s foreground window (D4 in the agent's
   current `AutoBackgroundAfter` sense), then detaches and returns the
   background placeholder to the model exactly as today.

### F2 — streaming
- Runner appends every output chunk to its `runners/out/<name>` log
  FIRST, then emits `out` with the chunk's byte offset. Flush cadence:
  bounded (≈1s or 64KB) — memory is bounded by one chunk, never by
  output size. `brain/` is NOT written during the run (D8).
- Parent dedups by offset. A reconnect replays from the last confirmed
  offset (socket) or the log cursor (file mode).

### F3 — kill / cancel
1. Socket path: parent sends `kill`; runner cancels the command's
   context and kills its **process group** (reusing
   `processutil`/`killslot` semantics so grandchildren die too).
2. File fallback: parent kills the process group from the state file's
   `pid` (existing machinery).
3. Runner transitions `status: killed`, writes `exitCode`, emits `done`
   if connected, exits on its own schedule.

### F4 — parent death (SIGKILL / crash)
- Runner notices on `ping` timeout; keeps running the command; retries
  the connection with backoff (forever while the command runs).
- If the command finishes with no parent: the runner writes
  `status: done` + `exitCode` to the state file and **exits immediately**
  (decided D5: no waiting, no grace — if a parent is connected it also
  gets the `done` verb, if not the file is enough). The state file IS
  the retained notice: a later parent reads it and folds it into the
  session via the existing `background_delivery` chain (exactly one
  wake-up turn, ever).

### F5 — parent restart / re-adoption
1. On boot the parent scans `runners/*.state.json`.
2. `status: running` + pid alive → dial `transport`, `hello` with
   `logCursor` → resume streaming with no gaps/dups.
3. `status: running` + pid dead → runner died (F6).
4. `status: done` and not yet delivered → feed the notice machinery
   (V2-003: retried until the session acks it).
5. Stale states beyond retention (see F8) → cleaned.

### F5b — orphan policy at boot (decided D1)

A state file the parent does not recognize is not killed blindly:

1. **Try to recover the link first.** Correlate the state's
   `jobId`/`sessionId`/`startedAt` against the session's transcript and
   WAL (placeholder rows, `background_delivery` rows, queued turns). If
   the link exists, the runner is ADOPTED like any live job — the state
   file carries exactly the information a corrupted WAL may have lost
   (this is why ids + timestamps live there).
2. **Truly orphaned** (the session has moved past that job — last known
   information is already later, or the session is gone): SIGKILL the
   process group immediately and clean the state. Blunt and clean; no
   half-adopted zombies.

### F6 — runner death
- The state file shows `running` with a dead pid. The parent reports an
  explicit terminal failure for the job (no silent hang), keeps the log
  (everything up to the last flush is intact), and marks the state
  `killed`/`failed` for GC. This is honest failure reporting — the task
  crashed, we say so.

### F7 — updates (tasks cross updates)
- Runners are independent processes that run FROM `runners/` (never
  from the slot's `bin/`): the update may freely delete the whole slot
  folder and kill the old daemon there — every live runner keeps
  running its task untouched (decided D3).
- The new parent announces its `runnerVersion` on attach (F5). A runner
  whose version differs keeps serving its task (protocol rules make the
  socket optional; file mode is always valid).
- **Self-cleaning**: when a runner exits, it checks: "am I the last live
  runner of my generation AND is a newer `indirect-code-runner-<version>`
  present?" → if so it removes its own `runners/indirect-code-runner-<its
  version>` binary (up to and including the binary, per the owner's
  design). The daemon ALSO runs the full cleanup BEFORE starting
  (decided D3: boot GC — no in-memory bookkeeping). **No emergency /
  rollback version is kept** (decided D3): updates kill the old PARENTS
  only — runners keep running their tasks — and once a generation's
  runners are gone its binary goes with them.

### F8 — garbage collection (dead weight over time)
- State files with dead pids and old `heartbeatAt`/`endedAt` are removed
  after a retention window; the GC scan runs **hourly** plus at daemon
  boot (decided D5). Logs are never affected — they live in `brain/`.
- Version binaries are removed per F7 (generation dies out).
- A parent that itself died repeatedly cannot leak: the boot scan is
  idempotent and every rule is based on files + pid liveness, never on
  in-memory bookkeeping.

### F9 — completion (terminal transitions copy to brain)
1. Runner writes `exitCode` + `endedAt` + `status: done` to the state
   file (atomic tmp+rename) BEFORE anything else.
2. **COPIES** the `runners/out/<name>` log to the session's `brain/`
   location (copy, never move — D8). Any terminal transition triggers
   the copy: finished, killed/died, or cleaned as an orphan.
3. Emits `done` on the socket (if connected) and exits immediately (D5).
   The parent folds the completion into the transcript via the existing
   notice machinery (`background_delivery` identity = idempotent
   redelivery).

## 7. What changes vs today (integration map)

| Component | Change |
|---|---|
| multi-call binary | gains a `--runner` role (worker/boot unchanged) |
| `runners/` | NEW: versioned self-copied binaries + per-job state files |
| bg supervisor | jobs gain a runner-backed transport; registry reads state files (which also replace pidfiles — pidfile kept readable during transition for old jobs) |
| notice machinery (V2-003) | UNCHANGED semantics; the runner's `done` state becomes the retained notice source |
| logs | Live logs move to `runners/out/` (GC-exempt); terminal COPY to `brain/` (never move). `LogPath` follows the phase so current readers keep working |
| agent tool surface | UNCHANGED (placeholder + 10s foreground window + `bg_cancel` semantics) |
| update choreography | UNCHANGED (runners simply survive it; add F7 GC) |
| `processutil`/`killslot` | REUSED for process-group kills |

## 8. Testing plan

Philosophy stays the repo's: real processes, real signals, assert at the
boundary. Unit tests for pure logic; integration tests that actually
SIGKILL things.

### Unit (fast, no processes)
- State file: write/parse roundtrip; **unknown fields ignored**;
  atomic tmp+rename; corrupt file → explicit error, never a panic.
- Protocol framing: parse/serialize the five verbs; malformed lines and
  unknown types are ignored (rule 1); `proto` mismatch → file-only mode
  (rule 2).
- Output chunking: bounded flush (time + size), offset bookkeeping,
  dedup on replay.
- GC decision table: (pid alive?, status, generation, newer binary?) ×
  {keep, clean state, clean binary}.

### Integration (real runner processes, `-race`)
- **T1 happy path**: start → stream → done. Asserts: exit code captured,
  log file byte-complete, `out` offsets contiguous, state transitions in
  order.
- **T2 parent SIGKILL mid-task** (the flagship): kill the parent while a
  command runs → runner survives → boot a new parent → re-adoption →
  stream stitches with no gap/dup (offset asserts) → `done` delivered
  exactly once (idempotent fold).
- **T3 runner SIGKILL**: state shows `running` + dead pid → parent
  reports explicit failure (no hang), log preserved up to last flush.
- **T4 update crossing**: two runner versions staged (as F7) → parent
  swaps → task from the old generation completes under the new parent →
  old version binary self-cleans after the last of its generation exits.
- **T5 kill kills the group**: command spawns a grandchild; `kill` ends
  both (no orphans; `killslot` semantics).
- **T6 protocol mismatch**: runner with `proto: 99` → socket ignored →
  task still streams via log replay and completes + recovers.
- **T7 done without parent** (F4 tail): command finishes while no parent
  is connected → state carries the outcome → later parent folds exactly
  one wake-up notice (the `background_delivery` dedupe).
- **T8 slow parent**: parent stops reading; memory stays bounded (log is
  the buffer), nothing is lost after it resumes.
- **T9 foreground window**: commands under 10s return inline (no
  background notice); over 10s detach exactly like today's
  `AutoBackgroundAfter`.
- **T11 out→brain copy semantics (D8)**: live output lands only in
  `runners/out/`; on finish AND on kill the `brain/` log appears as a
  COPY (byte-identical, the out original still exists); `out/` survives
  GC sweeps; and after deleting the state file + job, the filename alone
  still attributes the log (sessionId/jobId/startedAt).
- **T10 orphan resolution at boot (F5b)**: a runner whose state
  correlates to a session (placeholder/WAL) is adopted and its stream
  resumes; a runner whose session moved past it (no link) is SIGKILLed
  and its state cleaned — nothing half-alive survives a boot.

### Lanes / gates
- All of the above run in the normal suite (glibc + musl + `-race` CI
  lanes already cover the platforms).
- Manual gate: extend `scripts/test-indirect-bg-e2e.ts` with a
  "kill the daemon mid-task" scenario (real Chromium, real model) —
  terminal completes, transcript converges, zero page errors.

## 9. Rollout

Additive and migration-free:
- Old pidfiles remain readable (the boot scan adopts both formats).
- Existing logs need no conversion.
- The runner role ships in the same single artifact; nothing new to
  distribute.

## 10. Deliverables

1. `--runner` role in the multi-call binary (runner loop: listener,
   child process, streaming, state machine).
2. `runners/` layout + self-copy + GC (F7/F8).
3. bg supervisor integration (state-file registry, adoption, notices).
4. `docs/runner-protocol.md` — the frozen contract (verbs, rules,
   state file) written from this plan's §4–§5 once approved.
5. The unit + integration tests above (T1–T9).

---

## Decisions (resolved with the owner, 2026-09-25)

- **D1 — the command starts IMMEDIATELY**, never waiting for a parent
  (ready for anything — no delayed/half state if the parent dies at
  launch). Orphans are resolved at boot: try to RECOVER the link first
  via the state file's ids/timestamps against the session transcript
  and WAL; only a truly orphaned runner (session moved past it) is
  SIGKILLed and cleaned (F5b).
- **D2 — loopback TCP + token**, token generated by the runner
  (`crypto/rand`), stored only in the state file (`0600`) and sent as
  the first field of `hello`; binds `127.0.0.1` only.
- **D3 — runners cross updates ALIVE**: they run from `runners/`, so the
  update can delete the slot folder and kill the old daemon there while
  tasks continue. The daemon cleans everything before starting (boot GC)
  and the hourly auto-GC later removes the dead generation's binary.
  No emergency / rollback version is kept.
- **D4 — `AutoBackgroundAfter` (10s) stays the single agent-foreground
  knob**; runner flush cadence is independent (1s / 64KB).
- **D5 — done = write state + exit immediately** (notify the parent if
  connected, otherwise the file is enough — no grace period). Runner
  state GC: hourly + at daemon boot. Logs in `brain/` are never touched
  by GC.
- **D6 — every command goes through a runner**, including short ones:
  one code path.
- **D7 — `ping` every ~2s; parent considered gone after ~6 misses
  (~12s)**.
- **D8 — live logs in `runners/out/`, copy-to-brain at terminal** (owner):
  during the task the output stays reserved on the runner side; only a
  terminal transition (finish / die / clean) creates the final `brain/`
  log, by COPY (never move — essential). `out/` is GC-exempt. Filename is
  the identity: `<sessionId>__<jobId>__<startedAtMs>.log`. The read /
  placeholder redesign is the owner's FUTURE work and out of scope here.

## Owner checklist

- [x] D1–D7 resolved.
- [x] Flows F1–F9 reviewed.
- [ ] Green light to implement (then this doc freezes as
      `docs/runner-protocol.md`'s source).
