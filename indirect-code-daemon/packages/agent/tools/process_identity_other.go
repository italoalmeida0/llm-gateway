//go:build !linux && !windows

package tools

import (
	"context"
	"os/exec"
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
	cmd := exec.CommandContext(ctx, "/bin/ps", "-o", "stat=", "-o", "lstart=", "-p", strconv.Itoa(pid))
	cmd.Env = append(cmd.Environ(), "LC_ALL=C", "TZ=UTC")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	if len(fields) < 2 || strings.HasPrefix(fields[0], "Z") {
		return ""
	}
	// Preserve the lstart spacing used by existing pidfiles.
	return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), fields[0]))
}
