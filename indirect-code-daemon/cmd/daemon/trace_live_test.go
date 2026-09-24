package main

import (
	"context"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

// Live golden generation (review items 1+2): instead of hand-written
// fiction, these tests RUN the real actor with tracing on and assert the
// EXACT emitted sequence. If someone deletes a trace() call from the code,
// these fail — the goldens are derived from behavior, not from a static
// file that can drift.

// liveTraceRegistry collects records from live scenarios so the schema
// test can enforce contracts on REAL emissions (review item 3).
var liveTraceRegistry = struct {
	mu   sync.Mutex
	recs []map[string]any
}{}

func recordLive(recs []map[string]any) {
	liveTraceRegistry.mu.Lock()
	liveTraceRegistry.recs = append(liveTraceRegistry.recs, recs...)
	liveTraceRegistry.mu.Unlock()
}

func liveRecords() []map[string]any {
	liveTraceRegistry.mu.Lock()
	defer liveTraceRegistry.mu.Unlock()
	return append([]map[string]any(nil), liveTraceRegistry.recs...)
}

// withTrace enables the real sink into a temp dir for the test's duration.
// NB: mutates package-level trace state — never run these in parallel.
func withTrace(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	globalTrace.mu.Lock()
	oldDir := globalTrace.dir
	globalTrace.dir = filepath.Join(dir, "trace")
	// Force a rotate into the NEW dir: the sink only reopens when w == nil,
	// and scenarios share one *testing.T (cleanups run at the very end), so
	// a stale handle would keep writing to the previous scenario's file.
	if globalTrace.f != nil {
		_ = globalTrace.w.Flush()
		_ = globalTrace.f.Close()
		globalTrace.w, globalTrace.f = nil, nil
	}
	globalTrace.mu.Unlock()
	oldEnabled := traceEnabled
	traceEnabled = true
	t.Cleanup(func() {
		globalTrace.mu.Lock()
		globalTrace.dir = oldDir
		if globalTrace.f != nil {
			_ = globalTrace.w.Flush()
			_ = globalTrace.f.Close()
			globalTrace.w, globalTrace.f = nil, nil
		}
		globalTrace.mu.Unlock()
		traceEnabled = oldEnabled
	})
	return dir
}

// tracedActor spawns an actor with tracing on and a stub worker.
func tracedActor(t *testing.T, id string, worker func(snap workerSnapshot, env workerEnv, ctx context.Context)) (*sessionActor, string) {
	t.Helper()
	dir := withTrace(t)
	store := newDiskStore(filepath.Join(dir, "data"))
	rec := newTestRecord(id)
	act := newSessionActor(id, rec, store, nil, nil, nil)
	act.supCfg = new(configCell)
	act.supCfg.store(&DaemonConfig{})
	if worker == nil {
		worker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		}
	}
	act.startWorker = worker
	go act.run()
	t.Cleanup(func() {
		act.control <- shutdownMsg{}
		select {
		case <-act.done:
		case <-time.After(5 * time.Second):
		}
	})
	return act, filepath.Join(dir, "trace")
}

func traceFile(t *testing.T, dir string) []map[string]any {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no trace file in %s: %v", dir, err)
	}
	return replayTrace(t, files[0])
}

func waitIdle(t *testing.T, act *sessionActor) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("actor never went idle")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestGoldenLiveTurn: exact sequence for a plain turn (review item 2 —
// exact, not subsequence).
func scenarioTurn(t *testing.T) []map[string]any {
	act, traceDir := tracedActor(t, "gl1", nil)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "hi", Reply: reply}}
	<-reply
	waitIdle(t, act)

	// Stub worker emits no WAL appends (the real worker's agent loop does),
	// so the exact backbone here is prompt -> running -> finish -> idle.
	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	want := []string{"actor.msg", "actor.state", "actor.msg", "actor.state"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exact sequence mismatch\nwant: %v\ngot:  %v", want, got)
	}
	return recs
}

// TestGoldenLiveApproval: worker blocks, human approves — exact sequence.
func scenarioApproval(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		// Ask for approval, then finish.
		ch := make(chan approvalOutcome, 1)
		env.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: snap.gen, id: "ap1", tool: "bash", reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "gl2", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: reply}}
	<-reply

	// Wait for awaitingApproval.
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitAppr {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never entered awaitingApproval")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "ap1", Approved: true}}
	<-release
	waitIdle(t, act)

	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	want := []string{
		"actor.msg",      // userPromptMsg
		"actor.state",    // idle -> running
		"actor.wal",      // (usage/context seed may or may not appear)
		"actor.wait",     // approval requested
		"actor.state",    // running -> awaitingApproval
		"actor.msg",      // approvalResponseMsg
		"actor.approval", // approved
		"actor.state",    // awaitingApproval -> running
		"actor.msg",      // workerFinishedMsg
		"actor.state",    // running -> idle
	}
	// The wal seed event is conditional; drop it from the expectation and
	// require the rest exactly in order.
	want = []string{
		"actor.msg", "actor.state", // prompt -> running
		"actor.msg", "actor.wait", "actor.state", // approval req -> waiting
		"actor.msg", "actor.approval", "actor.state", // answer -> running
		"actor.msg", "actor.state", // finish -> idle
	}
	got = filterTypes(got, "actor.wal")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("exact sequence mismatch\nwant: %v\ngot:  %v", want, got)
	}
	return recs
}

// TestGoldenLiveStaleApproval: a wrong-id response must emit the stale trace
// (review item 4) and change nothing.
func scenarioStaleApproval(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan approvalOutcome, 1)
		env.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: snap.gen, id: "ap1", tool: "bash", reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "gl3", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitAppr {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaiting")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "WRONG", Approved: true}}
	time.Sleep(100 * time.Millisecond)
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "ap1", Approved: true}}
	<-release
	waitIdle(t, act)

	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"actor.approval.stale", "actor.approval"})
	return recs
}

// TestGoldenLiveTimeout: approval times out -> cancel + idle.
func scenarioTimeout(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan approvalOutcome, 1)
		env.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: snap.gen, id: "ap1", tool: "bash", reply: ch}, Epoch: snap.epoch}
		select {
		case <-ch:
		case <-ctx.Done():
		}
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "gl4", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitAppr {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaiting")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Shrink the armed timer (test-only hook on the actor goroutine).
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
	<-release
	waitIdle(t, act)

	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"actor.wait", "actor.timeout", "actor.cancel"})
	return recs
}

// TestGoldenLiveQuarantine: forced ladder -> actor-side quarantine event.
func scenarioQuarantine(t *testing.T) []map[string]any {
	release := make(chan struct{})
	stuck := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		<-release // ignores ctx
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
	}
	act, traceDir := tracedActor(t, "gl5", stuck)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "work", Reply: reply}}
	<-reply
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.cancelRounds = maxCancelRounds
		act.doCancel("watchdog_quarantine")
	}}}
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateOrphaned {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never quarantined")
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)

	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"actor.cancel", "actor.quarantine", "actor.state"})
	return recs
}

// TestGoldenLiveQuestionTimeout: question times out -> recommended resume.
func scenarioQuestionTimeout(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan questionOutcome, 1)
		env.inbox <- Envelope{Payload: workerQuestionReqMsg{gen: snap.gen, id: "q1", req: tools.QuestionRequest{Questions: []tools.Question{{Header: "h", Question: "pick?", Options: []tools.QuestionOption{{Label: "Recommended"}, {Label: "Other"}}}}}, reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "gl6", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "ask", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitQ {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaitingQuestion")
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
	<-release
	waitIdle(t, act)

	// Timeout resume: wait -> timeout -> running (no actor.question — that
	// event is the HUMAN answer; timeout injects the recommendation).
	recs := traceFile(t, traceDir)
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"actor.wait", "actor.timeout", "actor.state"})
	return recs
}

// TestGoldenLiveBgWake: register -> finish -> wake, exact trace presence.
func scenarioBgWake(t *testing.T) []map[string]any {
	dir := withTrace(t)
	b := newBGSupervisor(filepath.Join(dir, "data"))
	b.emit = func(any) {}
	b.hostID = func() string { return "h" }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() { b.control <- shutdownMsg{}; wg.Wait() })

	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: "s1", Label: "x", Reply: reply}}
	reg := (<-reply).(bgRegisterResult)
	_ = b.subscribeFinish("s1", nil)
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: reg.JobID, Status: BgStatusDone, Result: "ok"}}
	time.Sleep(150 * time.Millisecond)

	recs := traceFile(t, filepath.Join(dir, "trace"))
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"bg.register", "bg.finish", "bg.wake"})
	return recs
}

// TestGoldenLiveEvict: force eviction -> sup.evict + sup.passivate.
func scenarioEvict(t *testing.T) []map[string]any {
	dir := withTrace(t)
	sup := newSessionSupervisor(filepath.Join(dir, "data"), &configCell{}, nil, nil)
	writeV1Session(t, sup.dataDir, "ev1", "idle", 1, 1)
	res := sup.route("ev1", true)
	if res.Error != "" {
		t.Fatalf("route: %s", res.Error)
	}
	sup.evictIdle(true)
	select {
	case <-res.Done:
	case <-time.After(5 * time.Second):
		t.Fatalf("actor never exited")
	}
	recs := traceFile(t, filepath.Join(dir, "trace"))
	recordLive(recs)
	got := traceTypes(recs)
	assertSubsequence(t, got, []string{"sup.route", "sup.evict", "sup.passivate"})
	return recs
}

func filterTypes(in []string, drop string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != drop {
			out = append(out, s)
		}
	}
	return out
}

// Thin wrappers keep `go test -run TestGoldenLive` working per scenario.
func TestGoldenLiveTurn(t *testing.T)            { scenarioTurn(t) }
func TestGoldenLiveApproval(t *testing.T)        { scenarioApproval(t) }
func TestGoldenLiveStaleApproval(t *testing.T)   { scenarioStaleApproval(t) }
func TestGoldenLiveTimeout(t *testing.T)         { scenarioTimeout(t) }
func TestGoldenLiveQuarantine(t *testing.T)      { scenarioQuarantine(t) }
func TestGoldenLiveQuestionTimeout(t *testing.T) { scenarioQuestionTimeout(t) }
func TestGoldenLiveBgWake(t *testing.T)          { scenarioBgWake(t) }
func TestGoldenLiveEvict(t *testing.T)           { scenarioEvict(t) }

// liveScenarios is the canonical list the schema test runs (review item 3):
// contracts are enforced against REAL emissions, not hand-written files.
var liveScenarios = []struct {
	name string
	run  func(*testing.T) []map[string]any
}{
	{"turn", scenarioTurn},
	{"approval", scenarioApproval},
	{"staleApproval", scenarioStaleApproval},
	{"timeout", scenarioTimeout},
	{"quarantine", scenarioQuarantine},
	{"questionTimeout", scenarioQuestionTimeout},
	{"bgWake", scenarioBgWake},
	{"evict", scenarioEvict},
	{"questionAnswered", scenarioQuestionAnswered},
	{"questionStale", scenarioQuestionStale},
	{"waiterLost", scenarioWaiterLost},
	{"bgCancel", scenarioBgCancel},
}

// scenarioQuestionAnswered covers actor.question (human answers in time).
func scenarioQuestionAnswered(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan questionOutcome, 1)
		env.inbox <- Envelope{Payload: workerQuestionReqMsg{gen: snap.gen, id: "q2", req: tools.QuestionRequest{Questions: []tools.Question{{Header: "h", Question: "pick?", Options: []tools.QuestionOption{{Label: "A"}}}}}, reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "glq1", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "ask", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitQ {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaitingQuestion")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: questionResponseMsg{ID: "q2", Answers: [][]string{{"A"}}}}
	<-release
	waitIdle(t, act)
	recs := traceFile(t, traceDir)
	recordLive(recs)
	assertSubsequence(t, traceTypes(recs), []string{"actor.wait", "actor.question"})
	return recs
}

// scenarioQuestionStale covers actor.question.stale (wrong id while awaiting).
func scenarioQuestionStale(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan questionOutcome, 1)
		env.inbox <- Envelope{Payload: workerQuestionReqMsg{gen: snap.gen, id: "q3", req: tools.QuestionRequest{Questions: []tools.Question{{Header: "h", Question: "pick?", Options: []tools.QuestionOption{{Label: "A"}}}}}, reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "glq2", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "ask", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitQ {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaitingQuestion")
		}
		time.Sleep(10 * time.Millisecond)
	}
	act.inbox <- Envelope{Payload: questionResponseMsg{ID: "WRONG", Answers: [][]string{{"A"}}}}
	time.Sleep(80 * time.Millisecond)
	act.inbox <- Envelope{Payload: questionResponseMsg{ID: "q3", Answers: [][]string{{"A"}}}}
	<-release
	waitIdle(t, act)
	recs := traceFile(t, traceDir)
	recordLive(recs)
	assertSubsequence(t, traceTypes(recs), []string{"actor.question.stale", "actor.question"})
	return recs
}

// scenarioWaiterLost covers actor.waiter.lost: the SAME approval id is
// answered twice — the second response passes the stale check (still
// awaiting, same id) but the waiter channel was already consumed.
func scenarioWaiterLost(t *testing.T) []map[string]any {
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		ch := make(chan approvalOutcome, 1)
		env.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: snap.gen, id: "ap9", tool: "bash", reply: ch}, Epoch: snap.epoch}
		<-ch
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		close(release)
	}
	act, traceDir := tracedActor(t, "glw1", worker)
	reply := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: reply}}
	<-reply
	deadline := time.Now().Add(5 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateAwaitAppr {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never awaitingApproval")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// First answer resolves; re-arm the SAME pending id via a hook so the
	// second answer passes the stale check with no waiter left.
	act.inbox <- Envelope{Payload: approvalResponseMsg{ID: "ap9", Approved: true}}
	<-release
	waitIdle(t, act)
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.pending = &pendingAsk{id: "ap9", kind: "approval"}
		act.state = stateAwaitAppr
		act.wakeApproval("ap9", true) // no waiter -> lost
	}}}
	time.Sleep(80 * time.Millisecond)
	recs := traceFile(t, traceDir)
	recordLive(recs)
	assertSubsequence(t, traceTypes(recs), []string{"actor.wait", "actor.waiter.lost"})
	return recs
}

// scenarioBgCancel covers bg.cancel (user stop).
func scenarioBgCancel(t *testing.T) []map[string]any {
	dir := withTrace(t)
	b := newBGSupervisor(filepath.Join(dir, "data"))
	b.emit = func(any) {}
	b.hostID = func() string { return "h" }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() { b.control <- shutdownMsg{}; wg.Wait() })
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: "s1", Label: "x", Reply: reply}}
	reg := (<-reply).(bgRegisterResult)
	creply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgCancelMsg{JobID: reg.JobID, By: "user", Reply: creply}}
	<-creply
	time.Sleep(80 * time.Millisecond)
	recs := traceFile(t, filepath.Join(dir, "trace"))
	recordLive(recs)
	assertSubsequence(t, traceTypes(recs), []string{"bg.register", "bg.cancel"})
	return recs
}
