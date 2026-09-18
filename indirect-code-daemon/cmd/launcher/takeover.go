package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// Takeover mode: invoked by the OLD daemon as
//   launcher-new --takeover --data-dir D --from-slot a --to-slot b
//     --expect-version V --handoff-file F --parent-pid PID
//
// Steps (all inside the INACTIVE slot; the active slot is never touched
// until promote):
//  1. migrate sessions in the inactive slot (chain)
//  2. fetch the new daemon into the inactive slot + self-verify (--version)
//  3. start the new daemon in STANDBY (no WS): --standby --data-dir <slot>
//  4. health-check it (version + storage + sessions readable)
//  5. signal the old daemon to die (it disconnects WS + exits), then
//     promote: flip `active`, tell the new daemon to assume (handoff file
//     "promoted"), delete the old slot.
// Any failure: write "failed: reason" to the handoff file, delete nothing
// active, exit non-zero. The old daemon (still alive, WS connected)
// unfreezes on failure.

func runTakeover(
	dataDir, fromSlot, toSlot, expectVersion, handoffFile, parentPid string,
) int {
	toDir := filepath.Join(dataDir, "slots", "slot-"+toSlot)
	// Dedicated log: daemon stdout may be unreachable (service, nohup
	// rotation); the reason for a takeover failure must survive here.
	takeoverLog := filepath.Join(toDir, "takeover.log")
	_ = os.Remove(takeoverLog) // fresh signals only (stale log must not confuse)
	logf := func(format string, args ...any) {
		msg := fmt.Sprintf(format, args...)
		fmt.Println(msg)
		if f, err := os.OpenFile(takeoverLog, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
			fmt.Fprintln(f, msg)
			f.Close()
		}
	}
	fail := func(reason string) int {
		_ = os.WriteFile(handoffFile, []byte("failed: "+reason), 0o600)
		logf("[TAKEOVER] failed: %s", reason)
		return 1
	}
	// 0. Fresh signals only: clear stale handoff/serving leftovers in the
	// target slot (a crashed previous takeover must not fake success).
	_ = os.Remove(filepath.Join(toDir, "handoff.json"))
	_ = os.Remove(filepath.Join(toDir, "serving.json"))
	_ = os.Remove(filepath.Join(toDir, "standby-ready.json"))
	// 1. Migrate inactive slot.
	logf("[TAKEOVER] migrating slot %s...", toSlot)
	if applied, err := migrations.MigrateDir(filepath.Join(toDir)); err != nil {
		return fail(fmt.Sprintf("migrate: %v", err))
	} else if len(applied) > 0 {
		logf("[TAKEOVER] applied: %v", applied)
	}
	// 2. Fetch new daemon into inactive slot + self-verify.
	logf("[TAKEOVER] fetching daemon %s...", expectVersion)
	daemonPath, err := fetchDaemonTo(toDir, expectVersion)
	if err != nil {
		return fail(fmt.Sprintf("fetch daemon: %v", err))
	}
	if err := selfVerifyDaemon(daemonPath, expectVersion); err != nil {
		return fail(fmt.Sprintf("verify daemon: %v", err))
	}
	// 3+4. Standby: the new daemon shadow-connects (?shadow=1: tracked,
	// never routed) and writes serving.json AFTER its WS is up. Serving
	// proof = health + version + end-to-end WS in one file. No separate
	// health step (the old standby-ready probe couldn't prove WS).
	logf("[TAKEOVER] starting standby daemon (shadow WS)...")
	standby, err := startStandby(daemonPath, toDir, expectVersion)
	if err != nil {
		return fail(fmt.Sprintf("standby: %v", err))
	}
	// 5. PROOF FIRST: wait for the new daemon's serving.json (written
	// AFTER its WS connects) and verify the version matches what we
	// downloaded. The old daemon is still alive and serving — nothing
	// dies before the replacement proves, in writing, that it serves.
	// This kills the version-skew class: stale cache can no longer swap
	// a healthy daemon for itself.
	logf("[TAKEOVER] waiting for new daemon proof of serving...")
	if err := waitServingProof(toDir, expectVersion, 90*time.Second); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("serving proof: %v", err))
	}
	// 6. Only now: tell the old daemon to die (SIGTERM, escalate).
	logf("[TAKEOVER] proof OK; asking old daemon (pid %s) to exit...", parentPid)
	if err := terminateParentWait(parentPid, 15*time.Second); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("terminate parent: %v", err))
	}
	// 7. Promote: flip active, tell standby to assume, delete old slot.
	if err := os.WriteFile(filepath.Join(dataDir, "slots", "active"), []byte(toSlot+"\n"), 0o600); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("flip active: %v", err))
	}
	if err := os.WriteFile(handoffFile, []byte("promoted"), 0o600); err != nil {
		return fail(fmt.Sprintf("handoff file: %v", err))
	}
	// Standby watches the handoff file itself and assumes (exec into
	// normal boot: WS, pidfile, fresh serving.json). CONFIRM a fresh
	// post-boot proof before deleting anything.
	flippedAt := time.Now()
	if err := confirmServing(dataDir, standby, toDir, expectVersion, flippedAt); err != nil {
		// Rollback: flip back, relaunch OLD daemon from the intact slot,
		// report failure. The old slot was never touched.
		logf("[TAKEOVER] new daemon failed to serve: %v — rolling back", err)
		_ = standby.cmd.Process.Kill()
		_ = os.WriteFile(filepath.Join(dataDir, "slots", "active"), []byte(fromSlot+"\n"), 0o600)
		_ = os.WriteFile(handoffFile, []byte("failed: new daemon did not serve"), 0o600)
		if rbErr := relaunchOldSlot(dataDir, fromSlot); rbErr != nil {
			return fail(fmt.Sprintf("rollback relaunch: %v", rbErr))
		}
		return fail("new daemon did not serve; rolled back to previous version")
	}
	logf("[TAKEOVER] promoted slot %s, cleaning old slot %s...", toSlot, fromSlot)
	_ = os.RemoveAll(filepath.Join(dataDir, "slots", "slot-"+fromSlot))
	logf("[TAKEOVER] done (daemon %s live)", expectVersion)
	return 0
}

// confirmServing waits (60s) for the NEW slot's serving.json to show the
// expected version with a live pid and a connectedAt AFTER the flip.
// The standby's pre-exec proof is not enough: exec changes the pid, so we
// require a FRESH post-boot proof (the booted daemon rewrites serving.json
// right after its WS connects). Stale proofs fail the timestamp check.
func confirmServing(dataDir string, standby *standbyProc, slotDir, expectVersion string, flippedAt time.Time) error {
	_ = standby
	path := filepath.Join(slotDir, "serving.json")
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil {
			var p servingProof
			if jerr := json.Unmarshal(raw, &p); jerr == nil &&
				p.Version == expectVersion && p.Pid > 0 &&
				p.ConnectedAt >= flippedAt.UnixMilli() &&
				pidAlive(fmt.Sprint(p.Pid)) {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("no fresh serving proof for %s", expectVersion)
}

// relaunchOldSlot starts the previous slot's daemon (rollback). It boots
// normally (resume from WALs, reconnect) — the slot was never modified.
func relaunchOldSlot(dataDir, fromSlot string) error {
	binDir := filepath.Join(dataDir, "slots", "slot-"+fromSlot, "bin")
	asset := daemonAssetName()
	local := filepath.Join(binDir, asset)
	if runtime.GOOS == "windows" {
		local = filepath.Join(binDir, "indirect-code.exe")
	}
	if st, err := os.Stat(local); err != nil || st.IsDir() {
		return fmt.Errorf("old slot has no daemon")
	}
	slotDir := filepath.Join(dataDir, "slots", "slot-"+fromSlot)
	cmd := exec.Command(local, "--data-dir", slotDir, "--config", dataDir+"/config.json")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	// Detach: the relaunched daemon owns its lifecycle from here.
	return nil
}

// runTakeoverFlags parses --takeover CLI flags (called from main).
func parseTakeoverFlags(args []string) (dataDir, fromSlot, toSlot, expectVersion, handoffFile, parentPid string) {
	for i := 0; i < len(args); i++ {
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch args[i] {
		case "--data-dir":
			dataDir, i = next, i+1
		case "--from-slot":
			fromSlot, i = next, i+1
		case "--to-slot":
			toSlot, i = next, i+1
		case "--expect-version":
			expectVersion, i = next, i+1
		case "--handoff-file":
			handoffFile, i = next, i+1
		case "--parent-pid":
			parentPid, i = next, i+1
		}
	}
	return dataDir, fromSlot, toSlot, expectVersion, handoffFile, parentPid
}
