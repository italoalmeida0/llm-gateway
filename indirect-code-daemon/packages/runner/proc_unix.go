//go:build !windows

package runner

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// setProcessGroup puts the command in its own process group so the kill
// path takes the entire tree down, including backgrounded children.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup TERMs the group and SIGKILLs it shortly after.
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pgid := cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	time.AfterFunc(3*time.Second, func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
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
