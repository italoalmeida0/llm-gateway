//go:build !linux

package tools

import (
	"context"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func ProcessIdentity(pid int) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id "+strconv.Itoa(pid)+" -ErrorAction Stop).StartTime.ToUniversalTime().Ticks")
	} else {
		cmd = exec.CommandContext(ctx, "ps", "-o", "lstart=", "-p", strconv.Itoa(pid))
		cmd.Env = append(cmd.Environ(), "LC_ALL=C", "TZ=UTC")
	}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
