package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Tests in this file drive the worker<->actor bridge WITHOUT network: the
// worker hooks (approveTool, askQuestions, updateTodos, onMessageAppended)
// talk to a live session actor, and assertions observe actor state + WAL.

// bridgeFixture spawns a session actor with the REAL defaultStartWorker
// replaced by a hook-only driver: tests call bridge methods directly.



func TestWorkerApprovalViaActor(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	rec := &SessionRecord{ID: "w2", CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
	act := newSessionActor("w2", rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{GatewayURL: "http://127.0.0.1:1", HostID: "h"})
	release := make(chan struct{})
	act.startWorker = func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "do thing", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("not accepted: %+v", res)
	}
	// Build a bridge bound to this actor + gen 1.
	env := workerEnv{
		cfg: act.supCfg, store: store, emit: func(any) {}, inbox: act.inbox,
		actorID: "w2",
		hostID:  func() string { return "h" },
		brainDir: func(string) string { return "" },
	}
	snap := workerSnapshot{gen: 1, turnIndex: 1, model: "m", options: SessionOptions{Mode: "build", Access: "ask", Effort: "none"}}
	w := &turnBridge{env: env, snap: snap, cfg: *env.cfg.load(), ctx: context.Background()}

	// approveTool blocks until the actor routes the human answer.
	type outcome struct {
		ok     bool
		reason string
	}
	done := make(chan outcome, 1)
	go func() {
		ok, reason, _ := w.approveTool(provider.ToolCallBlock{ID: "c1", Name: "bash", Arguments: json.RawMessage(`{}`)})
		done <- outcome{ok, reason}
	}()
	// Actor should now be awaitingApproval; answer approve.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitAppr {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("actor never entered awaitingApproval")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "?", Approved: true}} // stale: wrong id
	select {
	case <-done:
		t.Fatalf("stale approval woke the worker")
	case <-time.After(100 * time.Millisecond):
	}
	// Find the real pending id via hook (channel: hook runs on the actor
	// goroutine, so a plain var is a data race).
	pendingCh := make(chan string, 1)
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		if act.pending != nil {
			pendingCh <- act.pending.id
		} else {
			pendingCh <- ""
		}
	}}}
	var pendingID string
	select {
	case pendingID = <-pendingCh:
	case <-time.After(3 * time.Second):
		t.Fatalf("hook never ran")
	}
	if pendingID == "" {
		t.Fatalf("no pending approval")
	}
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: pendingID, Approved: true}}
	select {
	case out := <-done:
		if !out.ok {
			t.Fatalf("want approved, reason=%s", out.reason)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("worker never woke")
	}
	close(release)
}

func TestWorkerQuestionTimeoutResumesRecommended(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	rec := &SessionRecord{ID: "w3", CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
	act := newSessionActor("w3", rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{GatewayURL: "http://127.0.0.1:1", HostID: "h"})
	release := make(chan struct{})
	act.startWorker = func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "ask me", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("not accepted")
	}
	env := workerEnv{cfg: act.supCfg, store: store, emit: func(any) {}, inbox: act.inbox, actorID: "w3",
		hostID: func() string { return "h" }, brainDir: func(string) string { return "" }}
	snap := workerSnapshot{gen: 1, turnIndex: 1, model: "m", options: SessionOptions{Mode: "build", Access: "ask", Effort: "none"}}
	w := &turnBridge{env: env, snap: snap, cfg: *env.cfg.load(), ctx: context.Background()}

	type qout struct {
		answers [][]string
		err     error
	}
	done := make(chan qout, 1)
	req := tools.QuestionRequest{Questions: []tools.Question{{Header: "h", Question: "pick?", Options: []tools.QuestionOption{{Label: "Recommended"}, {Label: "Other"}}}}}
	go func() {
		answers, err := w.askQuestions(context.Background(), req)
		done <- qout{answers, err}
	}()
	// Wait for awaitingQuestion, then shrink the timer to fire fast.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitQ {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never entered awaitingQuestion")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		if act.pending != nil && act.pending.timer != nil {
			id := act.pending.id
			act.pending.timer.Stop()
			act.pending.timer = time.AfterFunc(30*time.Millisecond, func() {
				select {
				case act.inbox <- Envelope{Payload: stateTimeoutMsg{ID: id}}:
				default:
					select {
					case act.control <- stateTimeoutMsg{ID: id}:
					default:
					}
				}
			})
		}
	}}}
	select {
	case out := <-done:
		if out.err != nil {
			t.Fatalf("question err: %v", out.err)
		}
		if len(out.answers) != 1 || len(out.answers[0]) != 1 || out.answers[0][0] != "Recommended" {
			t.Fatalf("want recommended, got %+v", out.answers)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("question never resolved by timeout")
	}
	close(release)
}

func TestWorkerTodoAndMessageAppend(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	rec := &SessionRecord{ID: "w4", CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
	act := newSessionActor("w4", rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{GatewayURL: "http://127.0.0.1:1", HostID: "h"})
	release := make(chan struct{})
	act.startWorker = func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "hi", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("not accepted")
	}
	// Turn is running (worker blocked): todos append applies.
	act.inbox <- Envelope{Payload: walAppendMsg{ev: walEvent{Type: walTypeTodos, Todos: []tools.TodoItem{{ID: "1", Text: "x", Status: "done"}}}}}
	rr := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}
	got := (<-rr).(readResult)
	if rec := got.Payload.(*SessionRecord); len(rec.Todos) != 1 {
		t.Fatalf("want 1 todo, got %+v", rec.Todos)
	}
	close(release)
	// After finish the turn commits; todos survive the commit.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
	rr2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr2}}
	got2 := (<-rr2).(readResult)
	if rec := got2.Payload.(*SessionRecord); len(rec.Todos) != 1 {
		t.Fatalf("todos lost across commit: %+v", rec.Todos)
	}
}
