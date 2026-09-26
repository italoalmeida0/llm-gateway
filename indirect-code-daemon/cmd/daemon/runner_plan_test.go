package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// resultText flattens a tool result's text blocks for assertions.
func resultText(res core.ToolResult) string {
	var sb strings.Builder
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			sb.WriteString(tb.Text)
		}
	}
	return sb.String()
}

// bashJSON builds the tool's raw JSON args.
func bashJSON(t *testing.T, command string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"command": command})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// portable picks a POSIX/cmd command pair so the seam is proven on every
// platform (mirrors the runner package's own tests).
func portable(sh, win string) string {
	if runtime.GOOS == "windows" {
		return win
	}
	return sh
}

// Closing the remaining plan scenarios (docs/runner-plan.md T4/T8/T9):
// update crossing, slow parent, and the 10s agent-foreground window
// THROUGH the runner-backed starter (the production seam).

// T4: two runner generations staged — the old generation's task runs to
// completion under the newer world and its binary is cleaned afterwards
// (no rollback copies, decided D3), while the new binary survives.
func TestRunnerUpdateCrossingCleansOldGeneration(t *testing.T) {
	posixOnly(t)
	root, _ := runnerTestRoot(t)
	// Stage a NEWER generation binary (as an update would leave behind).
	newer := runner.BinaryPath(root, "v2")
	_ = os.MkdirAll(runner.RunnersDir(root), 0o700)
	if err := os.WriteFile(newer, []byte("newer"), 0o755); err != nil {
		t.Fatal(err)
	}

	started := runner.NowMs()
	spec := runner.Spec{
		JobID: "gen1", SessionID: "sess1", Kind: "bash", Label: "t",
		Path: "/bin/sh", Args: []string{"-c", portable("/bin/echo crossing-done", "echo crossing-done")},
		Env:  os.Environ(),
		Root: root, RunnerVersion: "v1",
		OutPath:   filepath.Join(runner.OutDir(root), runner.OutName("sess1", "gen1", started)),
		BrainPath: filepath.Join(root, "brain", "sess1", "gen1.log"),
	}
	// The OLD generation's binary exists (this run IS that generation).
	old := runner.BinaryPath(root, "v1")
	_ = os.WriteFile(old, []byte("old"), 0o755)

	if code := runner.Run(spec); code != 0 {
		t.Fatalf("exit %d", code)
	}
	// Task outcome survived the generation crossing…
	if !fileHas(spec.BrainPath, "crossing-done") {
		t.Fatal("task output lost across the generation crossing")
	}
	// …and the dead generation cleaned up after itself (no rollback).
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("dead generation binary must be cleaned after its last task")
	}
	if _, err := os.Stat(newer); err != nil {
		t.Fatal("the newer generation binary must survive")
	}
}

// T8: a parent that connects but NEVER reads must not block the task —
// the socket is an optimization; the log is the buffer. The command
// completes in time and the out log is byte-complete.
func TestRunnerSlowParentNeverBlocksTheTask(t *testing.T) {
	posixOnly(t)
	root, dataDir := runnerTestRoot(t)
	// Big output + a slow reader: if sends blocked, this would hang.
	cmd := portable(
		"i=0; while [ $i -lt 2000 ]; do /bin/echo line-$i; i=$((i+1)); done",
		`for /L %i in (1,1,2000) do @echo line-%i`,
	)
	proc := spawnTestRunner(t, root, dataDir, cmd)

	// Connect and then STOP reading (the runner keeps producing).
	var st *runner.State
	waitFor(t, 5*time.Second, func() bool {
		var err error
		st, err = runner.ReadState(runner.StatePath(root, proc.JobID))
		return err == nil && st.Transport.Port != 0
	})
	raw, err := net.Dial("tcp", net.JoinHostPort(st.Transport.Host, strconv.Itoa(st.Transport.Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	c := runner.NewConn(raw)
	if err := c.Send(runner.Hello{Type: runner.VerbHello, Proto: runner.ProtoVersion, Token: st.Transport.Token}); err != nil {
		t.Fatal(err)
	}
	// …and never read a single byte back.

	done := make(chan error, 1)
	go func() { done <- proc.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("task failed under a slow parent: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("a stalled reader blocked the task — the socket must never own the runner")
	}
	// The log is byte-complete regardless of the stalled socket.
	waitFor(t, 5*time.Second, func() bool { return fileHas(proc.LogPath, "line-1999") })
}

// T9: the agent foreground window THROUGH the runner-backed starter —
// exactly the production seam (tools.BashTool + runnerStarter): a short
// command returns inline (no background notice); a long one detaches at
// AutoBackgroundAfter with a placeholder naming the log.
func TestRunnerForegroundWindowThroughBashTool(t *testing.T) {
	posixOnly(t)
	app, err := buildRealApp()
	if err != nil {
		t.Fatal(err)
	}
	oldOverride := runnerSourceOverride
	runnerSourceOverride = app
	defer func() { runnerSourceOverride = oldOverride }()
	root, dataDir := runnerTestRoot(t)
	brainDir := filepath.Join(dataDir, "brain", "sess1")

	oldWindow := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 300 * time.Millisecond // same knob, smaller
	defer func() { tools.AutoBackgroundAfter = oldWindow }()

	// SHORT: returns inline, no Slow() registration.
	short := &tools.BashTool{
		CWD: t.TempDir(), LogDir: brainDir,
		Starter: runnerStarter(root, "sess1", brainDir),
		Slow: func(kind, label string, p tools.BackgroundProcess) (string, string, func(string), func(string, bool)) {
			t.Fatal("short command must never register a background job")
			return "", "", nil, nil
		},
	}
	res, err := short.Execute(context.Background(), bashJSON(t, portable("/bin/echo inline-ok", "echo inline-ok")), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(resultText(res), "inline-ok") {
		t.Fatalf("inline output missing: %q", resultText(res))
	}

	// LONG: detaches at the window with the placeholder + registry id.
	var mu sync.Mutex
	var registered tools.BackgroundProcess
	long := &tools.BashTool{
		CWD: t.TempDir(), LogDir: brainDir,
		Starter: runnerStarter(root, "sess1", brainDir),
		Slow: func(kind, label string, p tools.BackgroundProcess) (string, string, func(string), func(string, bool)) {
			mu.Lock()
			registered = p
			mu.Unlock()
			return "bg_" + "t9", p.BrainLog, func(string) {}, func(string, bool) {}
		},
	}
	res, err = long.Execute(context.Background(), bashJSON(t, portable("/bin/echo early; sleep 2", "echo early & ping -n 3 127.0.0.1 >nul")), nil)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	p := registered
	mu.Unlock()
	if p.PID == 0 {
		t.Fatal("long command never registered a background job")
	}
	if p.JobID == "" {
		t.Fatal("the runner identity must flow into the background registration")
	}
	// The placeholder must name the brain log and the job identity.
	text := resultText(res)
	if !strings.Contains(text, p.BrainLog) {
		t.Fatalf("placeholder must name the brain log (%s), got: %q", p.BrainLog, text)
	}
	if !strings.Contains(text, p.JobID) {
		t.Fatalf("placeholder must carry the job identity (%s), got: %q", p.JobID, text)
	}
	// Stop cleans the tree.
	p.Stop()
}


// T12: crash windows AT the terminal transition. The runner records
// `done` and dies BEFORE the brain copy (W1) or MID-copy (W2) — the two
// most dangerous, most unlikely instants. The state file is the durable
// outcome, so the parent's reconciliation must HEAL the copy from the
// out log (source of truth) and still fold exactly one notice.
func TestRunnerTerminalCopyHealedAfterCrashWindows(t *testing.T) {
	posixOnly(t)
	root, dataDir := runnerTestRoot(t)
	code := 0

	// W1: done state exists, crash before ANY copy.
	out1 := filepath.Join(runner.OutDir(root), runner.OutName("sess1", "w1", 1))
	_ = os.MkdirAll(filepath.Dir(out1), 0o700)
	_ = os.WriteFile(out1, []byte("full outcome w1\n"), 0o600)
	brain1 := filepath.Join(dataDir, "brain", "sess1", "w1.log")
	end1 := runner.NowMs()
	_ = runner.WriteState(root, &runner.State{
		JobID: "w1", SessionID: "sess1", Kind: "bash", Label: "t",
		Status: runner.StatusDone, ExitCode: &code, EndedAt: &end1,
		LogPath: out1, BrainPath: brain1,
	})
	_ = runner.WriteDisposition(root, "w1", runner.DispBackground)

	// W2: done state + a TORN mid-copy (truncated brain file).
	out2 := filepath.Join(runner.OutDir(root), runner.OutName("sess1", "w2", 2))
	_ = os.WriteFile(out2, []byte("complete tail w2\n"), 0o600)
	brain2 := filepath.Join(dataDir, "brain", "sess1", "w2.log")
	_ = os.MkdirAll(filepath.Dir(brain2), 0o700)
	_ = os.WriteFile(brain2, []byte("com"), 0o600) // torn: crash mid-copy
	end2 := runner.NowMs()
	_ = runner.WriteState(root, &runner.State{
		JobID: "w2", SessionID: "sess1", Kind: "bash", Label: "t",
		Status: runner.StatusDone, ExitCode: &code, EndedAt: &end2,
		LogPath: out2, BrainPath: brain2,
	})
	_ = runner.WriteDisposition(root, "w2", runner.DispBackground)

	// A parent boots and reconciles: both copies must be healed.
	inbox := make(chan Envelope, 8)
	startBG(t, dataDir, func(string) (chan Envelope, chan any, bool) { return inbox, nil, true })
	waitFor(t, 5*time.Second, func() bool {
		return fileHas(brain1, "full outcome w1") && fileHas(brain2, "complete tail w2")
	})
	// Copy semantics survive the heal: the out originals are intact.
	if !fileHas(out1, "full outcome w1") || !fileHas(out2, "complete tail w2") {
		t.Fatal("healing must never consume the out original")
	}
	// And both outcomes fold into the notice chain (exactly once each).
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case env := <-inbox:
			if n, ok := env.Payload.(bgNoticeMsg); ok {
				seen[n.JobID] = true
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("notice chain incomplete after the crash windows: %v", seen)
		}
	}
}
