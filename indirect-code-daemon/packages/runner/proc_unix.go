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

// processGroupOf returns the pgid of pid (falls back to the pid itself,
// which is the group leader under Setpgid).
func processGroupOf(pid int) int {
	if pgid, err := syscall.Getpgid(pid); err == nil {
		return pgid
	}
	return pid
}

// requestTerminate is the FAST cancel request: TERM the command's group
// and tree. The guaranteed reap (KILL escalation + ppid sweep) is done
// synchronously by reapCommandTree once the command exits.
func requestTerminate(pgid int) {
	if pgid <= 0 {
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	proctable.KillTree(pgid, int(syscall.SIGTERM))
}

// reapCommandTree is GNU timeout's escalation, SYNCHRONOUS: TERM, a grace
// window, then KILL the group + a ppid-walk sweep. Returns once the tree
// is gone (or the deadline passes). The group probe is essential: once the
// leader exits, a surviving member is REPARENTED to init, so a ppid walk
// from the leader finds nothing while the process is still in the group.
func reapCommandTree(pgid int) {
	if pgid <= 0 {
		return
	}
	if !groupAlive(pgid) {
		return // fast path: the whole group is already gone
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	proctable.KillTree(pgid, int(syscall.SIGTERM))
	deadline := time.Now().Add(killGrace)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Grace expired: KILL unconditionally, then sweep the tree for any
	// setsid'd escape (outside the group, still in the ppid tree).
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	proctable.KillTree(pgid, int(syscall.SIGKILL))
}

// groupAlive reports whether ANY process remains in the group (kill(-pgid,
// 0) succeeds while the group is non-empty, regardless of reparenting).
func groupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
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
