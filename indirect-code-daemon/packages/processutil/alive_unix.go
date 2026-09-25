//go:build !windows

// Package processutil contains OS process probes shared by the daemon and launcher.
package processutil

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Alive excludes zombies. Inaccessible process metadata is treated as live:
// callers must not clean up a running process merely because a probe failed.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if err := syscall.Kill(pid, 0); err != nil {
		return err != syscall.ESRCH
	}
	if runtime.GOOS == "linux" {
		if st, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
			if i := strings.LastIndexByte(string(st), ')'); i >= 0 {
				return !strings.HasPrefix(strings.TrimSpace(string(st[i+1:])), "Z")
			}
		}
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		// Use the OS ps, never a PATH shell builtin with Linux-only /proc logic.
		out, err := exec.CommandContext(ctx, "/bin/ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
		if err == nil {
			return !strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
		}
	}
	return syscall.Kill(pid, 0) != syscall.ESRCH
}
