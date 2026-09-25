//go:build !windows

package tools

import "syscall"

// StopRecoveredProcess refuses unknown or reused PIDs. These children were
// created in their own process groups by the tools.
func StopRecoveredProcess(pid int, identity string) bool {
	if identity == "" || ProcessIdentity(pid) != identity {
		return false
	}
	return syscall.Kill(-pid, syscall.SIGKILL) == nil
}
