//go:build !linux && !windows

package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// macOS has no /proc. ps comm reports executable paths without argv ambiguity;
// -ww prevents truncation, and splitting only the PID preserves path spaces.
func killSlotProcessesByDir(slotDir string, ownPid int, kill func(int, string)) {
	dir, err := filepath.Abs(slotDir)
	if err != nil {
		return
	}
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/bin/ps", "-ww", "-axo", "pid=,comm=").Output()
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		i := strings.IndexAny(line, " \t")
		if i < 0 {
			continue
		}
		pid, err := strconv.Atoi(line[:i])
		if err != nil || pid <= 0 || pid == ownPid {
			continue
		}
		exe := strings.TrimSpace(line[i:])
		if !filepath.IsAbs(exe) {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		if strings.HasPrefix(exe, dir+string(filepath.Separator)) {
			kill(pid, "executable in slot")
		}
	}
}
