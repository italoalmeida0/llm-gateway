package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Run an actual tool in a disposable daemon process, then exit without
// running any deferred cleanup. The child must keep its inherited log open.
func TestBackgroundCrashHelper(t *testing.T) {
	dir := os.Getenv("HARDENING_CRASH_DIR")
	if dir == "" {
		return
	}
	b := newBGSupervisor(dir)
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	w := &turnBridge{ctx: context.Background(), env: workerEnv{bg: b, actorID: "crash-session", inbox: make(chan Envelope, 8)}}
	tools.AutoBackgroundAfter = 20 * time.Millisecond
	logDir := filepath.Join(dir, "brain")
	var err error
	if os.Getenv("HARDENING_CRASH_KIND") == "python" {
		tool := &tools.PythonTool{CWD: dir, Sandbox: tools.NewSandbox(dir), Slow: w.slowHook(), LogDir: logDir}
		_, err = tool.Execute(context.Background(), json.RawMessage(`{"code":"import time,sys\nfor i in range(300):\n print('alive', flush=True)\n print('stderr-alive', file=sys.stderr, flush=True)\n time.sleep(.1)"}`), nil)
	} else {
		tool := &tools.BashTool{CWD: dir, Sandbox: tools.NewSandbox(dir), Slow: w.slowHook(), LogDir: logDir}
		_, err = tool.Execute(context.Background(), json.RawMessage(`{"command":"while true; do echo alive; sleep .1; done"}`), nil)
	}
	if err != nil {
		t.Fatal(err)
	}
	os.Exit(23)
}

func TestBackgroundSurvivesDaemonExitAndCanBeStopped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX crash fixture")
	}
	for _, kind := range []string{"bash", "python"} {
		t.Run(kind, func(t *testing.T) {
			if kind == "python" {
				if _, err := tools.PythonAvailable(); err != nil {
					t.Skip(err)
				}
			}
			dir := t.TempDir()
			cmd := exec.Command(os.Args[0], "-test.run=^TestBackgroundCrashHelper$")
			cmd.Env = append(os.Environ(), "HARDENING_CRASH_DIR="+dir, "HARDENING_CRASH_KIND="+kind)
			out, err := cmd.CombinedOutput()
			if e, ok := err.(*exec.ExitError); !ok || e.ExitCode() != 23 {
				t.Fatalf("helper: %v\n%s", err, out)
			}
			paths, _ := filepath.Glob(filepath.Join(dir, "bg", "*.pid.json"))
			if len(paths) != 1 {
				t.Fatalf("pidfiles: %v", paths)
			}
			data, err := os.ReadFile(paths[0])
			if err != nil {
				t.Fatal(err)
			}
			var pf bgPidfile
			if err := json.Unmarshal(data, &pf); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { tools.StopRecoveredProcess(pf.PID, pf.Identity) })
			before, err := os.Stat(pf.LogPath)
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				after, err := os.Stat(pf.LogPath)
				if err == nil && after.Size() > before.Size() {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("output stopped when daemon exited")
				}
				time.Sleep(20 * time.Millisecond)
			}
			if kind == "python" {
				data, err := os.ReadFile(pf.StderrPath)
				if err != nil || !strings.Contains(string(data), "stderr-alive") {
					t.Fatalf("stderr not preserved: %v", err)
				}
			}
			// A different identity must never authorize signalling this PID.
			if tools.StopRecoveredProcess(pf.PID, "wrong-identity") {
				t.Fatal("accepted reused PID identity")
			}
			b := newBGSupervisor(dir)
			b.readopt()
			j := b.jobs[pf.JobID]
			if j == nil || j.Status != BgStatusRunning || j.stop == nil {
				t.Fatal("live child was not safely re-adopted")
			}
			if !b.onCancel(pf.JobID, "user") {
				t.Fatal("cancel failed")
			}
			deadline = time.Now().Add(3 * time.Second)
			for tools.ProcessIdentity(pf.PID) == pf.Identity {
				if time.Now().After(deadline) {
					t.Fatal("re-adopted process survived cancellation")
				}
				time.Sleep(20 * time.Millisecond)
			}
		})
	}
}

func TestPendingApprovalRechecksModeAndQuestionValidatesAnswers(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options = SessionOptions{Mode: "build", Access: "ask"}
	approval := make(chan approvalOutcome, 1)
	a.onWorkerApprovalReq(workerApprovalReqMsg{gen: 1, id: "write", callID: "write", tool: "write", reply: approval})
	a.rec.Options.Mode = "talk"
	a.onApprovalResponse(approvalResponseMsg{ID: "write", Approved: true})
	if (<-approval).approved {
		t.Fatal("approved a tool disallowed by the current mode")
	}
	answer := make(chan questionOutcome, 1)
	a.onWorkerQuestionReq(workerQuestionReqMsg{gen: 1, id: "question", req: tools.QuestionRequest{Questions: []tools.Question{{Header: "Choice", Question: "Choose", Options: []tools.QuestionOption{{Label: "A"}}}}}, reply: answer})
	a.onQuestionResponse(questionResponseMsg{ID: "question", Answers: nil})
	if a.state != stateAwaitQ || len(answer) != 0 {
		t.Fatal("invalid answer consumed the pending question")
	}
	a.onQuestionResponse(questionResponseMsg{ID: "question", Answers: [][]string{{"A"}}})
	if got := <-answer; len(got.answers) != 1 {
		t.Fatal("valid answer not delivered")
	}
}

func TestFailedCommitRecoversWithoutLosingTranscript(t *testing.T) {
	a := reviewActor(t)
	base, _ := os.ReadFile(a.store.sessionFile(a.id))
	a.gen, a.rec.TurnSeq, a.state = 1, 1, stateRunning
	w, err := a.store.openWAL(a.id, &walHeader{TurnIndex: 1, Prompt: "keep me"})
	if err != nil {
		t.Fatal(err)
	}
	a.wal = w
	a.onWALAppend(walAppendMsg{gen: 1, ev: walMsgEvent(provider.Message{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "keep me"}}})})
	if err := os.WriteFile(a.store.sessionFile(a.id), []byte("invalid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.finishTurn(false)
	if a.state != statePersist || a.wal == nil {
		t.Fatal("lost recovery barrier")
	}
	if err := os.WriteFile(a.store.sessionFile(a.id), base, 0o600); err != nil {
		t.Fatal(err)
	}
	a.finishTurn(false)
	if a.state != stateIdle || a.persistErr != nil {
		t.Fatal("commit could not recover")
	}
	rec, _, err := a.store.loadSessionFused(a.id)
	if err != nil || len(rec.Messages) != 1 {
		t.Fatalf("recovered transcript: %v", err)
	}
}

func TestShutdownDrainsCancelledWorkerTranscript(t *testing.T) {
	a := reviewActor(t)
	a.startWorker = func(s workerSnapshot, env workerEnv, ctx context.Context) {
		<-ctx.Done()
		w := &turnBridge{snap: s, env: env, ctx: ctx}
		w.sendInbox(walAppendMsg{ev: walMsgEvent(provider.Message{Role: provider.RoleAssistant, TurnIndex: s.turnIndex, Content: []provider.Content{provider.TextBlock{Text: "partial text"}}})})
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: s.gen, cancelled: true}}
	}
	if err := a.startTurn("work", nil, "m", false, nil); err != nil {
		t.Fatal(err)
	}
	go a.run()
	a.control <- shutdownMsg{}
	reviewRecv(t, a.done)
	rec, _, err := a.store.loadSessionFused(a.id)
	if err != nil || len(rec.Messages) != 1 {
		t.Fatalf("shutdown discarded partial transcript: %v", err)
	}
}

func TestReadSnapshotDoesNotShareMutableState(t *testing.T) {
	a := reviewActor(t)
	a.rec.Turn = &TurnActivity{Status: "running"}
	a.rec.Messages = []provider.Message{{Meta: map[string]string{"x": "original"}, Content: []provider.Content{provider.ToolCallBlock{Arguments: json.RawMessage(`{"x":1}`)}}}}
	r := make(chan any, 1)
	a.onRead(readReqMsg{What: "session", Reply: r})
	snapshot := (<-r).(readResult).Payload.(*SessionRecord)
	snapshot.Turn.Status = "mutated"
	snapshot.Messages[0].Meta["x"] = "mutated"
	snapshot.Messages[0].Content[0].(provider.ToolCallBlock).Arguments[0] = '['
	if a.rec.Turn.Status != "running" || a.rec.Messages[0].Meta["x"] != "original" || a.rec.Messages[0].Content[0].(provider.ToolCallBlock).Arguments[0] != '{' {
		t.Fatal("snapshot aliases the actor's mutable state")
	}
}

func TestHeaderOnlyRecoveryKeepsOpeningPromptAndMetadata(t *testing.T) {
	rec := newTestRecord("resume")
	rec.Messages = []provider.Message{{TurnIndex: 1, Role: provider.RoleUser}}
	header := &walHeader{TurnIndex: 2, Prompt: "new prompt", PromptMeta: map[string]string{"background_delivery": "job"}, AttachmentIDs: []string{"attachment"}}
	snap := newResumeSnapshot(rec, header)
	if snap.resume || snap.prompt != "new prompt" || snap.promptMeta["background_delivery"] != "job" || len(snap.attachIDs) != 1 {
		t.Fatal("header-only crash loses its opening prompt")
	}
	rec.Messages = append(rec.Messages, provider.Message{TurnIndex: 2, Role: provider.RoleUser})
	if !newResumeSnapshot(rec, header).resume {
		t.Fatal("recovery would append the opening prompt twice")
	}
}

func TestBackgroundCompletionOutlivesOriginatingTurn(t *testing.T) {
	b := testBG(t)
	ctx, cancel := context.WithCancel(context.Background())
	w := &turnBridge{ctx: ctx, env: workerEnv{bg: b, actorID: "origin"}}
	id, _, _, finish := w.slowHook()("bash", "completed", tools.BackgroundProcess{})
	cancel()
	finish("done", false)
	rows := bgList(t, b)
	if len(rows) != 1 || rows[0]["id"] != id || rows[0]["status"] != BgStatusDone { t.Fatalf("cancelled turn swallowed background completion: %v", rows) }
}

func TestResolvedApprovalDeadlineDoesNotSurviveReplay(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options.Access = "ask"
	w, err := a.store.openWAL(a.id, &walHeader{TurnIndex: 1, Prompt: "work"}); if err != nil { t.Fatal(err) }
	a.wal = w; defer w.close()
	a.onWorkerApprovalReq(workerApprovalReqMsg{gen: 1, id: "call", tool: "bash", reply: make(chan approvalOutcome, 1)})
	a.onApprovalResponse(approvalResponseMsg{ID: "call", Approved: true})
	rec, _, err := a.store.loadSessionFused(a.id)
	if err != nil || rec.ApprovalDeadlineUnix != 0 { t.Fatalf("answered approval still has a recovery deadline: %v", err) }
}

func TestPurgeColdSessionNeverResumesAndRejectsFutureRoutes(t *testing.T) {
	cfg := &configCell{}
	cfg.store(&DaemonConfig{})
	s := newSessionSupervisor(t.TempDir(), cfg, nil, nil)
	rec := newTestRecord("deleted")
	if err := s.disk().saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	w, err := s.disk().openWAL(rec.ID, &walHeader{TurnIndex: 1, Prompt: "must not run"})
	if err != nil {
		t.Fatal(err)
	}
	_ = w.close()
	if err := s.purge(rec.ID); err != nil {
		t.Fatal(err)
	}
	if r := s.route(rec.ID, false); r.Error == "" {
		t.Fatal("deleted session returned a live handle")
	}
	if _, err := os.Stat(s.disk().walPath(rec.ID)); !os.IsNotExist(err) {
		t.Fatalf("WAL survived purge: %v", err)
	}
}
