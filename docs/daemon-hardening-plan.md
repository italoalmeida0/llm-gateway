# Daemon reliability plan

Status: **Complete (2026-09-25)**. Scope: finish the actor migration without changing the accepted product cuts in `actor-migration-plan.md`.

The acceptance criterion is observable behavior: working launcher startup, current permissions, durable session mutations, lossless lifecycle delivery, safe background jobs, and the existing frontend protocol. Each completed item records its validation here. No new runtime dependency is planned.

## Progress

- [x] Inventory the review findings and preserve the before/after evidence in `docs/reviews/`.
- [x] **1. Startup and human interaction** — reconcile launcher flags; restore approval/question envelopes; enforce live tool policy; retain regression tests at the public boundary.
- [x] **2. Session lifecycle and persistence** — guarantee worker completion on cancellation; exercise the real watchdog ladder; block new work after failed commits; persist idle mutations and serve current mirror summaries; protect shutdown/deletion.
- [x] **3. Worker state and compaction** — carry attachment selections and prompt metadata; deliver background context to the executing agent; implement dedicated manual compaction; preserve snapshot ownership and generation guards.
- [x] **4. Background process lifecycle** — give subscriptions one owner; unsubscribe safely; report completion independently from the turn; pass real process identity, retain logs across daemon death, and support safe re-adoption/cancellation without re-execution.
- [x] **5. Cache and concurrency** — revalidate idle eviction in the actor; coordinate closing/deleted handles and cold loads; enforce count and memory limits for idle residents; cover adversarial interleavings.
- [x] **6. Release validation** — maintained real-process boundary tests; Go tests/race/vet; Bun tests/lint/typecheck; applicable browser checks; fresh SPA and all daemon/launcher release builds; verify manifests and checksums.

### Validated milestones

- [x] Browser approval/question identity and live permission changes (targeted actor/worker tests).
- [x] Cancellation terminal delivery, failed-commit admission barrier, idle mutation persistence, actual watchdog escalation (regression probes).
- [x] Attachment selection, background prompt metadata, live background context, dedicated manual compaction (fake-provider tests).
- [x] Single-owner background subscriptions and stale-idle/count-limit eviction regressions.
- [x] Real bash child PID reaches the durable background registry; bash/python command tests pass with inherited log files.
- [x] Abrupt process death, recovery identity, deletion races, full race checks, and release artifacts.

## Invariants

1. The session actor owns mutable session state. Worker inputs are snapshots; commands and acknowledged deltas carry subsequent changes.
2. A cancelled work context does not cancel delivery of its terminal result. Actor lifetime is a separate signal.
3. A failed durable commit prevents admission of another turn that could truncate its recovery log.
4. A successful mutation is reflected in both durable state and subsequent mirror pulls. Errors are observable.
5. Human replies use the same correlation identity that the browser received. Execution checks current access policy.
6. A background subscription closes exactly once, unregisters on completion/cancellation, and does not own a job's process lifetime.
7. Idle eviction is conditional at the owner. A stale supervisor observation cannot cancel newly accepted work.
8. Background work is never re-run after a crash. Recovery requires actual process identity and surviving output.

## Validation log

- Planning baseline: remote `f46d0ba`, local `534db69`. The review includes real before/after WebSocket checks and 15 additional failing regression probes. The pre-existing untracked probe (hanging fixture) was corrected and promoted to `cmd/daemon/review_probe_test.go` as part of the test work.
- Release candidate validation (2026-09-25, linux/amd64, 8 vCPU AMD EPYC-Genoa, Go 1.25 / Bun 1.4.2), all commands re-run on the final tree:
  - `go vet ./...` clean; `go test ./... -count=1` and `go test -race -count=1 ./...` green across 8 packages.
  - `bun test` — 382 pass / 0 fail; `bun run lint` and `bun run typecheck` clean.
  - Real-process boundary: `bun scripts/test-indirect-daemon-protocol.ts` — PASS (launcher slot flag, rename mirror, attachments, compaction, approval/question round trips).
  - Live integration (real Meta provider from `.env`, release binary): `bun scripts/test-indirect-daemon-live.ts` — PASS (turn + follow-up "PONG", foreground status contract, transcript persisted).
  - Browser (Playwright + Chromium 1243): `test-indirect-{turn,composer,collapse,settings,update-overlay,update-f5,update-sidebar}-ui.ts` PASS; `test-indirect-crash-chaos-e2e.ts --all` (real binaries) K1–K8 PASS; `test-indirect-large-resume.ts` PASS (500k-token fixture, CDP freeze cycles, zero page errors).
  - Performance smoke (comparison-only; this checkout has no `docs/performance` baseline to diff against, so command and machine facts are recorded beside the measured values): `bun run bench` (N=2000, C=50) — direct upstream 8921 rps / p50 5.40ms; through gateway 4504 rps / p50 10.55ms (p50 overhead 5.15ms/req, 50.5% of baseline throughput); streaming (N=500, C=20) 183 rps / p50 107.78ms. The daemon work does not touch the gateway hot path.
  - Release artifacts: `bun run build` — 6 daemon + 6 launcher platforms + installers + SPA; `sha256sum -c SHA256SUMS.txt` OK for all 12 assets; `versions.json` sums match `SHA256SUMS.txt` (v1.0.33).
- Update-system restoration (2026-09-25, after the review found the deletion was a regression — see the correction bullet below): the v1.0.28 brutal-update protocol is ported into the actor daemon (`update_flow.go`/`update.go`/`handoff.go`/`killslot_*`/`update_spawn_*` + `update_host.go` adapting it to `root`/link plumbing) and the `launcher --update` orchestration is restored. Validation: the ported v1.0.28 test suite is green (handoff e2e primitives, SIGKILL/resume, copy semantics, relay stop/rebirth ordering, manifest/version logic); `test-indirect-handoff-e2e.ts` PASS (9.9.8 → 9.9.9: `?updating=1`, SIGKILL, promote, cleanup); `test-indirect-gateway-death-e2e.ts` PASS (p0–p3: blackout, truncated download, death mid-update → fail/rebirth, promote with dead gateway flips local-first); crash-chaos K1–K8 PASS against the restored system. Two latent bugs fixed along the way: the promote's `update_done` must ride the `--update-end` hello socket (sendWS precedence over the not-yet-started link actor), and the `launcher --update` child must honor an explicit `INDIRECT_REPO_RAW` override over the paired gateway (os/exec env dedup is last-wins; the v1.0.32 "pass the paired gateway explicitly" fix had started shadowing the harness override). The P2 world now force-closes the mirror (`stop(true)`) so "mirror death" aborts in-flight downloads like a real death — Bun's graceful `stop()` let the sleeping handler finish the body and the update legitimately succeeded.

## Completion notes

Updated after each phase. Items are checked only after implementation and relevant tests pass; limitations or remaining manual checks are recorded explicitly.

- Implementation progress: all phases 1–6 are implemented and validated on the release candidate (validation log above). The actor rewrite remains the structural baseline.

- Phase 1: maintained `scripts/test-indirect-daemon-protocol.ts` passes against a real daemon, including the launcher `--slot` argument, approval and question round trips. (The launcher `--update` path was initially reduced to an explicit refusal as "accepted cut D4" — superseded: the update orchestration was restored after review, see the note at the end of this log.)
- Phase 2: the queue finish checkpoint is the single authoritative promotion point; idle mutations commit write-then-replace (WAL append + atomic `saveSessionSync`), and a failed commit parks the actor in `statePersist`, refusing new prompts until the recovery WAL is re-attached (source turn matched) or discarded — never truncated (`TestReviewCommitFailureRetainsRecoveryWAL`, `TestFailedCommitRecoversWithoutLosingTranscript`). Header-only recovery keeps the opening prompt and metadata (`TestHeaderOnlyRecoveryKeepsOpeningPromptAndMetadata`); cancelled workers always deliver their terminal result before the actor leaves `stateRunning` (`TestReviewCancelledWorkerAlwaysReportsFinish`, `TestShutdownDrainsCancelledWorkerTranscript`); the watchdog escalates the real cancel state (`TestReviewWatchdogEscalatesRealCancelState`); purge of a cold session never resumes and rejects future routes (`TestPurgeColdSessionNeverResumesAndRejectsFutureRoutes`).
- Phase 3: manual compaction, selected attachments, live background context and wake metadata pass fake-provider and real WebSocket checks. Mutable snapshot containers are copied at the actor boundary.
- Phase 4: background registration carries the real shell PID (pre-exec fork constraint documented on `BackgroundProcess`) with platform process identity (boot id + starttime on Linux); stop kills the exact process group only after identity verification (`TestReviewStopTerminatesRealProcessGroup`, `TestBackgroundSurvivesDaemonExitAndCanBeStopped`); `closeDone` has one authority; the bg supervisor owns all subscriptions with coalesced status-only wakes, bounded enqueue and stale-sleeper eviction. Background crash evidence: subprocess tests for bash and Python exit the daemon abruptly, observe continued log growth, re-adopt by process identity, refuse mismatched identities, and cancel the actual child process group (`TestBackgroundCrashHelper`).
- Phase 5: idle residents are capped below the memory budget (`TestReviewResidentCapEnforcedBelowMemoryBudget`), passivation re-checks idleness after prompt admission (`TestReviewPassivationRechecksIdleAfterPrompt`), and restored mutable state is cloned per reader (`TestReadSnapshotDoesNotShareMutableState`). Refresh identity is verified immediately through the release binary integration: the boundary suite plus a live provider run with a follow-up turn — `scripts/test-indirect-daemon-live.ts` now asserts turn-2 history/refresh identity (the second BeforeRequest refresh must carry turn 1).
- Full `go test -race ./...` passed on the release candidate after the final persistence refinements (uncached, `-count=1`).
- Test maintenance and corrections found during release validation:
  - **The brutal-update system was wrongly deleted, not legacy.** The
    handoff/gateway-death e2e scripts were believed to test removed v1
    behavior; a follow-up review showed the deletion itself was the
    regression (the `ex-v2` fork predates the 2026-09-23 update
    reformulation). The full protocol is now ported into the actor
    daemon (see `actor-migration-plan.md` §D4 "Restored"); both e2e
    scripts are live gates again and the "accepted cut D4" line in the
    Phase 1 notes above is superseded.
  - crash-chaos K7 ("forged update.done") exposed a latent `kill9`
    self-recursion in the chaos script (unix kills were no-ops: phase
    daemons leaked and a green run hung at exit) — fixed. The stale
    signal cleanup at boot is now enforced at BOTH boot owners (launcher
    `ensureLayout` + daemon boot, v1 parity: "signals always cleaned at
    fail, promote and normal boot"), with
    `TestEnsureLayoutClearsStaleUpdateSignals` guarding the launcher side.
  - `scripts/test-indirect-settings-ui.ts` drove Skills/MCP modal forms that were cut from the Settings modal; it now drives the `createSettings` hook surface (same wire assertions: `expectedRevision`, `config_updated`/`mcp_status` routing, secret omission, duplicate-name protection) with real modal Save/Cancel/reload interactions, and the fixture `ui` stub was completed.
