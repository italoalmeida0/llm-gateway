//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// killSlotProcessesByDir scans /proc for processes whose executable or
// first cmdline arg lives inside slotDir and kills them via kill().
// Catches launcher children (no pidfile). Unix-only; windows is a no-op.
func killSlotProcessesByDir(slotDir string, ownPid int, kill func(pid int, why string)) {
	absDir, err := filepath.Abs(slotDir)
	if err != nil {
		return
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 || pid == ownPid {
			continue
		}
		// exe symlink first (cheap, exact).
		if exe, err := os.Readlink("/proc/" + e.Name() + "/exe"); err == nil {
			if exe == absDir || strings.HasPrefix(exe, absDir+"/") {
				kill(pid, "exe in slot")
				continue
			}
		}
		// Fallback: argv[0] (scripts / deleted-but-running binaries).
		if raw, err := os.ReadFile("/proc/" + e.Name() + "/cmdline"); err == nil && len(raw) > 0 {
			arg0 := string(raw[:strings.Index(string(raw)+"\x00", "\x00")])
			if abs, aerr := filepath.Abs(arg0); aerr == nil {
				if abs == absDir || strings.HasPrefix(abs, absDir+"/") {
					kill(pid, "cmdline in slot")
				}
			}
		}
	}
}
