package main

import (
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// pidAlive probes liveness without affecting the process:
// unix signal 0 (+ /proc zombie filter), windows tasklist probe.
func pidAlive(n int) bool {
	if n <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", n), "/NH").Output()
		if err != nil {
			return true // unknown: assume live, caller re-checks
		}
		return strings.Contains(string(out), strconv.Itoa(n))
	}
	return pidAliveUnixSignal(n)
}
