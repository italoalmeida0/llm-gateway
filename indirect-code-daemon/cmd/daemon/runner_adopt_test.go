package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"strconv"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Runner adoption tests (docs/runner-plan.md T2/T3/T5/T7/T10): real
// runner subprocesses, real signals, real state files.

// runnerTestRoot lays out <root>/slots/slot-a (the daemon's real shape).
func runnerTestRoot(t *testing.T) (root, dataDir string) {
	t.Helper()
	root = t.TempDir()
	dataDir = filepath.Join(root, "slots", "slot-a")
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions"), 0o700); err != nil {
		t.Fatal(err)
	}
	return root, dataDir
}

// seedSession writes a session record that KNOWS the job (placeholder
// row — the link F5b recovery looks for).
func seedSession(t *testing.T, dataDir, sessionID, jobID string) {
	t.Helper()
	st := newDiskStore(dataDir)
	rec := &SessionRecord{ID: sessionID, CWD: t.TempDir(), Title: "t", Model: "m",
		Status: "running", CreatedAt: 1, UpdatedAt: 1,
		Messages: []provider.Message{{
			Role:      provider.RoleTool,
			Content:   []provider.Content{provider.TextBlock{Text: "[Background bash task " + jobID + "] output: x"}},
			TurnIndex: 1,
		}},
	}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "sessions", sessionID+".jsonl")); err != nil {
		t.Fatalf("seed did not persist: %v", err)
	}
}

// buildRealApp compiles the REAL multi-call binary once per test run:
// the go test binary cannot take the --runner role.
var buildRealApp = sync.OnceValues(func() (string, error) {
	dir, err := os.MkdirTemp("", "runner-app-*")
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, "indirect-code")
	// -buildvcs=false: test builds must not depend on git metadata
	// (the musl container's git ownership makes the stamp step fail).
	cmd := exec.Command("go", "build", "-buildvcs=false", "-o", out, ".")
	if outb, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("build app: %v: %s", err, outb)
	}
	return out, nil
})

// spawnTestRunner starts a real runner-backed command through the same
// factory the daemon injects into the tools.
func spawnTestRunner(t *testing.T, root, dataDir, command string) *tools.Proc {
	t.Helper()
	app, err := buildRealApp()
	if err != nil {
		t.Fatal(err)
	}
	old := runnerSourceOverride
	runnerSourceOverride = app
	t.Cleanup(func() { runnerSourceOverride = old })
	bin, err := ensureRunnerBinary(root)
	if err != nil {
		t.Fatal(err)
	}
	_ = bin
	// Resolve the shell EXACTLY like the daemon does (unish on Windows —
	// downloaded on demand, no cmd fallback; bash/sh on unix). The test
	// must exercise the real terminal path, not a substitute.
	shell, flag := tools.ShellForTests()
	if shell == "" {
		t.Skip("no usable shell on this host")
	}
	proc, err := startRunner(root, "sess1", filepath.Join(dataDir, "brain", "sess1"), tools.ExecSpec{
		Kind: "bash", Command: command,
		Argv: []string{shell, flag, command},
		Env:  os.Environ(),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Only report ready once the runner published its state (the contract
	// the adoption scan reads).
	waitFor(t, 5*time.Second, func() bool {
		_, err := runner.ReadState(runner.StatePath(root, proc.JobID))
		return err == nil
	})
	return proc
}

// T2 (flagship): the parent dies mid-task; a new parent re-adopts the
// live runner, the output is complete and the completion is delivered
// exactly once (idempotent through the transcript identity).
func TestRunnerSurvivesParentDeathAndIsAdopted(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo one; sleep 2; echo two")

	// Parent #1 registers the job the way slowHook does.
	inbox1 := make(chan Envelope, 8)
	b1 := newBGSupervisor(dataDir)
	b1.session = func(string) (chan Envelope, chan any, bool) { return inbox1, nil, true }
	var wg1 sync.WaitGroup
	wg1.Add(1)
	go b1.run(&wg1)
	reply := make(chan any, 1)
	b1.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: "sess1", Label: "cmd",
		LogPath: proc.LogPath, PID: proc.PID, JobID: proc.JobID, Stop: proc.Stop, Reply: reply}}
	<-reply

	// Let the first output land, then "SIGKILL the parent".
	waitFor(t, 3*time.Second, func() bool { return fileHas(proc.LogPath, "one") })
	b1.control <- shutdownMsg{}
	wg1.Wait()

	// The session knows the job (placeholder row) — F5b recovery link.
	seedSession(t, dataDir, "sess1", proc.JobID)

	// Parent #2 boots on the same root: adoption resumes the task.
	inbox2 := make(chan Envelope, 8)
	b2 := startBG(t, dataDir, func(string) (chan Envelope, chan any, bool) { return inbox2, nil, true })
	t.Cleanup(proc.Stop)

	// Adoption: the live job shows up again.
	waitFor(t, 5*time.Second, func() bool {
		for _, row := range listJobs(b2) {
			if row["id"] == proc.JobID {
				return true
			}
		}
		return false
	})

	// The task completes under the NEW parent; output is byte-complete.
	waitFor(t, 10*time.Second, func() bool { return fileHas(proc.BrainLog, "two") })
	out, _ := os.ReadFile(proc.LogPath)
	if !strings.Contains(string(out), "one") || !strings.Contains(string(out), "two") {
		t.Fatalf("stream must stitch with no gaps: %q", out)
	}

	// Exactly one completion notice reaches the session; the ack retires it.
	var notice bgNoticeMsg
	select {
	case env := <-inbox2:
		n, ok := env.Payload.(bgNoticeMsg)
		if !ok {
			t.Fatalf("unexpected payload %T", env.Payload)
		}
		notice = n
	case <-time.After(5 * time.Second):
		t.Fatal("completion notice never delivered after adoption")
	}
	if notice.JobID != proc.JobID || !notice.Finished {
		t.Fatalf("notice: %+v", notice)
	}
	b2.inbox <- Envelope{Payload: bgAckMsg{JobID: proc.JobID}}
	// In-flight copies queued BEFORE the ack are by design (delivery is
	// retried until acknowledged; the transcript dedupes). After the ack
	// settles, nothing new may arrive.
	time.Sleep(3 * bgNoticeRetryEvery)
	for len(inbox2) > 0 {
		<-inbox2 // drain whatever was already in flight
	}
	time.Sleep(3 * bgNoticeRetryEvery)
	select {
	case env := <-inbox2:
		if n, ok := env.Payload.(bgNoticeMsg); ok && n.JobID == proc.JobID {
			t.Fatal("acked notice redelivered")
		}
	default:
	}
}

// T3: the RUNNER dies — the parent reports an explicit failure, never a
// silent hang, and the log survives.
func TestRunnerDeathIsAnExplicitFailure(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo partial; sleep 30")
	seedSession(t, dataDir, "sess1", proc.JobID)
	// A real background job records its disposition at detach (V2R-001);
	// absent = inline (silent), so a notifying test must set it.
	if err := runner.WriteDisposition(root, proc.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, func() bool { return fileHas(proc.LogPath, "partial") })

	// HARD-kill the runner itself: no signal handler, no terminal
	// transition, no copy — exactly the crash window the F6 path covers.
	killed, err := os.FindProcess(proc.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := killed.Kill(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	inbox := make(chan Envelope, 8)
	startBG(t, dataDir, func(string) (chan Envelope, chan any, bool) { return inbox, nil, true })

	// Adoption folds it as an explicit failure notice.
	select {
	case env := <-inbox:
		n, ok := env.Payload.(bgNoticeMsg)
		if !ok || n.Finished != true {
			t.Fatalf("expected a terminal notice, got %+v", env.Payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("dead runner produced a silent hang instead of a failure")
	}
	if !fileHas(proc.LogPath, "partial") {
		t.Fatal("the log must survive the runner's death")
	}
}

// T5: kill takes the whole tree down (grandchildren included).
func TestRunnerKillTakesTheTreeDown(t *testing.T) {
	posixOnly(t)
	root, dataDir := runnerTestRoot(t)
	marker := filepath.Join(t.TempDir(), "grandchild.pid")
	command := "sh -c 'echo $$ > " + marker + "; sleep 30'"
	proc := spawnTestRunner(t, root, dataDir, command)
	t.Cleanup(proc.Stop)
	waitFor(t, 5*time.Second, func() bool { return fileHas(marker, "") || fileExists(marker) })

	raw, _ := os.ReadFile(marker)
	gcPid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	if gcPid <= 0 {
		t.Fatalf("grandchild pid: %q", raw)
	}
	proc.Stop()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) && pidAlive(strconv.Itoa(gcPid)) {
		time.Sleep(100 * time.Millisecond)
	}
	if pidAlive(strconv.Itoa(gcPid)) {
		t.Fatal("grandchild survived the kill — the tree must die together")
	}
}

// T7: done with no parent around — the state carries the outcome and a
// later boot delivers it exactly once (transcript identity dedupes).
func TestRunnerDoneWithoutParentIsRecoveredFromState(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo quick")
	seedSession(t, dataDir, "sess1", proc.JobID)
	// A real background job records its disposition at detach (V2R-001);
	// absent means inline (silent), so a notifying test must set it.
	if err := runner.WriteDisposition(root, proc.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}

	// No parent: the runner writes the outcome and exits (D5).
	waitFor(t, 5*time.Second, func() bool {
		st, err := runner.ReadState(runner.StatePath(root, proc.JobID))
		return err == nil && st.Terminal()
	})
	// The terminal COPY follows the state write (the state is the durable
	// outcome, the copy is its companion) — wait for it.
	waitFor(t, 5*time.Second, func() bool { return fileHas(proc.BrainLog, "quick") })

	// A later parent folds it into the notice chain.
	inbox := make(chan Envelope, 8)
	startBG(t, dataDir, func(string) (chan Envelope, chan any, bool) { return inbox, nil, true })

	select {
	case env := <-inbox:
		n, ok := env.Payload.(bgNoticeMsg)
		if !ok || n.JobID != proc.JobID || !n.Finished {
			t.Fatalf("notice: %+v", env.Payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("done state lost across parentless completion")
	}
}

// T10: orphan policy — a runner the session cannot know is SIGKILLed
// and cleaned; one the session knows is adopted.
func TestRunnerOrphanPolicy(t *testing.T) {
	old := orphanAfterMs
	orphanAfterMs = 0 // no freshness exemption in this test
	defer func() { orphanAfterMs = old }()

	// Known job: adopted.
	rootKnown, dataDirKnown := runnerTestRoot(t)
	known := spawnTestRunner(t, rootKnown, dataDirKnown, "sleep 30")
	t.Cleanup(known.Stop)
	seedSession(t, dataDirKnown, "sess1", known.JobID)

	// Unknown job (session has moved past it): orphan.
	rootOrphan, dataDirOrphan := runnerTestRoot(t)
	orphan := spawnTestRunner(t, rootOrphan, dataDirOrphan, "sleep 30")
	t.Cleanup(func() { _ = terminatePid(orphan.PID) })
	seedSession(t, dataDirOrphan, "sess1", "some-other-job")

	b1 := newBGSupervisor(dataDirKnown)
	b1.session = func(string) (chan Envelope, chan any, bool) { return make(chan Envelope, 8), nil, true }
	b2 := newBGSupervisor(dataDirOrphan)
	b2.session = func(string) (chan Envelope, chan any, bool) { return make(chan Envelope, 8), nil, true }
	b1.adoptRunners()
	b2.adoptRunners()

	if !pidAlive(strconv.Itoa(known.PID)) {
		t.Fatal("a runner the session knows must be adopted, not killed")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && pidAlive(strconv.Itoa(orphan.PID)) {
		time.Sleep(50 * time.Millisecond)
	}
	if pidAlive(strconv.Itoa(orphan.PID)) {
		t.Fatal("a truly orphaned runner must be SIGKILLed")
	}
	if _, err := os.Stat(runner.StatePath(rootOrphan, orphan.JobID)); !os.IsNotExist(err) {
		t.Fatal("orphan state must be cleaned")
	}
}

// posixOnly gates the shell-scenario tests (the runner core itself is
// exercised on every platform; these drive /bin/sh command shapes).
func posixOnly(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell scenario")
	}
}

// ---- small helpers ----

// startBG runs a supervisor for the test and wires cleanup.
func startBG(t *testing.T, dataDir string, session func(string) (chan Envelope, chan any, bool)) *bgSupervisor {
	t.Helper()
	b := newBGSupervisor(dataDir)
	if session != nil {
		b.session = session
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() {
		select {
		case b.control <- shutdownMsg{}:
		case <-time.After(2 * time.Second):
		}
		wg.Wait()
	})
	return b
}

func waitFor(t *testing.T, d time.Duration, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if ok() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func fileHas(path, needle string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	if needle == "" {
		return len(raw) >= 0
	}
	return strings.Contains(string(raw), needle)
}

func listJobs(b *bgSupervisor) []map[string]any {
	reply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}:
	case <-time.After(time.Second):
		return nil
	}
	select {
	case r := <-reply:
		rows, _ := r.([]map[string]any)
		return rows
	case <-time.After(time.Second):
		return nil
	}
}
