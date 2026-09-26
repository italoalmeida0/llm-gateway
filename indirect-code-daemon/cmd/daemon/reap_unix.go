//go:build !windows

package main

import (
	"syscall"
	"time"

	"llm-gateway/indirect-code-daemon/packages/proctable"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// reapStoredCommand kills the command's group from the durable state
// (V2R-002): used when the runner died without reaping its own tree.
func reapStoredCommand(st *runner.State) {
	pgid := st.CmdPgid
	if pgid <= 0 {
		pgid = st.CmdPID
	}
	if pgid <= 0 {
		return
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	proctable.KillTree(pgid, int(syscall.SIGTERM))
	time.AfterFunc(3*time.Second, func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		proctable.KillTree(pgid, int(syscall.SIGKILL))
	})
}

// reapCommandFromState kills the command's group read from the runner's
// state file (V2R-002) — the fallback that makes Stop a guarantee even if
// the runner never gets to run its own reap.
func reapCommandFromState(root, jobID string) {
	st, err := runner.ReadState(runner.StatePath(root, jobID))
	if err != nil {
		return
	}
	reapStoredCommand(st)
}
