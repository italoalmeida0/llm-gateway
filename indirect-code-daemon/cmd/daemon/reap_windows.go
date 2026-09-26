//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"time"

	"llm-gateway/indirect-code-daemon/packages/proctable"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// reapStoredCommand kills the command's tree from the durable state
// (V2R-002) on Windows (taskkill /T /F + ppid sweep).
func reapStoredCommand(st *runner.State) {
	pid := st.CmdPID
	if pid <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
	proctable.KillTree(pid, 9)
}

// reapCommandFromState reads the runner state and reaps its command tree.
func reapCommandFromState(root, jobID string) {
	st, err := runner.ReadState(runner.StatePath(root, jobID))
	if err != nil {
		return
	}
	reapStoredCommand(st)
}
