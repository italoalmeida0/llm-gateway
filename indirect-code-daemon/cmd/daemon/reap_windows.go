//go:build windows

package main

import (
	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// The runner's non-inherited Job Object handle owns the whole tree. Its
// death closes that handle and terminates every member. Only the recorded
// bootstrap may still need a direct cleanup signal; never invoke taskkill
// against a numeric PID that can be reused between verification and launch.
func reapStoredCommand(st *runner.State) {
	_ = processutil.SignalIdentity(st.CmdPID, st.CommandIdentity, 9)
}

func reapCommandFromState(root, jobID string) {
	st, err := runner.ReadState(runner.StatePath(root, jobID))
	if err != nil {
		return
	}
	reapStoredCommand(st)
}
