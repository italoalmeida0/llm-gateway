//go:build !windows

package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// pidAliveUnixSignal probes liveness via signal 0 (+ /proc zombie filter).
func pidAliveUnixSignal(n int) bool {
	if err := syscall.Kill(n, 0); err != nil {
		return err == syscall.EPERM
	}
	if st, rerr := os.ReadFile("/proc/" + strconv.Itoa(n) + "/stat"); rerr == nil {
		if i := strings.LastIndex(string(st), ")"); i >= 0 && i+2 < len(st) {
			if st[i+2] == 'Z' {
				return false
			}
		}
	}
	return true
}
