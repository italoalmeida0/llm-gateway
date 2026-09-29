package main

// Deep regression tests for the session-owned bg task pipeline. Each test
// models a REAL race/window a user can hit (not just the happy path):
//   - pump chunks split mid-line (8KB/20ms boundaries) must not corrupt
//     line numbering (dup/gap in the joined log);
//   - output printed BEFORE the detach threshold must reach the bg stream
//     (card + bg_check) from the very first line;
//   - a truncated inline result must never leak temp paths to the model;
//   - chunks must survive a crash while the session is idle (no WAL yet);
//   - a mid-watch identity race must not make watchAdopted give up.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// --- 1. line counting across chunk splits -------------------------------

func TestBgChunkSplitMidLineKeepsNumbering(t *testing.T) {
	rec := &SessionRecord{ID: "sess1"}
	upsertBgTask(rec, &BgTask{ID: "bg_1", Kind: "bash", Label: "x", Status: BgStatusRunning, StartedAt: 1})
	// The pump hands us byte windows; a window can cut a line in half.
	applyBgChunk(rec, "bg_1", "a\nb", bgLiveCap) // lines 1-2
	applyBgChunk(rec, "bg_1", "\nc", bgLiveCap) // line 3 (split BEFORE its \n)
	applyBgChunk(rec, "bg_1", "\nd\ne", bgLiveCap)
	task := rec.BgTasks[0]
	if task.TotalLines != 5 {
		t.Fatalf("chunk splits must not inflate line counts: TotalLines=%d want 5", task.TotalLines)
	}
	text, from, to, _ := bgReadPage(&task, 0, 50)
	if from != 1 || to != 5 {
		t.Fatalf("page range drifted: %d-%d want 1-5 (text=%q)", from, to, text)
	}
	if text != "a\nb\nc\nd\ne" {
		t.Fatalf("joined content corrupted: %q", text)
	}
}

func TestBgOutputFromMatchesChunkLines(t *testing.T) {
	var events []map[string]any
	a := &sessionActor{rec: &SessionRecord{ID: "sess1"}, id: "sess1", store: newDiskStore(t.TempDir()),
		wsSend: func(ev any) { events = append(events, ev.(map[string]any)) }}
	a.onBgTaskRegister(bgTaskRegisterMsg{JobID: "bg_1", Kind: "bash", Label: "x"})
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: "bg_1", Text: "a\nb"})
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: "bg_1", Text: "\nc"})
	var outs []map[string]any
	for _, ev := range events {
		if ev["type"] == "bg_output" {
			outs = append(outs, ev)
		}
	}
	if len(outs) != 2 {
		t.Fatalf("want 2 bg_output events, got %d", len(outs))
	}
	// First chunk owns lines 1-2; the split chunk owns line 3 only.
	if outs[0]["from"] != int64(1) {
		t.Fatalf("first chunk from=%v want 1", outs[0]["from"])
	}
	if outs[1]["from"] != int64(3) {
		t.Fatalf("split chunk from=%v want 3 (mid-line splits must not shift numbering)", outs[1]["from"])
	}
	if outs[1]["total"] != int64(3) {
		t.Fatalf("total=%v want 3", outs[1]["total"])
	}
}

// --- 2. pre-detach output reaches the bg stream --------------------------

func TestBgStreamIncludesPreDetachOutput(t *testing.T) {
	dir := t.TempDir()
	tools.AutoBackgroundAfter = 300 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = 10 * time.Second }()
	var mu sync.Mutex
	var streamed []string
	bt := &tools.BashTool{
		CWD: dir, LogDir: dir,
		Slow: func(kind, label string, p tools.BackgroundProcess) (string, string, func(string), func(string, bool)) {
			return "bg_1", p.BrainLog, func(chunk string) { mu.Lock(); streamed = append(streamed, chunk); mu.Unlock() }, func(string, bool) {}
		},
	}
	args, _ := json.Marshal(map[string]any{"command": "echo EARLY-1; echo EARLY-2; sleep 1; echo LATE-3"})
	if _, err := bt.Execute(context.Background(), args, func(string) {}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		all := strings.Join(streamed, "")
		mu.Unlock()
		if strings.Contains(all, "LATE-3") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	joined := strings.Join(streamed, "")
	mu.Unlock()
	for _, want := range []string{"EARLY-1", "EARLY-2", "LATE-3"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("bg stream lost pre-detach output %q (stream=%q): the card/bg_check must see EVERY line from the start", want, joined)
		}
	}
	// Full log from the first line to the last, in order.
	if strings.Index(joined, "EARLY-1") > strings.Index(joined, "LATE-3") {
		t.Fatalf("bg stream out of order: %q", joined)
	}
}

func TestBgStreamIncludesPreDetachOutputPython(t *testing.T) {
	if _, err := tools.PythonAvailable(); err != nil {
		t.Skip("no python3 interpreter on this host (musl/Alpine)")
	}
	dir := t.TempDir()
	tools.AutoBackgroundAfter = 300 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = 10 * time.Second }()
	var mu sync.Mutex
	var streamed []string
	pt := &tools.PythonTool{
		CWD: dir, LogDir: dir,
		Slow: func(kind, label string, p tools.BackgroundProcess) (string, string, func(string), func(string, bool)) {
			return "bg_1", p.BrainLog, func(chunk string) { mu.Lock(); streamed = append(streamed, chunk); mu.Unlock() }, func(string, bool) {}
		},
	}
	code := "import time\nprint('PY-EARLY')\ntime.sleep(1)\nprint('PY-LATE')\n"
	args, _ := json.Marshal(map[string]any{"code": code})
	if _, err := pt.Execute(context.Background(), args, func(string) {}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		all := strings.Join(streamed, "")
		mu.Unlock()
		if strings.Contains(all, "PY-LATE") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	joined := strings.Join(streamed, "")
	mu.Unlock()
	if !strings.Contains(joined, "PY-EARLY") || !strings.Contains(joined, "PY-LATE") {
		t.Fatalf("python bg stream lost output: %q", joined)
	}
}

// --- 3. no temp paths in the model-visible result ------------------------

func TestBgInlineResultNeverLeaksPaths(t *testing.T) {
	dir := t.TempDir()
	bt := &tools.BashTool{CWD: dir, LogDir: dir}
	args, _ := json.Marshal(map[string]any{"command": "for i in $(seq 1 20000); do echo line-$i; done"})
	res, err := bt.Execute(context.Background(), args, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Content is what the LLM sees (core.ToolResult.Content -> provider).
	text := resultText(res)
	if strings.Contains(text, "/tmp") || strings.Contains(text, "full output:") || strings.Contains(text, "Full output:") {
		i := strings.Index(text, "Full output:")
		if i < 0 {
			i = 0
		}
		t.Fatalf("model-visible result leaked a file path (around %q)", text[max(0, i):min(i+140, len(text))])
	}
	// Truncation is an envelope attr (page/truncated), not body prose.
	// The exact line count is platform-dependent (\r\n output on Windows
	// changes the count), so assert the SHAPE: page="from-to/total" with
	// truncated=true and a next cursor beyond the shown range.
	attrs := map[string]string{}
	for _, a := range res.Attrs {
		attrs[a.Key] = a.Value
	}
	if attrs["truncated"] != "true" {
		t.Fatalf("truncated result must report truncated=true: %v", attrs)
	}
	m := regexp.MustCompile(`^(\d+)-(\d+)/(\d+)$`).FindStringSubmatch(attrs["page"])
	if m == nil {
		t.Fatalf("page attr must be from-to/total: %q", attrs["page"])
	}
	from, to, total := m[1], m[2], m[3]
	fi, _ := strconv.Atoi(from)
	ti, _ := strconv.Atoi(to)
	totaI, _ := strconv.Atoi(total)
	if !(fi <= ti && ti <= totaI) {
		t.Fatalf("page range out of order: %q", attrs["page"])
	}
	if attrs["next"] != fmt.Sprintf("%d", ti+1) {
		t.Fatalf("next attr must continue after %s: %q", to, attrs["next"])
	}
	// Details are UI-only (core.ToolResult.Details never reaches the LLM —
	// provider.ToolResultBlock carries Content only), so the full output
	// path belongs there. The contract under test: Content is path-free.
}

// --- 4. chunks survive a crash while idle (no WAL yet) -------------------

func TestBgChunksDurableWhileIdle(t *testing.T) {
	dir := t.TempDir()
	rec := &SessionRecord{ID: "sess1"}
	a := newSessionActor("sess1", rec, newDiskStore(dir), nil, nil, nil)
	a.onBgTaskRegister(bgTaskRegisterMsg{JobID: "bg_1", Kind: "bash", Label: "x"})
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: "bg_1", Text: "precious-1\n"})
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: "bg_1", Text: "precious-2\n"})
	// CRASH here: no flush tick ran (throttle window). Reload from disk.
	fused, _, err := newDiskStore(dir).loadSessionFused("sess1")
	if err != nil {
		t.Fatal(err)
	}
	if len(fused.BgTasks) != 1 {
		t.Fatalf("task lost on crash: %+v", fused.BgTasks)
	}
	got := fused.BgTasks[0].Content
	if !strings.Contains(got, "precious-1") || !strings.Contains(got, "precious-2") {
		t.Fatalf("chunks lost on crash while idle: content=%q (every chunk must be durable)", got)
	}
}

// --- 5. watchAdopted survives an identity race ---------------------------

func TestBgWatchAdoptedSurvivesIdentityRace(t *testing.T) {
	root := t.TempDir()
	state := &runner.State{
		JobID: "bg_1", SessionID: "sess1", Kind: "bash", Label: "x",
		PID: os.Getpid(), ProcessIdentity: "WRONG-IDENTITY", // identity race
		Status: runner.StatusRunning, StartedAt: time.Now().UnixMilli(),
	}
	if err := runner.WriteState(root, state); err != nil {
		t.Fatal(err)
	}
	finishes := make(chan string, 4)
	b := &bgSupervisor{
		jobs: map[string]*bgJob{}, notices: map[string]*pendingNotice{},
		dataDir: root, done: make(chan struct{}),
		inbox: make(chan Envelope, 8),
	}
	go func() {
		for env := range b.inbox {
			if m, ok := env.Payload.(bgFinishMsg); ok {
				finishes <- m.Status
			}
		}
	}()
	go b.watchAdopted("bg_1", state)
	// Let the first ticks observe the identity race (2s cadence).
	time.Sleep(2500 * time.Millisecond)
	// The race resolves: identity becomes verifiable and the state goes
	// terminal. The watcher must STILL be observing and deliver the finish.
	ident, _ := processutil.Identity(os.Getpid())
	state.ProcessIdentity = ident
	code := 0
	state.Status, state.ExitCode = runner.StatusDone, &code
	if err := runner.WriteState(root, state); err != nil {
		t.Fatal(err)
	}
	select {
	case status := <-finishes:
		if status != BgStatusDone {
			t.Fatalf("finish status=%q want done", status)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("watchAdopted gave up after an identity race: the job never finished in the registry")
	}
	close(b.inbox)
}

// --- 6. no chunk is ever dropped under mailbox pressure ------------------

func TestBgChunkDeliverySurvivesMailboxPressure(t *testing.T) {
	dir := t.TempDir()
	rec := &SessionRecord{ID: "sess1"}
	a := newSessionActor("sess1", rec, newDiskStore(dir), nil, nil, nil)
	a.onBgTaskRegister(bgTaskRegisterMsg{JobID: "bg_1", Kind: "bash", Label: "x"})
	// The REAL actor loop drains up to 64 messages per iteration and does
	// disk work in between — model a slow consumer (backpressure).
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case env := <-a.inbox:
				a.handleData(env)
			case <-time.After(3 * time.Second):
				return
			}
			time.Sleep(2 * time.Millisecond) // actor's disk/flush work
		}
	}()
	// Producer: stream chunks through the reliable path while the mailbox
	// is under pressure (producer is faster than the consumer).
	w := &turnBridge{env: workerEnv{inbox: a.inbox, actorID: "sess1"}, ctx: context.Background()}
	jobCtx, jobStop := context.WithCancel(context.Background())
	for i := 0; i < 50; i++ {
		w.sendBgTask(jobCtx, bgTaskChunkMsg{JobID: "bg_1", Text: "c" + string(rune('0'+i%10)) + "\n"})
	}
	// Terminal lands in order AFTER the chunks (jobStop runs after).
	w.sendBgTask(jobCtx, bgTaskFinishMsg{JobID: "bg_1", Status: BgStatusDone})
	jobStop()
	<-done
	if got := a.rec.BgTasks[0].TotalLines; got != 50 {
		t.Fatalf("chunks dropped under mailbox pressure: got %d/50 lines (no chunk may be lost)", got)
	}
	if a.rec.BgTasks[0].Status != BgStatusDone {
		t.Fatalf("terminal lost or out of order: status=%q", a.rec.BgTasks[0].Status)
	}
}
