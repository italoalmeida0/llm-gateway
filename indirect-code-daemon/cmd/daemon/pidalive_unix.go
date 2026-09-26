//go:build !windows

package main

import (
	"fmt"
	"llm-gateway/indirect-code-daemon/packages/processutil"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// pidAlive shares the daemon's platform-aware liveness probe.
func pidAlive(pid string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(pid))
	return err == nil && processutil.Alive(n)
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

// forceKillPid kills a pid unconditionally (SIGKILL). Used where a
// graceful signal is not guaranteed to be honored (orphan cleanup).
func forceKillPid(n int) error {
	if n <= 0 {
		return nil
	}
	return syscall.Kill(n, syscall.SIGKILL)
}
