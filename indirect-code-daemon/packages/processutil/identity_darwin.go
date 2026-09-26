//go:build darwin

package processutil

import (
	"fmt"
	"golang.org/x/sys/unix"
)

func Identity(pid int) (string, error) {
	if pid <= 0 {
		return "", unix.ESRCH
	}
	kp, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	if kp == nil || kp.Proc.P_pid != int32(pid) || kp.Proc.P_stat == 5 {
		return "", unix.ESRCH
	}
	return fmt.Sprintf("%d:%d", kp.Proc.P_starttime.Sec, kp.Proc.P_starttime.Usec), nil
}

// Darwin has no pidfd equivalent here. Validate at the signal boundary and
// expose the remaining native check/signal race in the recovery contract.
func SignalIdentity(pid int, expected string, sig int) error {
	if !Matches(pid, expected) {
		return ErrIdentityMismatch
	}
	return unix.Kill(pid, unix.Signal(sig))
}
