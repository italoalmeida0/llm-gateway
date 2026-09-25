package tools

import (
	"os"
	"strconv"
	"strings"
)

// ProcessIdentity distinguishes PID reuse and machine reboots. Linux starttime
// is measured in clock ticks since boot, not wall time.
func ProcessIdentity(pid int) string {
	if pid <= 0 {
		return ""
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	i := strings.LastIndexByte(string(stat), ')')
	if i < 0 {
		return ""
	}
	fields := strings.Fields(string(stat[i+1:]))
	if len(fields) < 20 || fields[0] == "Z" {
		return ""
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(boot)) + ":" + fields[19]
}
