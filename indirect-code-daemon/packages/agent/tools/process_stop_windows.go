package tools

import (
	"os/exec"
	"strconv"
)

func StopRecoveredProcess(pid int, identity string) bool {
	if identity == "" || ProcessIdentity(pid) != identity {
		return false
	}
	return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run() == nil
}
