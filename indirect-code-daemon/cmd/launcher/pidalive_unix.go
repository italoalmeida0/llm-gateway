//go:build !windows

package main

import (
	"os"
	"strconv"
	"syscall"
)

// pidAlive reports whether pid (decimal) names a live process.
// Signal 0 probes existence without affecting the process.
func pidAlive(pid string) bool {
	n, err := strconv.Atoi(pid)
	if err != nil || n <= 0 {
		return false
	}
	if err := syscall.Kill(n, 0); err != nil {
		// ESRCH = no such process; EPERM = exists but owned by another user.
		return err == syscall.EPERM
	}
	_ = os.Getpid
	return true
}
