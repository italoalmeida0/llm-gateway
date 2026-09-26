//go:build !windows

package tools

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"llm-gateway/indirect-code-daemon/packages/proctable"
)

// isExecutableFile reports whether path can be executed (unix exec bits).
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

// setProcessGroup puts the command in its own process group so
// killProcessGroup can target the entire tree including background
// children spawned with &.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcessGroup sends SIGTERM then SIGKILL to the entire process
// group so backgrounded children (cmd &) are also cleaned up — plus a
// ppid-walk sweep: setsid'd children live OUTSIDE the process group but
// never outside the tree (packages/proctable).
func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	pgid := pid
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	time.AfterFunc(3*time.Second, func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		proctable.KillTree(pid, int(syscall.SIGKILL))
	})
}
