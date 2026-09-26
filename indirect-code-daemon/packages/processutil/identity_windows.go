//go:build windows

package processutil

import (
	"golang.org/x/sys/windows"
	"strconv"
)

func handleIdentity(h windows.Handle) (string, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	if exited.HighDateTime != 0 || exited.LowDateTime != 0 {
		return "", windows.ERROR_NOT_FOUND
	}
	return strconv.FormatUint(uint64(created.HighDateTime)<<32|uint64(created.LowDateTime), 10), nil
}

func Identity(pid int) (string, error) {
	if pid <= 0 {
		return "", windows.ERROR_NOT_FOUND
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	return handleIdentity(h)
}

func SignalIdentity(pid int, expected string, sig int) error {
	if pid <= 0 || expected == "" {
		return ErrIdentityMismatch
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	actual, err := handleIdentity(h)
	if err != nil {
		return err
	}
	if actual != expected {
		return ErrIdentityMismatch
	}
	if sig == 0 {
		return nil
	}
	return windows.TerminateProcess(h, 1)
}
