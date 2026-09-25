package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// Brutal update mode (--update), invoked by the --update-start daemon as
//   app-new --update --root-dir R --from-slot a --to-slot b
//     --expect-version V --old-version O --fail-file F --done-file D
//     --parent-pid PID
//
// Everything happens inside the UPDATE slot (already filled with the old
// slot's data by --update-start); the active slot is never touched:
//  1. migrate the update slot (chain)
//  2. fetch the new daemon into the update slot + verify it RUNS the
//     expected version AND the version is strictly newer than the old one
//     (a stale mirror serving old bytes fails here, before anything dies)
//  3. spawn the new daemon DETACHED with --update-end (it boots normally
//     on the new slot; after its first WS connect it kills the waiting
//     --update-start daemon, flips slots/active, deletes the old slot
//     and reports update_done)
//  4. exit 0 — our job is done, the daemons finish the handoff.
//
// Failure signal: on ANY failure write the fail file and exit non-zero.
// The signal is only ever emitted when the app is READY TO BE KILLED
// (nothing is left running that the waiter must clean up first). Success
// needs no signal from us: --update-end writes the done file itself after
// it proves end-to-end serving.

func runUpdate(
	rootDir, fromSlot, toSlot, expectVersion, oldVersion, failFile, doneFile, parentPid string,
) int {
	toDir := filepath.Join(rootDir, "slots", "slot-"+toSlot)
	logsDir := filepath.Join(rootDir, "logs")
	_ = os.MkdirAll(logsDir, 0o700)
	stableLog := filepath.Join(logsDir, "update-last.log")
	updateLog := filepath.Join(toDir, "update.log")
	_ = os.Remove(updateLog) // fresh signals only (stale log must not confuse)
	logf := func(format string, args ...any) {
		msg := fmt.Sprintf(format, args...)
		fmt.Println(msg)
		for _, p := range []string{updateLog, stableLog} {
			if f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
				fmt.Fprintln(f, msg)
				f.Close()
			}
		}
	}
	fail := func(reason string) int {
		// Ready-to-be-killed signal: we hold no child worth waiting for
		// (every started process is killed below before returning).
		writeSignalFile(failFile, "failed: "+reason)
		logf("[UPDATE] failed: %s", reason)
		return 1
	}
	// Fresh signals only: a crashed previous attempt must not fake a result.
	// (Also drop legacy serving.json/handoff.json leftovers: no reader
	// exists anymore, and a stale file must never confuse forensics.)
	_ = os.Remove(failFile)
	_ = os.Remove(doneFile)
	_ = os.Remove(filepath.Join(toDir, "serving.json"))
	_ = os.Remove(filepath.Join(toDir, "handoff.json"))
	// 1. Migrate the update slot.
	logf("[UPDATE] migrating slot %s...", toSlot)
	if applied, err := migrateDir(toDir); err != nil {
		return fail(fmt.Sprintf("migrate: %v", err))
	} else if len(applied) > 0 {
		logf("[UPDATE] applied: %v", applied)
	}
	// 2. Stage the app into the update slot + verify. The multi-call
	// binary stages ITSELF: this process IS the new version (spawned by
	// --update-start after the worker's update checker downloaded and
	// verified it) — no fetch here, ever.
	logf("[UPDATE] staging app %s...", expectVersion)
	daemonPath, err := stageAppTo(toDir)
	if err != nil {
		return fail(fmt.Sprintf("stage app: %v", err))
	}
	if err := selfVerifyDaemon(daemonPath, expectVersion); err != nil {
		return fail(fmt.Sprintf("verify daemon: %v", err))
	}
	if got := daemonVersionOf(daemonPath); !isVersionNewerUpdate(got, oldVersion) {
		return fail(fmt.Sprintf("daemon %s is not newer than %s", got, oldVersion))
	}
	// 3. Spawn the new daemon DETACHED with --update-end. It boots
	// normally (crash recovery resumes the turns), and after its first WS
	// connect it kills the waiter (--update-start, parentPid), flips
	// slots/active, deletes the old slot and writes the done file.
	logf("[UPDATE] starting new daemon (--update-end)...")
	cmd := exec.Command(daemonPath,
		"--data-dir", toDir,
		"--config", filepath.Join(toDir, "config.json"),
		"--slot", toSlot,
		"--update-end",
		"--root-dir", rootDir,
		"--from-slot", fromSlot,
		"--expect-version", expectVersion,
		"--parent-pid", parentPid,
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return fail(fmt.Sprintf("start new daemon: %v", err))
	}
	logf("[UPDATE] new daemon started (pid %d), exiting", cmd.Process.Pid)
	// Detached: --update-end owns its lifecycle from here (the waiter
	// watches the done file, we must not hold the pipe open).
	return 0
}

// writeSignalFile writes a fail/done signal file (tmp+rename: the 100ms
// poller tolerates a torn read by retrying).
func writeSignalFile(path, body string) {
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upd-*")
	if err != nil {
		_ = os.WriteFile(path, []byte(body), 0o600)
		return
	}
	_, _ = tmp.WriteString(body)
	_ = tmp.Close()
	_ = os.Rename(tmp.Name(), path)
}

// parseUpdateFlags parses --update CLI flags (called from main).
func parseUpdateFlags(args []string) (rootDir, fromSlot, toSlot, expectVersion, oldVersion, failFile, doneFile, parentPid string) {
	for i := 0; i < len(args); i++ {
		next := ""
		if i+1 < len(args) {
			next = args[i+1]
		}
		switch args[i] {
		case "--root-dir":
			rootDir, i = next, i+1
		case "--from-slot":
			fromSlot, i = next, i+1
		case "--to-slot":
			toSlot, i = next, i+1
		case "--expect-version":
			expectVersion, i = next, i+1
		case "--old-version":
			oldVersion, i = next, i+1
		case "--fail-file":
			failFile, i = next, i+1
		case "--done-file":
			doneFile, i = next, i+1
		case "--parent-pid":
			parentPid, i = next, i+1
		}
	}
	return rootDir, fromSlot, toSlot, expectVersion, oldVersion, failFile, doneFile, parentPid
}

// daemonVersionOf runs `bin --version` and returns the version token
// (last whitespace-separated field: `indirect-code daemon vH2` -> vH2).
func daemonVersionOf(path string) string {
	out, err := runVersionCmd(path)
	if err != nil {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

// isVersionNewerUpdate reports whether newV is strictly greater than oldV
// (same rules as the daemon side: empty/dev never qualify).
func isVersionNewerUpdate(newV, oldV string) bool {
	newV = strings.TrimSpace(newV)
	oldV = strings.TrimSpace(oldV)
	if newV == "" || oldV == "" {
		return false
	}
	if strings.EqualFold(newV, "dev") || strings.EqualFold(oldV, "dev") {
		if newV == oldV {
			return false
		}
		// A dev old-version with a real target still counts as an update
		// (dev installs bootstrapping to a release).
		if strings.EqualFold(oldV, "dev") && !strings.EqualFold(newV, "dev") {
			return true
		}
		return false
	}
	if newV == oldV {
		return false
	}
	return compareVersionsUpdate(newV, oldV) > 0
}

// compareVersionsUpdate orders version strings (leading "v" stripped,
// numeric components compared numerically, rest lexically).
func compareVersionsUpdate(a, b string) int {
	norm := func(v string) []string {
		v = strings.TrimSpace(v)
		v = strings.TrimPrefix(v, "v")
		v = strings.TrimPrefix(v, "V")
		if i := strings.Index(v, "+"); i >= 0 {
			v = v[:i]
		}
		v = strings.ReplaceAll(v, "-", ".")
		if v == "" {
			return nil
		}
		return strings.Split(v, ".")
	}
	pa, pb := norm(a), norm(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var ca, cb string
		if i < len(pa) {
			ca = pa[i]
		}
		if i < len(pb) {
			cb = pb[i]
		}
		if ca == cb {
			continue
		}
		var na, nb int
		_, ea := fmt.Sscanf(ca, "%d", &na)
		_, eb := fmt.Sscanf(cb, "%d", &nb)
		if ea == nil && eb == nil {
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			continue
		}
		if ca < cb {
			return -1
		}
		return 1
	}
	return 0
}

// migrateDir applies the pending storage migrations to dir.
func migrateDir(dir string) ([]int, error) {
	return migrations.MigrateDir(dir)
}
