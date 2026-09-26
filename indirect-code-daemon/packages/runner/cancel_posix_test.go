//go:build !windows

package runner

import (
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Exercise the runner alone: the daemon's fallback must not hide a broken
// escalation path when the command leader ignores TERM.
func TestKillVerbEscalatesBeforeCommandWaitReturns(t *testing.T) {
	root := t.TempDir()
	spec := runSpec(t, root, "resistant", "trap '' TERM; echo ready; while :; do sleep 1; done")
	done := make(chan int, 1)
	go func() { done <- Run(spec) }()
	var state *State
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		st, err := ReadState(StatePath(root, spec.JobID))
		out, _ := os.ReadFile(spec.OutPath)
		if err == nil && st.Transport.Port != 0 && strings.Contains(string(out), "ready") {
			state = st
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if state == nil {
		t.Fatal("runner did not become ready")
	}
	t.Cleanup(func() { _ = syscall.Kill(-state.CmdPgid, syscall.SIGKILL) })
	if err := DialKill(state, "test", time.Second); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 128+int(syscall.SIGKILL) {
			t.Fatalf("exit code %d, expected SIGKILL", code)
		}
	case <-time.After(7 * time.Second):
		_ = syscall.Kill(-state.CmdPgid, syscall.SIGKILL)
		<-done
		t.Fatal("runner waited forever for the TERM-resistant command")
	}
	st, err := ReadState(StatePath(root, spec.JobID))
	if err != nil || st.Status != StatusKilled {
		t.Fatal("cancellation did not publish a killed state")
	}
}
