package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

func TestRecoveredTaskRestoresDowntimeOutputAndCompletion(t *testing.T) {
	a, store := darActor(t, &SessionRecord{ID: "recovered", BgTasks: []BgTask{{ID: "job", Status: BgStatusRunning, Content: "before\n", TotalBytes: 7, TotalLines: 1}}})
	log := filepath.Join(t.TempDir(), "out.log")
	output := "before\nduring downtime\nlast output\n"
	if err := os.WriteFile(log, []byte(output), 0600); err != nil {
		t.Fatal(err)
	}
	st := &runner.State{JobID: "job", SessionID: a.id, Kind: "bash", Label: "command", LogPath: log, Status: runner.StatusRunning, StartedAt: 1}
	root := store.rootDir()
	if err := runner.WriteState(root, st); err != nil {
		t.Fatal(err)
	}
	if err := runner.WriteDisposition(root, st.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	if offset, err := a.restoreRunnerTask(st.JobID); err != nil || offset != int64(len(output)) {
		t.Fatalf("restore offset=%d err=%v", offset, err)
	}
	code, ended := 7, time.Now().UnixMilli()
	st.Status, st.ExitCode, st.EndedAt = runner.StatusDone, &code, &ended
	if err := runner.WriteState(root, st); err != nil {
		t.Fatal(err)
	}
	if _, err := a.restoreRunnerTask(st.JobID); err != nil {
		t.Fatal(err)
	}
	// Bytes queued before the terminal snapshot must not be appended twice.
	a.onRecoveredBgChunk(bgTaskRecoverChunkMsg{JobID: st.JobID, Offset: 7, Text: output[7:]})
	disk, err := store.loadSession(a.id)
	if err != nil {
		t.Fatal(err)
	}
	got := disk.BgTasks[0]
	if got.Content != output || got.Status != BgStatusError || got.ExitCode != 7 || got.TotalLines != 3 {
		t.Fatalf("wrong recovered task: %+v", got)
	}
	seq := got.Seq
	if _, err := a.restoreRunnerTask(st.JobID); err != nil {
		t.Fatal(err)
	}
	if a.rec.BgTasks[0].Seq != seq {
		t.Fatal("identical recovery was not idempotent")
	}
}

func TestRunnerNoticeRetriesFailedTaskPersistence(t *testing.T) {
	a, store := darActor(t, &SessionRecord{ID: "retry-recovered"})
	a.state, a.rec.Status = stateRunning, "running"
	a.bg = newBGSupervisor(store.dataDir)
	root := store.rootDir()
	log := filepath.Join(t.TempDir(), "out.log")
	if err := os.WriteFile(log, []byte("recovered output\n"), 0600); err != nil {
		t.Fatal(err)
	}
	code, ended := 0, time.Now().UnixMilli()
	if err := runner.WriteState(root, &runner.State{JobID: "retry", SessionID: a.id, Status: runner.StatusDone, LogPath: log, ExitCode: &code, EndedAt: &ended}); err != nil {
		t.Fatal(err)
	}
	if err := runner.WriteDisposition(root, "retry", runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	path := store.sessionFile(a.id)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	notice := bgNoticeMsg{JobID: "retry", Text: "completed", Finished: true}
	for range 2 {
		a.onBgNotice(notice)
		if len(a.bg.inbox) != 0 || a.noticeDelivered("retry") {
			t.Fatal("failed task save was acknowledged or folded")
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	a.onBgNotice(notice)
	if len(a.bg.inbox) != 1 {
		t.Fatal("repaired storage did not allow delivery")
	}
	disk, err := store.loadSession(a.id)
	if err != nil {
		t.Fatal(err)
	}
	if len(disk.BgTasks) != 1 || disk.BgTasks[0].Content != "recovered output\n" || len(disk.Messages) != 1 || disk.Messages[0].Meta["background_delivery"] != "retry" {
		t.Fatalf("ack preceded durable task and transcript: %+v", disk)
	}
}

func TestRunnerOutputAndBrainCopySurviveFinishAndGC(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	b := newBGSupervisor(dataDir)
	log, brain := filepath.Join(root, "out.log"), filepath.Join(root, "brain.log")
	for _, path := range []string{log, brain} {
		if err := os.WriteFile(path, []byte(strings.Repeat("full log\n", 10000)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	b.jobs["job"] = &bgJob{ID: "job", SessionID: "session", Status: BgStatusRunning, LogPath: log, BrainLog: brain, done: make(chan struct{})}
	b.onFinish("job", BgStatusDone, "")
	delete(b.jobs, "job")
	delete(b.notices, "job")
	ended, code := time.Now().Add(-2*time.Hour).UnixMilli(), 0
	if err := runner.WriteState(root, &runner.State{JobID: "job", SessionID: "session", Status: runner.StatusDone, EndedAt: &ended, ExitCode: &code, LogPath: log, BrainPath: brain}); err != nil {
		t.Fatal(err)
	}
	b.gcRunners(time.Now().UnixMilli())
	for _, path := range []string{log, brain} {
		if data, err := os.ReadFile(path); err != nil || len(data) != 90000 {
			t.Fatalf("full log removed or truncated: %s (%d bytes, %v)", path, len(data), err)
		}
	}
}

func TestAdoptedDispositionControlsCompletionNotice(t *testing.T) {
	for _, disp := range []string{runner.DispInline, runner.DispSuppressed, runner.DispBackground} {
		t.Run(disp, func(t *testing.T) {
			b := newBGSupervisor(t.TempDir())
			if err := runner.WriteDisposition(b.rootDir(), "job", disp); err != nil {
				t.Fatal(err)
			}
			b.jobs["job"] = &bgJob{ID: "job", SessionID: "session", Runner: true, Status: BgStatusRunning, done: make(chan struct{})}
			b.onFinish("job", BgStatusDone, "")
			_, notified := b.notices["job"]
			if notified != (disp == runner.DispBackground) {
				t.Fatalf("disposition %s notified=%v", disp, notified)
			}
		})
	}
}

func TestBackgroundCommandPreservesNonzeroExitCode(t *testing.T) {
	b := testBG(t)
	inbox := make(chan Envelope, 100)
	w := &turnBridge{ctx: context.Background(), env: workerEnv{bg: b, actorID: "exit-code", inbox: inbox}}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 20 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	dir := t.TempDir()
	tool := &tools.BashTool{CWD: dir, Sandbox: tools.NewSandbox(dir), Slow: w.slowHook(), LogDir: dir}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"sleep 0.15; echo failed; exit 7"}`), nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(5 * time.Second)
	for {
		select {
		case env := <-inbox:
			if m, ok := env.Payload.(bgTaskFinishMsg); ok {
				if m.Status != BgStatusError || m.ExitCode != 7 {
					t.Fatalf("wrong command outcome: %+v", m)
				}
				return
			}
		case <-deadline:
			t.Fatal("no terminal task update")
		}
	}
}

func TestTalkCompactionSnapshotPreservesVisibleAnswer(t *testing.T) {
	agent := core.NewAgent(nil, "model", "", core.NewRegistry())
	agent.SetMessages([]provider.Message{{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "visible talk answer"}}}})
	w := &turnBridge{agent: agent, snap: workerSnapshot{options: SessionOptions{Mode: "talk"}}}
	view := w.compactionView(&core.CompactionState{}, provider.Usage{}, nil)
	msgs := sanitizeMessagesForFrontend(view.Options.Mode, view.Messages)
	if len(msgs) != 1 || extractTestText(msgs[0]) != "visible talk answer" {
		t.Fatalf("Talk answer hidden by compaction: %+v", msgs)
	}
}
