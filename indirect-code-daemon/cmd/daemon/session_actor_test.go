package main

import (
	"context"
	"testing"
	"time"
)

func newTestActor(t *testing.T, rec *SessionRecord, worker func(*sessionActor, context.Context, int, string, map[string]string)) (*sessionActor, *diskStore, chan any, func()) {
	t.Helper()
	dir := t.TempDir()
	store := newDiskStore(dir)
	wsCh := make(chan any, 64)
	var events []string
	act := newSessionActor(rec.ID, rec, store, func(ev any) { wsCh <- ev }, nil, func(c string) { events = append(events, c) })
	if worker == nil {
		worker = func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		}
	}
	act.startWorker = worker
	go act.run()
	return act, store, wsCh, func() { act.control <- shutdownMsg{}; <-act.done }
}

func newTestRecord(id string) *SessionRecord {
	return &SessionRecord{ID: id, CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
}

func TestPromptStartsTurn(t *testing.T) {
	act, _, _, stop := newTestActor(t, newTestRecord("s1"), nil)
	defer stop()
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "hi", Reply: reply}}
	res := (<-reply).(promptResult)
	if !res.Accepted || res.Queued {
		t.Fatalf("want accepted non-queued, got %+v", res)
	}
	// Worker stub finishes async; poll state via watchdog ping.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		rep := (<-repCh).(watchdogReport)
		if rep.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("turn did not finish, state=%s", rep.State)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestPromptQueuesWhileRunning(t *testing.T) {
	// Block the worker so the turn stays running.
	release := make(chan struct{})
	blockingWorker := func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	act, _, _, stop := newTestActor(t, newTestRecord("s2"), blockingWorker)
	defer stop()
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "first", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("first not accepted: %+v", res)
	}
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "second", Reply: r2}}
	res := (<-r2).(promptResult)
	if !res.Accepted || !res.Queued {
		t.Fatalf("want queued, got %+v", res)
	}
	close(release)
	// After first finishes, queued head promotes: the actor starts a second
	// turn (TurnSeq advances, queue drains). Message seeding is the worker's
	// job (agent.PromptWithMeta) — the blocking stub appends nothing.
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh2 := make(chan any, 1)
		act.inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: repCh2}}
		rr2 := (<-repCh2).(readResult)
		if rec, ok := rr2.Payload.(*SessionRecord); ok && rec.TurnSeq == 2 && len(rec.Queue) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued head did not promote")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestStaleWorkerIgnored(t *testing.T) {
	act, _, _, stop := newTestActor(t, newTestRecord("s3"), nil)
	defer stop()
	act.inbox <- Envelope{Payload: workerFinishedMsg{gen: 999}}
	repCh := make(chan any, 1)
	act.control <- watchdogPingMsg{Reply: repCh}
	if rep := (<-repCh).(watchdogReport); rep.State != stateIdle {
		t.Fatalf("stale worker changed state to %s", rep.State)
	}
}

func TestBgNoticeIdleStartsWakeupTurn(t *testing.T) {
	release := make(chan struct{})
	blocking := func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	metaCh := make(chan map[string]string, 1)
	capturing := func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case metaCh <- meta:
		default:
		}
		blocking(a, ctx, gen, prompt, meta)
	}
	act, _, _, stop := newTestActor(t, newTestRecord("wake1"), capturing)
	defer stop()
	act.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "bg_1", Text: "job done", Finished: true}}
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("wake-up turn never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The wake-up worker must receive background_delivery meta (it seeds
	// the user message via agent.PromptWithMeta — the actor no longer seeds).
	select {
	case gotMeta := <-metaCh:
		if gotMeta["background_delivery"] != "bg_1" {
			t.Fatalf("missing background_delivery meta: %+v", gotMeta)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("wake-up worker never started")
	}
	close(release)
}

func TestBgNoticeRunningFoldsLateResult(t *testing.T) {
	release := make(chan struct{})
	blocking := func(a *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
		select {
		case <-release:
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen}}
		case <-ctx.Done():
			a.inbox <- Envelope{Payload: workerFinishedMsg{gen: gen, cancelled: true}}
		}
	}
	act, _, _, stop := newTestActor(t, newTestRecord("wake2"), blocking)
	defer stop()
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "work", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("not accepted")
	}
	act.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "bg_2", Text: "job done", Finished: true}}
	time.Sleep(100 * time.Millisecond)
	rr := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}
	got := (<-rr).(readResult)
	rec := got.Payload.(*SessionRecord)
	found := false
	for _, m := range rec.Messages {
		if m.Meta["background_delivery"] == "bg_2" {
			found = true
		}
	}
	if !found {
		t.Fatalf("late result not folded")
	}
	if rec.TurnSeq != 1 {
		t.Fatalf("wake-up turn wrongly started while running: seq=%d", rec.TurnSeq)
	}
	close(release)
}

func TestConvertRoundTrip(t *testing.T) {
	dir := t.TempDir()
	store := newDiskStore(dir)
	rec := &SessionRecord{ID: "cv1", CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
	act := newSessionActor("cv1", rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{GatewayURL: "http://127.0.0.1:1", HostID: "h"})
	var emitted []map[string]any
	act.wsSend = func(ev any) {
		if m, ok := ev.(map[string]any); ok {
			emitted = append(emitted, m)
		}
	}
	act.convertServer = func(msg map[string]any) {
		emitted = append(emitted, msg)
		// Simulate browser answering.
		act.inbox <- Envelope{Payload: convertResponseMsg{id: msg["requestId"].(string), text: "# converted"}}
	}
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
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "read file", Reply: reply}}
	if res := (<-reply).(promptResult); !res.Accepted {
		t.Fatalf("not accepted")
	}
	env := workerEnv{cfg: act.supCfg, store: store, emit: func(any) {}, inbox: act.inbox, actorID: "cv1",
		hostID: func() string { return "h" }, brainDir: func(string) string { return "" }}
	snap := workerSnapshot{gen: 1, turnIndex: 1, model: "m", options: SessionOptions{Mode: "build", Access: "ask", Effort: "none"}}
	w := &turnBridge{env: env, snap: snap, cfg: *env.cfg.load(), ctx: context.Background()}
	text, err := w.requestConvert(context.Background(), "doc.pdf", "ZG9j")
	if err != nil {
		t.Fatalf("convert err: %v", err)
	}
	if text != "# converted" {
		t.Fatalf("want converted, got %q", text)
	}
	// convert_resolved emitted.
	found := false
	for _, m := range emitted {
		if m["type"] == "convert_resolved" {
			found = true
		}
	}
	if !found {
		t.Fatalf("no convert_resolved emitted")
	}
	close(release)
}
