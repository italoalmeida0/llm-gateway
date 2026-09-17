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
