package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--runner-command" {
		os.Exit(runner.CommandMain())
	}
	os.Exit(m.Run())
}

func TestCrashContractProcessHelper(t *testing.T) {
	if os.Getenv("LLMGW_CONTRACT_TEST_HELPER") != "1" {
		return
	}
	_, _ = os.Stdout.WriteString("ready\n")
	time.Sleep(30 * time.Second)
}

func contractProcess(t *testing.T) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestCrashContractProcessHelper$")
	cmd.Env = append(os.Environ(), "LLMGW_CONTRACT_TEST_HELPER=1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan bool, 1)
	go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line == "ready\n" }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("helper failed")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper not ready")
	}
	return cmd
}

func TestCrashContractMismatchedRunnerCannotKillSentinel(t *testing.T) {
	cmd := contractProcess(t)
	root, data := runnerTestRoot(t)
	st := &runner.State{JobID: "stale", SessionID: "sess1", PID: cmd.Process.Pid,
		ProcessIdentity: "different-incarnation", CmdPID: cmd.Process.Pid, CmdPgid: cmd.Process.Pid,
		CommandIdentity: "different-incarnation", Status: runner.StatusRunning, StartedAt: 1}
	if err := runner.WriteState(root, st); err != nil {
		t.Fatal(err)
	}
	b := newBGSupervisor(data)
	b.adoptRunners()
	if b.jobs[st.JobID] != nil {
		t.Fatal("adopted unrelated process")
	}
	stopRunner(root, st.JobID, st.PID)
	reapStoredCommand(st)
	if _, err := processutil.Identity(cmd.Process.Pid); err != nil {
		t.Fatal("unrelated sentinel was killed")
	}
}

func TestCrashContractParentKillsWedgedWorkerOnly(t *testing.T) {
	worker, sentinel := contractProcess(t), contractProcess(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	defer close(done)
	exit := make(chan struct{})
	go func() { watchWorkerHealth(ln, "test-token", worker, done, 500*time.Millisecond); close(exit) }()
	// Wrong credentials and unhealthy reports cannot keep the worker alive.
	for _, report := range []workerHealthReport{{Token: "wrong", PID: worker.Process.Pid, Healthy: true}, {Token: "test-token", PID: worker.Process.Pid}} {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(c).Encode(report)
		_ = c.Close()
	}
	select {
	case <-exit:
	case <-time.After(5 * time.Second):
		t.Fatal("no bounded recovery")
	}
	if err := worker.Wait(); err == nil {
		t.Fatal("worker did not fail")
	}
	if _, err := processutil.Identity(sentinel.Process.Pid); err != nil {
		t.Fatal("watchdog killed unrelated process")
	}
}

func TestCrashContractHealthyWorkerAndShutdown(t *testing.T) {
	worker := contractProcess(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done, exit := make(chan struct{}), make(chan struct{})
	go func() { watchWorkerHealth(ln, "test-token", worker, done, time.Second); close(exit) }()
	for range 8 {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(c).Encode(workerHealthReport{Token: "test-token", PID: worker.Process.Pid, Healthy: true})
		_ = c.Close()
		time.Sleep(200 * time.Millisecond)
	}
	if _, err := processutil.Identity(worker.Process.Pid); err != nil {
		t.Fatal("healthy worker killed")
	}
	close(done)
	select {
	case <-exit:
	case <-time.After(3 * time.Second):
		t.Fatal("monitor did not stop")
	}
	if _, err := processutil.Identity(worker.Process.Pid); err != nil {
		t.Fatal("monitor shutdown killed worker")
	}
}

func TestCrashContractPairingWaitIsDeclaredOnce(t *testing.T) {
	worker := contractProcess(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done, exit := make(chan struct{}), make(chan struct{})
	defer close(done)
	go func() { watchWorkerHealth(ln, "token", worker, done, 500*time.Millisecond); close(exit) }()
	send := func(r workerHealthReport) {
		t.Helper()
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(c).Encode(r)
		_ = c.Close()
	}
	send(workerHealthReport{Token: "token", PID: worker.Process.Pid, PairingWait: true})
	select {
	case <-exit:
		t.Fatal("declared pairing wait was killed")
	case <-time.After(800 * time.Millisecond):
	}
	send(workerHealthReport{Token: "token", PID: worker.Process.Pid, Healthy: true})
	send(workerHealthReport{Token: "token", PID: worker.Process.Pid, PairingWait: true})
	select {
	case <-exit:
	case <-time.After(3 * time.Second):
		t.Fatal("second pairing declaration bypassed runtime deadline")
	}
	_ = worker.Wait()
}
