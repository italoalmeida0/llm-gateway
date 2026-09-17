//go:build !windows

package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// pidAlive reports whether pid (decimal) names a live process.
// Signal 0 probes existence without affecting the process. Unreaped
// children (zombies) answer signal 0 but are dead — on Linux the
// /proc state field filters them (state Z).
func pidAlive(pid string) bool {
	n, err := strconv.Atoi(pid)
	if err != nil || n <= 0 {
		return false
	}
	if err := syscall.Kill(n, 0); err != nil {
		// ESRCH = no such process; EPERM = exists but owned by another user.
		return err == syscall.EPERM
	}
	if st, rerr := os.ReadFile("/proc/" + pid + "/stat"); rerr == nil {
		// comm (2nd field) may contain spaces/parens: state follows the
		// LAST ')'.
		if i := strings.LastIndex(string(st), ")"); i >= 0 && i+2 < len(st) {
			if st[i+2] == 'Z' {
				return false
			}
		}
	}
	return true
}

// parsePid parses a decimal pid.
func parsePid(s string) (int, error) {
	return strconv.Atoi(strings.TrimSpace(s))
}

// terminatePid sends SIGTERM (graceful: daemon disconnects WS + exits).
func terminatePid(n int) error {
	return syscall.Kill(n, syscall.SIGTERM)
}

// terminateParentWait sends SIGTERM, waits, then SIGKILL. Returns error if
// the process is still alive afterwards.
func terminateParentWait(pid string, grace time.Duration) error {
	n, err := parsePid(pid)
	if err != nil {
		return err
	}
	if !pidAlive(pid) {
		return nil // already gone
	}
	if err := terminatePid(n); err != nil {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	// Escalate: SIGKILL, then confirm.
	_ = syscall.Kill(n, syscall.SIGKILL)
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("pid %d refuses to die", n)
}
