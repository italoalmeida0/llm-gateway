package tools

import (
	"strconv"
	"syscall"
)

// ProcessIdentity uses the kernel creation timestamp (100ns ticks since 1601).
// Keep the decimal FILETIME format used by previous PowerShell-based pidfiles.
func ProcessIdentity(pid int) string {
	if pid <= 0 {
		return ""
	}
	const queryLimitedInformation = 0x1000
	h, err := syscall.OpenProcess(queryLimitedInformation, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(h)
	var created, exited, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil || exited.HighDateTime != 0 || exited.LowDateTime != 0 {
		return ""
	}
	// .NET DateTime.Ticks starts in year 1; FILETIME starts in 1601.
	const filetimeEpochTicks = uint64(504911232000000000)
	ticks := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	return strconv.FormatUint(ticks+filetimeEpochTicks, 10)
}
