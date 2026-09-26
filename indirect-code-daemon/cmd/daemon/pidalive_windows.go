//go:build windows

package main

import (
	"fmt"
	"llm-gateway/indirect-code-daemon/packages/processutil"
	"os/exec"
	"strconv"
	"strings"
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

// terminatePid uses taskkill (graceful enough: daemon handles console
// close via signal.Notify; force only as fallback).
func terminatePid(n int) error {
	if out, err := exec.Command("taskkill", "/PID", strconv.Itoa(n)).CombinedOutput(); err != nil {
		// Already dead?
		if pidAlive(strconv.Itoa(n)) {
			return fmt.Errorf("taskkill: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// terminateParentWait: taskkill, wait, then /F. Returns error if the
// process is still alive afterwards.
func terminateParentWait(pid string, grace time.Duration) error {
	if !pidAlive(pid) {
		return nil // already gone
	}
	n, err := parsePid(pid)
	if err != nil {
		return err
	}
	_ = n
	_ = exec.Command("taskkill", "/PID", pid).Run()
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	_ = exec.Command("taskkill", "/F", "/PID", pid).Run()
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("pid %s refuses to die", pid)
}

// forceKillPid kills a pid and its tree unconditionally (taskkill /F /T).
// A console runner ignores the graceful WM_CLOSE terminatePid sends, so
// orphan cleanup must force.
func forceKillPid(n int) error {
	if n <= 0 {
		return nil
	}
	if out, err := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(n)).CombinedOutput(); err != nil {
		if pidAlive(strconv.Itoa(n)) {
			return fmt.Errorf("taskkill /F: %v (%s)", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}
