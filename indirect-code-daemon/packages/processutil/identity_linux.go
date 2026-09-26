//go:build linux

package processutil

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"strconv"
	"strings"
)

func Identity(pid int) (string, error) {
	if pid <= 0 {
		return "", unix.ESRCH
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", err
	}
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 {
		return "", fmt.Errorf("invalid process metadata")
	}
	f := strings.Fields(string(b[i+1:]))
	if len(f) < 20 {
		return "", fmt.Errorf("incomplete process metadata")
	}
	if f[0] == "Z" {
		return "", unix.ESRCH
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + f[19], nil
}

// Open the capability first, validate the incarnation, then signal through the
// capability. PID reuse after validation cannot redirect this signal.
func SignalIdentity(pid int, expected string, sig int) error {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if !Matches(pid, expected) {
		return ErrIdentityMismatch
	}
	return unix.PidfdSendSignal(fd, unix.Signal(sig), nil, 0)
}
