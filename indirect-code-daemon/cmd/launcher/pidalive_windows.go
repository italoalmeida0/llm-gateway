//go:build windows

package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
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
