//go:build !windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/runner"
)

func TestRegressionRunnerKillEscalatesAfterLeaderExits(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	marker := filepath.Join(root, "child.pid")
	command := fmt.Sprintf("sh -c 'trap \"\" TERM; echo $$ > %s; while :; do sleep 1; done' & wait", marker)
	proc := spawnTestRunner(t, root, dataDir, command)
	waitFor(t, 3*time.Second, func() bool { raw, _ := os.ReadFile(marker); return len(raw) > 0 })
	raw, _ := os.ReadFile(marker)
	child, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	pgid, err := syscall.Getpgid(child)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(-pgid, syscall.SIGKILL)
	defer proc.Stop()
	proc.Stop()
	select {
	case <-proc.Exited:
	case <-time.After(6 * time.Second):
		t.Fatal("runner did not exit")
	}
	time.Sleep(3500 * time.Millisecond)
	if pidAlive(strconv.Itoa(child)) {
		t.Fatalf("TERM-resistant child %d still runs after runner exit and 3s escalation window", child)
	}
}

func TestRegressionRunnerHardKillDoesNotLeaveCommandRunning(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	marker := filepath.Join(root, "command.pid")
	command := fmt.Sprintf("echo $$ > %s; echo ready; while :; do sleep 1; done", marker)
	proc := spawnTestRunner(t, root, dataDir, command)
	waitFor(t, 3*time.Second, func() bool { return fileHas(proc.LogPath, "ready") })
	raw, _ := os.ReadFile(marker)
	child, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	pgid, err := syscall.Getpgid(child)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Kill(-pgid, syscall.SIGKILL)
	seedSession(t, dataDir, "sess1", proc.JobID)
	p, err := os.FindProcess(proc.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	<-proc.Exited
	b := newBGSupervisor(dataDir)
	b.adoptRunners()
	st, err := runner.ReadState(runner.StatePath(root, proc.JobID))
	if err != nil {
		t.Fatal(err)
	}
	if !st.Terminal() {
		t.Fatal("fixture did not reach the recovered terminal state")
	}
	if pidAlive(strconv.Itoa(child)) {
		t.Fatalf("runner marked %s with exit %d, but command %d is still executing", st.Status, *st.ExitCode, child)
	}
}
