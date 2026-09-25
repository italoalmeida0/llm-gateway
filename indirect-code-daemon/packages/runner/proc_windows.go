//go:build windows

package runner

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// setProcessGroup is a no-op on Windows: the tree kill below owns the
// grouping (taskkill /T targets the whole tree).
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessGroup kills the whole tree (taskkill /T /F), falling back
// to killing the root process.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}

// processAlive is the pid liveness probe used by orphan/GC decisions.
// On Windows os.FindProcess opens a handle and fails for dead pids.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil || p == nil {
		return false
	}
	_ = p.Release()
	return true
}
