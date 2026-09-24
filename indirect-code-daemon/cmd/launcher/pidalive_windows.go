//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// pidAlive reports whether pid (decimal) names a live process.
// No cheap signal 0 on Windows: tasklist probe.
func pidAlive(pid string) bool {
	n, err := strconv.Atoi(pid)
	if err != nil || n <= 0 {
		return false
	}
	out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", n), "/NH").Output()
	if err != nil {
		return true // unknown: assume live, daemon re-checks anyway
	}
	return strings.Contains(string(out), strconv.Itoa(n))
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
