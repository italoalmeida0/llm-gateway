package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Canonical on-disk layout (the boot role owns it — the worker assumes it):
//
//	<root>/                       (default: ~/.indirect-code)
//	  brain/                      per-session agent scratch (<id>/…)
//	  slots/
//	    active                    "a\n" or "b\n"
//	    slot-a/
//	      bin/                    the multi-call app (indirect-code-<goos>-<goarch>[.exe])
//	      sessions/               sess_*.jsonl + sess_*/ attachments
//	      config.json             gateway pairing (secrets)
//	      projects.json           project list
//	      daemon.pid              live pid (the daemon writes/removes it)
//	      storage_version.json    storage schema stamp
//	      update.log              last app --update attempt into THIS slot
//	    slot-b/                   (same shape)
//	  logs/
//	    daemon.log                daemon stdout (install scripts wire it)
//	    update-last.log           last --update attempt (stable copy)
//	  external/
//	    python/                   managed interpreter
//	    bin/unish[.exe]           managed shell
//
// Nothing else lives at the root. In particular: no sessions/, config.json,
// daemon.pid, storage_version.json or serving.json at the top level — those
// are slot-local. ensureLayout (below) repairs any drift: it moves stray
// top-level state into the active slot (or slot-a on first boot) and
// reports what it fixed, so a manual install always recovers to bootable.

// slotBinName is the app binary name inside a slot bin dir.
// Unix keeps the full platform asset name (indirect-code-linux-amd64);
// Windows uses the short name (indirect-code.exe) — same rule as
// stageAppTo, so resolve and staging never disagree.
func slotBinName() string {
	if runtime.GOOS == "windows" {
		return "indirect-code.exe"
	}
	return daemonAssetName()
}

// ensureLayout guarantees the canonical layout under root, repairing a
// broken install when possible. It returns a list of human-readable
// repair notes (empty on a clean layout) and an error only when boot is
// impossible (nothing usable and no mirror to fetch from — the caller
// decides; installSlotA needs the network).
//
// Repair policy:
//   - missing root/slots dirs are created;
//   - stray top-level state (sessions/, config.json, projects.json,
//     daemon.pid, storage_version.json, serving.json, handoff.json,
//     standby-ready.json, takeover.log, update.log) is MOVED into the
//     active slot (legacy names kept: old installs may still carry them)
//     (or slot-a when active is missing) — never copied, never deleted;
//   - slots/active missing: pick the slot with the freshest content
//     (sessions mtime, then slot dir mtime), default "a" when both are
//     empty/missing; a live daemon.pid also votes (its slot wins);
//   - slots/active corrupt (no a/b): same discovery as missing.
//   - stale update signals (slots/update.done, slots/update.fail) are
//     REMOVED: a normal boot never reads them (the waiter/updater own
//     them), so a forged or crashed-update marker can never gate or
//     bless a boot (hardening D4: a fake update.done must not bypass
//     verification). Real ack markers are slot-local and travel with
//     their slot — those are never touched here.
//   - an active slot with no daemon binary is NOT fatal here —
//     resolveSlotDaemon downloads it (needs network).
func ensureLayout(root string) ([]string, error) {
	var notes []string
	note := func(format string, args ...any) {
		notes = append(notes, fmt.Sprintf(format, args...))
	}
	slotsDir := filepath.Join(root, "slots")
	if err := os.MkdirAll(slotsDir, 0o700); err != nil {
		return notes, err
	}
	for _, d := range []string{"logs", "brain", "external"} {
		_ = os.MkdirAll(filepath.Join(root, d), 0o700)
	}

	active := readActiveSlot(slotsDir)
	// Live pidfiles vote for their slot when active is missing/corrupt.
	if active == "" {
		if s := slotWithLivePid(slotsDir); s != "" {
			active = s
			note("slots/active missing: live daemon.pid votes slot %s", s)
		}
	}
	if active == "" {
		active = freshestSlot(slotsDir)
		if active == "" {
			active = "a"
		} else {
			note("slots/active missing: freshest slot is %s", active)
		}
	}
	slotDir := filepath.Join(slotsDir, "slot-"+active)
	// The slot dir must exist for renames to land (rename won't create
	// parents). sessions/ is adopted as a whole dir below.
	if err := os.MkdirAll(slotDir, 0o700); err != nil {
		return notes, err
	}
	// Adopt stray top-level state into the slot (move, never copy):
	// when sessions/ is stray, rename lands exactly at slot/sessions.
	for _, name := range []string{"sessions", "config.json", "projects.json",
		"daemon.pid", "storage_version.json", "serving.json", "handoff.json",
		"standby-ready.json", "takeover.log", "update.log"} {
		src := filepath.Join(root, name)
		if _, err := os.Lstat(src); err != nil {
			continue
		}
		dst := filepath.Join(slotDir, name)
		if _, err := os.Lstat(dst); err == nil {
			note("root %s ignored: slot %s already has one (remove it manually)", name, active)
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			return notes, fmt.Errorf("adopt %s: %w", name, err)
		}
		note("adopted root %s into slot %s", name, active)
	}
	// Clear the legacy root-level update signal path (see repair policy):
	// stale/forged markers must never gate a fresh boot.
	for _, name := range []string{"update.done", "update.fail"} {
		_ = os.Remove(filepath.Join(slotsDir, name))
	}
	if err := os.MkdirAll(filepath.Join(slotDir, "bin"), 0o700); err != nil {
		return notes, err
	}
	if err := os.MkdirAll(filepath.Join(slotDir, "sessions"), 0o700); err != nil {
		return notes, err
	}
	// Commit active (repair or first boot).
	if raw, err := os.ReadFile(filepath.Join(slotsDir, "active")); err != nil || !hasSlotLetter(string(raw)) {
		if err := os.WriteFile(filepath.Join(slotsDir, "active"), []byte(active+"\n"), 0o600); err != nil {
			return notes, err
		}
		if err != nil {
			note("wrote slots/active=%s", active)
		} else {
			note("slots/active corrupt: reset to %s", active)
		}
	}
	return notes, nil
}

// readActiveSlot returns "a"/"b" when slots/active parses, else "".
func readActiveSlot(slotsDir string) string {
	raw, err := os.ReadFile(filepath.Join(slotsDir, "active"))
	if err != nil {
		return ""
	}
	for _, c := range strings.TrimSpace(string(raw)) {
		if c == 'a' || c == 'b' {
			return string(c)
		}
	}
	return ""
}

func hasSlotLetter(s string) bool {
	for _, c := range strings.TrimSpace(s) {
		if c == 'a' || c == 'b' {
			return true
		}
	}
	return false
}

// slotWithLivePid returns the slot whose daemon.pid points at a live
// process, else "".
func slotWithLivePid(slotsDir string) string {
	for _, s := range []string{"a", "b"} {
		raw, err := os.ReadFile(filepath.Join(slotsDir, "slot-"+s, "daemon.pid"))
		if err != nil {
			continue
		}
		if pid := strings.TrimSpace(string(raw)); pid != "" && pidAlive(pid) {
			return s
		}
	}
	return ""
}

// freshestSlot picks the slot with the most recently modified content
// (sessions dir mtime wins, else slot dir mtime). Returns "" when neither
// slot exists or both are empty.
func freshestSlot(slotsDir string) string {
	best := ""
	var bestAt time.Time
	for _, s := range []string{"a", "b"} {
		dir := filepath.Join(slotsDir, "slot-"+s)
		st, err := os.Stat(dir)
		if err != nil {
			continue
		}
		at := st.ModTime()
		empty := true
		if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
			empty = false
		}
		if sst, err := os.Stat(filepath.Join(dir, "sessions")); err == nil {
			empty = false
			if sst.ModTime().After(at) {
				at = sst.ModTime()
			}
		}
		if empty {
			continue
		}
		if best == "" || at.After(bestAt) {
			best, bestAt = s, at
		}
	}
	return best
}
