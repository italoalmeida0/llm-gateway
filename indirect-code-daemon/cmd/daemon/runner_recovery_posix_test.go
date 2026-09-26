//go:build !windows

package main

import (
	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/runner"
	"syscall"
	"testing"
	"time"
)

func recoveryLiveJob(t *testing.T, command string) (string, string, *tools.Proc, *runner.State) {
	t.Helper()
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, command)
	var state *runner.State
	waitFor(t, 4*time.Second, func() bool {
		var err error
		state, err = runner.ReadState(runner.StatePath(root, proc.JobID))
		return err == nil && state.CmdPgid > 0 && fileHas(proc.LogPath, "ready")
	})
	pgid := state.CmdPgid
	t.Cleanup(func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		select {
		case <-proc.Exited:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(proc.PID, syscall.SIGKILL)
			<-proc.Exited
		}
	})
	seedSession(t, dataDir, "sess1", proc.JobID)
	if err := runner.WriteDisposition(root, proc.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	return root, dataDir, proc, state
}

func recoveryAwaitAdoption(t *testing.T, b *bgSupervisor, jobID string) {
	t.Helper()
	waitFor(t, 5*time.Second, func() bool {
		for _, row := range listJobs(b) {
			if row["id"] == jobID && row["status"] == BgStatusRunning {
				return true
			}
		}
		return false
	})
}

func TestRecoveryAdoptedAssistantCancelStaysSilent(t *testing.T) {
	root, dataDir, proc, _ := recoveryLiveJob(t, "echo ready; sleep 30")
	b := startBG(t, dataDir, nil)
	recoveryAwaitAdoption(t, b, proc.JobID)
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgCancelMsg{JobID: proc.JobID, By: "assistant", Reply: reply}}
	if ok, _ := (<-reply).(bool); !ok {
		t.Fatal("cancel rejected")
	}
	select {
	case <-proc.Exited:
	case <-time.After(6 * time.Second):
		t.Fatal("runner did not exit")
	}
	next := newBGSupervisor(dataDir)
	next.adoptRunners()
	if next.notices[proc.JobID] != nil {
		t.Fatalf("cancel after adoption generated a notice on the next boot; disposition=%q", runner.ReadDisposition(root, proc.JobID))
	}
}

func TestRecoveryRunnerDeathAfterAdoptionReapsCommand(t *testing.T) {
	root, dataDir, proc, state := recoveryLiveJob(t, "echo ready; sleep 30")
	b := startBG(t, dataDir, nil)
	recoveryAwaitAdoption(t, b, proc.JobID)
	if err := syscall.Kill(proc.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	<-proc.Exited
	// Detection can take one 2s watcher tick, followed by the full 3s
	// reap grace (including zombie groups under a container's PID 1).
	// Allow scheduling and state-write time beyond those two deadlines.
	waitFor(t, 8*time.Second, func() bool {
		st, err := runner.ReadState(runner.StatePath(root, proc.JobID))
		return err == nil && st.Terminal()
	})
	// Completion already includes the reap grace; only allow signal delivery
	// here, rather than granting another full cancellation window.
	waitFor(t, time.Second, func() bool { return tools.ProcessIdentity(state.CmdPID) == "" })
}

func TestRecoveryAdoptedStopEscalatesResistantLeader(t *testing.T) {
	_, dataDir, proc, state := recoveryLiveJob(t, "trap '' TERM; echo ready; while :; do sleep 1; done")
	b := startBG(t, dataDir, nil)
	recoveryAwaitAdoption(t, b, proc.JobID)
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgCancelMsg{JobID: proc.JobID, By: "user", Reply: reply}}
	if ok, _ := (<-reply).(bool); !ok {
		t.Fatal("cancel rejected")
	}
	time.Sleep(4 * time.Second)
	if tools.ProcessIdentity(state.CmdPID) != "" {
		t.Fatal("adopted Stop reported cancellation but never escalated against the TERM-resistant command leader")
	}
}
