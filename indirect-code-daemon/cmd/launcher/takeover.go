package main

import (
	"fmt"
	"os"
	"path/filepath"

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
	fail := func(reason string) int {
		_ = os.WriteFile(handoffFile, []byte("failed: "+reason), 0o600)
		fmt.Printf("[TAKEOVER] failed: %s\n", reason)
		return 1
	}
	toDir := filepath.Join(dataDir, "slots", "slot-"+toSlot)
	// 1. Migrate inactive slot.
	fmt.Printf("[TAKEOVER] migrating slot %s...\n", toSlot)
	if applied, err := migrations.MigrateDir(filepath.Join(toDir)); err != nil {
		return fail(fmt.Sprintf("migrate: %v", err))
	} else if len(applied) > 0 {
		fmt.Printf("[TAKEOVER] applied: %v\n", applied)
	}
	// 2. Fetch new daemon into inactive slot + self-verify.
	fmt.Printf("[TAKEOVER] fetching daemon %s...\n", expectVersion)
	daemonPath, err := fetchDaemonTo(toDir, expectVersion)
	if err != nil {
		return fail(fmt.Sprintf("fetch daemon: %v", err))
	}
	if err := selfVerifyDaemon(daemonPath, expectVersion); err != nil {
		return fail(fmt.Sprintf("verify daemon: %v", err))
	}
	// 3. Standby: start new daemon WITHOUT WS (it must not register).
	fmt.Printf("[TAKEOVER] starting standby daemon...\n")
	standby, err := startStandby(daemonPath, toDir, expectVersion)
	if err != nil {
		return fail(fmt.Sprintf("standby: %v", err))
	}
	// 4. Health-check the standby.
	if err := healthCheckStandby(standby, toDir); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("health: %v", err))
	}
	// 5. Tell the old daemon to die (it disconnects WS + exits on its own
	// terms — we never kill -9 a healthy parent; SIGTERM only).
	fmt.Printf("[TAKEOVER] asking old daemon (pid %s) to exit...\n", parentPid)
	if err := terminateParent(parentPid); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("terminate parent: %v", err))
	}
	// 6. Promote: flip active, tell standby to assume, delete old slot.
	if err := os.WriteFile(filepath.Join(dataDir, "slots", "active"), []byte(toSlot+"\n"), 0o600); err != nil {
		_ = standby.cmd.Process.Kill()
		return fail(fmt.Sprintf("flip active: %v", err))
	}
	if err := os.WriteFile(handoffFile, []byte("promoted"), 0o600); err != nil {
		return fail(fmt.Sprintf("handoff file: %v", err))
	}
	// Standby watches the handoff file itself and assumes (connects WS,
	// resumes WALs) — no extra signal needed.
	fmt.Printf("[TAKEOVER] promoted slot %s, cleaning old slot %s...\n", toSlot, fromSlot)
	_ = os.RemoveAll(filepath.Join(dataDir, "slots", "slot-"+fromSlot))
	fmt.Printf("[TAKEOVER] done (daemon %s live)\n", expectVersion)
	return 0
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
