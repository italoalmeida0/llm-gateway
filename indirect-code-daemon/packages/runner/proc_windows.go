//go:build windows

package runner

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"time"

	"llm-gateway/indirect-code-daemon/packages/proctable"
)

// setProcessGroup is a no-op on Windows: the tree kill below owns the
// grouping (taskkill /T targets the whole tree).
func setProcessGroup(cmd *exec.Cmd) {}

// killProcessGroup kills the whole tree: taskkill /T is the primary
// mechanism; the proctable sweep catches anything it missed (Job
// objects aside, the ppid walk is the guarantee).
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	proctable.KillTree(pid, 9)
	_ = cmd.Process.Kill()
}

// exitCodeOf maps a wait error to a code (Windows has no POSIX signal
// codes: the process code, or 1 for hard kills).
func exitCodeOf(waitErr error) int {
	if waitErr == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(waitErr, &ee) {
		if c := ee.ExitCode(); c >= 0 {
			return c
		}
	}
	return 1
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
