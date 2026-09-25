package processutil

import "syscall"

// Alive uses a process handle rather than parsing localized tasklist output.
// Waiting with zero timeout also handles processes that exit with code 259.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err != syscall.Errno(87) // ERROR_INVALID_PARAMETER: no such PID
	}
	defer syscall.CloseHandle(h)
	state, err := syscall.WaitForSingleObject(h, 0)
	return err != nil || state != syscall.WAIT_OBJECT_0
}
