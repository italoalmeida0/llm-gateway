//go:build !windows

package runner

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"

	"llm-gateway/indirect-code-daemon/packages/proctable"
)

// setProcessGroup puts the command in its own process group so the kill
// path takes the entire tree down, including backgrounded children.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup is GNU timeout's escalation (TERM → grace window →
// KILL) plus a proctable sweep: the group signal covers the normal tree,
// the ppid-walk sweep covers escapes (setsid'd children live OUTSIDE the
// group but never outside the tree).
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	pgid := pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	time.AfterFunc(killGrace, func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		proctable.KillTree(pid, int(syscall.SIGKILL))
	})
}

// processAlive is the pid liveness probe used by orphan/GC decisions.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// exitCodeOf maps a wait error to the canonical code: 128+signal for
// signal deaths (GNU convention), the process code otherwise.
func exitCodeOf(waitErr error) int {
	if waitErr == nil {
		return 0
	}
	var ee *exec.ExitError
	if !errors.As(waitErr, &ee) {
		return 1
	}
	if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal()) // GNU convention
	}
	return ee.ExitCode()
}
