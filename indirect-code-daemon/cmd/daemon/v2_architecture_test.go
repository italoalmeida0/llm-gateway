package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
)

// V2-001: the watchdog must not cancel legitimate waits. A worker inside a
// DECLARED blocking operation (provider request incl. retry backoff,
// foreground tool execution) is expected to be silent — the operation's own
// deadline bounds it, and cancellation stays responsive throughout.

// TestV2WatchdogSparesHealthyDelayedProvider is the promoted review probe
// (docs/review-probes): a healthy provider that needs longer than the
// watchdog's stale threshold to produce its first byte must complete when
// the watchdog is active, exactly as it does without one.
func TestV2WatchdogSparesHealthyDelayedProvider(t *testing.T) {
	previous := tuneWatchEvery
	tuneWatchEvery = 50 * time.Millisecond
	defer func() { tuneWatchEvery = previous }()
	for _, watchdog := range []bool{false, true} {
		name := "without_watchdog"
		if watchdog {
			name = "with_watchdog"
		}
		t.Run(name, func(t *testing.T) {
			started := make(chan struct{})
			finished := make(chan bool, 1)
			srv := reviewGateway(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.(http.Flusher).Flush()
				close(started)
				select {
				case <-r.Context().Done():
					finished <- false
				case <-time.After(450 * time.Millisecond):
					reviewTextSSE(w)
					finished <- true
				}
			})
			a := reviewActor(t)
			a.supCfg.store(&DaemonConfig{HostID: "h", GatewayURL: srv.URL, Settings: HarnessSettings{NoAutoTitle: true}})
			a.rec.Options = SessionOptions{Access: "full", Mode: "talk", Effort: "none"}
			sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
			sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
			go a.run()
			defer func() { a.control <- shutdownMsg{}; <-a.done }()
			reply := make(chan any, 1)
			a.inbox <- Envelope{Payload: userPromptMsg{Text: "Respond when ready", Reply: reply}}
			if result := reviewRecv(t, reply).(promptResult); !result.Accepted {
				t.Fatal(result)
			}
			reviewRecv(t, started)
			time.Sleep(150 * time.Millisecond)
			if watchdog {
				sup.watchdogRound()
			}
			if !reviewRecv(t, finished) {
				t.Error("watchdog cancelled a healthy HTTP request while the provider was still preparing its response")
			}
		})
	}
}

// TestV2WatchdogHonorsDeclaredWaitDeadline: a declared wait silences the
// progress rule only while it is live. Past its OWN deadline the normal
// stale rule applies again and the F3 escalation ladder still reaches
// quarantine for a worker that ignores cancellation (indefinite stalls
// remain detectable).
func TestV2WatchdogHonorsDeclaredWaitDeadline(t *testing.T) {
	a := reviewActor(t)
	a.state = stateRunning
	a.workerDone = make(chan struct{}) // worker deliberately ignores cancellation
	a.lastProgress = time.Now().Add(-time.Hour).UnixMilli()
	a.cancel = func() {}
	a.waitOp, a.waitUntil = "provider", time.Now().Add(300*time.Millisecond).UnixMilli()
	s := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	s.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()

	// While the declared wait is live, rounds pass without escalation.
	s.watchdogRound()
	s.watchdogRound()
	if r := s.ping(a.id); r.State != stateRunning {
		t.Fatalf("declared wait ignored: state %s", r.State)
	}
	if r := s.ping(a.id); r.WaitOp != "provider" || r.WaitUntil == 0 {
		t.Fatalf("report lost the declared wait: %+v", r)
	}

	// Past the deadline the stale rule is active again: escalation
	// reaches quarantine (the worker ignores cancellation).
	time.Sleep(350 * time.Millisecond)
	for i := 0; i < maxCancelRounds+2; i++ {
		s.watchdogRound()
	}
	if r := s.ping(a.id); r.State != stateOrphaned {
		t.Fatalf("stall after wait deadline must escalate to orphaned, got %s", r.State)
	}
}

// TestV2ToolEventsDeclareAndClearWait locks the worker-side wiring: a
// foreground tool execution declares a bounded wait and its result clears
// it (this is what keeps a permitted `sleep` alive across watchdog
// intervals while staying user-cancellable).
func TestV2ToolEventsDeclareAndClearWait(t *testing.T) {
	inbox := make(chan Envelope, 8)
	w := &turnBridge{
		env:  workerEnv{cfg: &configCell{}, inbox: inbox},
		snap: workerSnapshot{gen: 7},
		cfg:  DaemonConfig{HostID: "h"},
		live: &liveTracker{},
	}
	drain := func() []workerWaitMsg {
		var waits []workerWaitMsg
		for len(inbox) > 0 {
			if wm, ok := (<-inbox).Payload.(workerWaitMsg); ok {
				waits = append(waits, wm)
			}
		}
		return waits
	}

	w.handleEvent(core.EvToolExecutionStart{ID: "t1", StartedAt: 1})
	waits := drain()
	if len(waits) != 1 {
		t.Fatalf("tool start must declare one wait, got %+v", waits)
	}
	if waits[0].op != "tool" || waits[0].until <= time.Now().UnixMilli() {
		t.Fatalf("tool wait not bounded correctly: %+v", waits[0])
	}
	if waits[0].gen != 7 {
		t.Fatalf("wait must be stamped with the turn generation: %+v", waits[0])
	}

	w.handleEvent(core.EvToolResult{ID: "t1"})
	waits = drain()
	if len(waits) != 1 || waits[0].until != 0 {
		t.Fatalf("tool result must clear the wait, got %+v", waits)
	}
}

// v2SnapshotWorld wires an actor + ws + server the way the reconnect
// probes do, and returns the event stream plus a get_session helper.
func v2SnapshotWorld(t *testing.T, a *sessionActor) (<-chan any, func() map[string]any) {
	t.Helper()
	ws := newWSActor()
	a.wsSend = func(ev any) { ws.emit(ev) }
	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	go a.run()
	t.Cleanup(func() { a.control <- shutdownMsg{}; <-a.done })
	return ws.outbound, func() map[string]any {
		raw, _ := json.Marshal(map[string]any{"type": "get_session", "sessionId": a.id})
		server.dispatch(raw)
		resp := reviewRecv(t, ws.outbound).(map[string]any)
		if resp["type"] != "session_data" {
			t.Fatalf("get_session: %+v", resp)
		}
		return resp["session"].(map[string]any)
	}
}

// V2-004: a reload/reopen during an outstanding approval restores the
// ORIGINAL request (correlation id, tool, args, deadline) so answering it
// resumes the worker exactly once.
func TestV2SnapshotRestoresPendingApproval(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	a.rec.Options = SessionOptions{Access: "ask", Mode: "build"}
	events, snapshot := v2SnapshotWorld(t, a)

	reply := make(chan approvalOutcome, 1)
	a.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: 1, id: "appr1", callID: "appr1", tool: "bash", args: json.RawMessage(`{"cmd":"ls"}`), reply: reply}}
	if initial := reviewRecv(t, events).(map[string]any); initial["type"] != "tool_approval_request" {
		t.Fatal(initial)
	}

	payload := snapshot()
	pa, ok := payload["pendingApproval"].(map[string]any)
	if !ok {
		t.Fatal("reconnected browser receives no pendingApproval although the actor is waiting for that decision")
	}
	if pa["callId"] != "appr1" || pa["tool"] != "bash" {
		t.Fatalf("approval identity lost: %+v", pa)
	}
	if !strings.Contains(string(pa["args"].(json.RawMessage)), "ls") {
		t.Fatalf("approval args lost: %+v", pa["args"])
	}
	firstDeadline := fmt.Sprint(pa["deadline"])
	if firstDeadline == "0" || firstDeadline == "" {
		t.Fatalf("approval deadline lost: %+v", pa)
	}

	// Reconnect again BEFORE answering: same deadline (never extended).
	if again := fmt.Sprint(snapshot()["pendingApproval"].(map[string]any)["deadline"]); again != firstDeadline {
		t.Fatalf("deadline drifted across reconnects: %s -> %s", firstDeadline, again)
	}

	// Answer once: the worker resumes with exactly one outcome.
	a.inbox <- Envelope{Payload: approvalResponseMsg{ID: "appr1", Approved: true}}
	if out := reviewRecv(t, reply); !out.approved {
		t.Fatalf("worker not resumed: %+v", out)
	}
	reviewRecv(t, events) // the resolution event precedes the next snapshot
	// A second client answering the same request must not apply twice.
	a.inbox <- Envelope{Payload: approvalResponseMsg{ID: "appr1", Approved: false}}
	seqDone := make(chan struct{})
	a.inbox <- Envelope{Payload: hookMsg{fn: func() { close(seqDone) }}}
	<-seqDone
	if len(reply) != 0 {
		t.Fatal("second answer applied twice")
	}
	// Resolved requests are not revived by snapshots.
	if snapshot()["pendingApproval"] != nil {
		t.Fatal("resolved approval revived in snapshot")
	}
}

// V2-004 (question equivalent of the approval probe).
func TestV2SnapshotRestoresPendingQuestion(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	a.rec.Options = SessionOptions{Access: "ask", Mode: "build"}
	events, snapshot := v2SnapshotWorld(t, a)

	reply := make(chan questionOutcome, 1)
	a.inbox <- Envelope{Payload: workerQuestionReqMsg{gen: 1, id: "q1", req: tools.QuestionRequest{Questions: []tools.Question{{Question: "Pick one"}}}, reply: reply}}
	if initial := reviewRecv(t, events).(map[string]any); initial["type"] != "question_request" {
		t.Fatal(initial)
	}

	payload := snapshot()
	q, ok := payload["question"].(map[string]any)
	if !ok {
		t.Fatal("reconnected browser receives no pending question")
	}
	if q["id"] != "q1" {
		t.Fatalf("question identity lost: %+v", q)
	}
	a.inbox <- Envelope{Payload: questionResponseMsg{ID: "q1", Answers: [][]string{{"Pick one"}}}}
	if out := reviewRecv(t, reply); len(out.answers) != 1 {
		t.Fatalf("worker not resumed: %+v", out)
	}
	reviewRecv(t, events) // question_resolved precedes the next snapshot
	if snapshot()["question"] != nil {
		t.Fatal("resolved question revived in snapshot")
	}
}

// V2-004: the live turn overlay (tool starts/progress, thinking) survives
// snapshot restoration so the reconnected UI does not lose live state.
func TestV2SnapshotRestoresLiveOverlay(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	_, snapshot := v2SnapshotWorld(t, a)

	a.inbox <- Envelope{Payload: workerLiveMsg{gen: 1, live: &liveSnapshot{
		ToolStarts:        map[string]int64{"t1": 123},
		ToolProgress:      map[string]string{"t1": "still working"},
		ThinkingStartedAt: 456,
	}}}
	a.inbox <- Envelope{Payload: hookMsg{fn: func() {}}} // sequence
	payload := snapshot()
	if fmt.Sprint(payload["toolProgress"]) != "map[t1:still working]" {
		t.Fatalf("toolProgress lost: %+v", payload["toolProgress"])
	}
	if fmt.Sprint(payload["toolStarts"]) != "map[t1:123]" {
		t.Fatalf("toolStarts lost: %+v", payload["toolStarts"])
	}
	if fmt.Sprint(payload["thinkingStartedAt"]) != "456" {
		t.Fatalf("thinkingStartedAt lost: %+v", payload["thinkingStartedAt"])
	}
}

// V2-002: under a slow socket and a full outbox, a dropped decision is
// never silent — the session is resynced with a complete snapshot that
// carries the outstanding decision (the promoted review probe asserts
// the chosen contract: delivered OR restored via explicit resync).
func TestV2BackpressureResyncRestoresDecision(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	a.rec.Options = SessionOptions{Access: "ask", Mode: "build"}
	ws := newWSActor()
	block := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(block) }) }
	sent := make(chan any, 1024)
	ws.send = func(ev any) error {
		<-block // held socket write
		sent <- ev
		return nil
	}
	a.wsSend = func(ev any) { ws.emit(ev) }
	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	_ = server
	var wg sync.WaitGroup
	wg.Add(1)
	go ws.run(&wg)
	t.Cleanup(func() {
		release()
		ws.control <- shutdownMsg{}
		wg.Wait()
	})
	go a.run()
	t.Cleanup(func() { a.control <- shutdownMsg{}; <-a.done })

	// Fill the outbox while the writer is held.
	for i := 0; i < outboxCap+2; i++ {
		ws.emit(map[string]any{"type": "filler", "sessionId": a.id})
	}
	// The decision event overflows: it is dropped, but its session is
	// marked for resync — never silently lost.
	reply := make(chan approvalOutcome, 1)
	a.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: 1, id: "appr1", callID: "appr1", tool: "bash", args: json.RawMessage(`{"cmd":"ls"}`), reply: reply}}
	deadline := time.Now().Add(3 * time.Second)
	for ws.dropped.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if ws.dropped.Load() == 0 {
		t.Fatal("outbox never overflowed")
	}

	// Release the writer: the drain drives the resync flusher.
	release()
	for {
		select {
		case ev := <-sent:
			m, ok := ev.(map[string]any)
			if !ok || m["type"] != "session_data" {
				continue
			}
			sess := m["session"].(map[string]any)
			pa, ok := sess["pendingApproval"].(map[string]any)
			if !ok {
				t.Fatal("resync snapshot lost the pending decision")
			}
			if pa["callId"] != "appr1" {
				t.Fatalf("resync restored the wrong decision: %+v", pa)
			}
			return
		case <-time.After(5 * time.Second):
			t.Fatal("no resync snapshot after backpressure — the decision was lost silently")
		}
	}
}

// V2-002: a socket write error invalidates the connection (the link
// owner is notified) instead of writing into a half-dead socket.
func TestV2SocketWriteErrorInvalidatesConnection(t *testing.T) {
	ws := newWSActor()
	called := make(chan error, 1)
	ws.send = func(any) error { return errors.New("write failed") }
	ws.onWriteError = func(err error) { called <- err }
	var wg sync.WaitGroup
	wg.Add(1)
	go ws.run(&wg)
	t.Cleanup(func() { ws.control <- shutdownMsg{}; wg.Wait() })
	ws.emit(map[string]any{"type": "x", "sessionId": "s"})
	select {
	case err := <-called:
		if err == nil {
			t.Fatal("hook must receive the write error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("socket write error did not invalidate the connection")
	}
}


// V2-003: a completion notice is retained and redelivered until the
// session acknowledges folding it into its transcript — a full inbox at
// finish time can never lose it (the promoted review probe asserted the
// failure: "permanently discarded when the session inbox is full").
func TestV2BGCompletionRetriedUntilAck(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	inbox := make(chan Envelope, 1)
	b.session = func(string) (chan Envelope, chan any, bool) { return inbox, nil, true }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() { b.control <- shutdownMsg{}; wg.Wait() })

	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{SessionID: "session", Kind: "bash", Label: "build", Reply: reply}}
	jobID := (<-reply).(bgRegisterResult).JobID

	// The destination inbox is FULL when the job finishes.
	inbox <- Envelope{Payload: workerHeartbeatMsg{gen: 1}}
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: jobID, Status: BgStatusDone, Result: "done"}}
	// Let the finish be processed, then drain the filler.
	time.Sleep(50 * time.Millisecond)
	<-inbox

	// The retry ticker redelivers the retained notice.
	var notice bgNoticeMsg
	deadline := time.After(5 * time.Second)
	for {
		select {
		case env := <-inbox:
			if n, ok := env.Payload.(bgNoticeMsg); ok {
				notice = n
				goto delivered
			}
		case <-deadline:
			t.Fatal("completion notice permanently discarded instead of retried")
		}
	}
delivered:
	if notice.JobID != jobID || !notice.Finished {
		t.Fatalf("wrong notice: %+v", notice)
	}

	// After the session acks, the notice is retired — no further retries.
	b.inbox <- Envelope{Payload: bgAckMsg{JobID: jobID}}
	time.Sleep(50 * time.Millisecond)
	inbox <- Envelope{Payload: workerHeartbeatMsg{gen: 1}} // fill again
	time.Sleep(3 * bgNoticeRetryEvery)
	<-inbox
	select {
	case env := <-inbox:
		if _, ok := env.Payload.(bgNoticeMsg); ok {
			t.Fatal("acked notice was redelivered")
		}
	default:
	}
}

// V2-003: a duplicate delivery attempt cannot append twice or start a
// second wake-up turn — the background_delivery transcript identity is
// the idempotency key.
func TestV2BGNoticeFoldedExactlyOnce(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	go a.run()
	t.Cleanup(func() { a.control <- shutdownMsg{}; <-a.done })

	for i := 0; i < 2; i++ {
		a.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "job1", Text: "task done", Finished: true}}
	}
	done := make(chan struct{})
	a.inbox <- Envelope{Payload: hookMsg{fn: func() { close(done) }}}
	<-done

	// Read the transcript through the actor (never race its record).
	rr := make(chan any, 1)
	a.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rr}}
	rec := (<-rr).(readResult).Payload.(*SessionRecord)
	count := 0
	for _, msg := range rec.Messages {
		if msg.Meta["background_delivery"] == "job1" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("notice folded %d times, want exactly 1", count)
	}
}

// V2-003: an unacknowledged notice survives a restart via retained
// terminal metadata (never the already-deleted pidfile) and is retried —
// the original process is not re-run.
func TestV2BGNoticeRecoveredAfterRestart(t *testing.T) {
	dir := t.TempDir()
	b1 := newBGSupervisor(dir)
	b1.retainNotice("job9", "session", "task done", true)

	b2 := newBGSupervisor(dir)
	inbox := make(chan Envelope, 1)
	b2.session = func(string) (chan Envelope, chan any, bool) { return inbox, nil, true }
	var wg sync.WaitGroup
	wg.Add(1)
	go b2.run(&wg)
	t.Cleanup(func() { b2.control <- shutdownMsg{}; wg.Wait() })

	select {
	case env := <-inbox:
		n, ok := env.Payload.(bgNoticeMsg)
		if !ok || n.JobID != "job9" {
			t.Fatalf("recovered notice wrong: %+v", env.Payload)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unacknowledged notice lost across restart")
	}
}

// V2-006: while one session's actor is stalled, host-level commands must
// still be answered promptly (the promoted review probe asserted the
// sequential dispatch head-of-line block).
func TestV2BusySessionDoesNotBlockHostCommands(t *testing.T) {
	a := reviewActor(t)
	stalled, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseIt := func() { releaseOnce.Do(func() { close(release) }) }
	a.inbox <- Envelope{Payload: hookMsg{fn: func() { close(stalled); <-release }}}
	go a.run()
	t.Cleanup(func() { a.control <- shutdownMsg{}; <-a.done })
	reviewRecv(t, stalled)

	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	ws := newWSActor()
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	t.Cleanup(releaseIt)

	get, _ := json.Marshal(map[string]any{"type": "get_session", "sessionId": a.id, "requestId": "r1"})
	server.dispatch(get)
	server.dispatch([]byte(`{"type": "health"}`))

	// The health response must arrive while the session actor is stalled.
	select {
	case ev := <-ws.outbound:
		m := ev.(map[string]any)
		if m["type"] != "health" {
			t.Fatalf("expected the host-level health response first, got %v", m["type"])
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("a busy session blocks dispatch of an unrelated host-level health command")
	}

	// The stalled session's own command completes once the actor resumes.
	releaseIt()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ws.outbound:
			if m, ok := ev.(map[string]any); ok && m["type"] == "session_data" {
				return
			}
		case <-deadline:
			t.Fatal("session command never completed after the actor resumed")
		}
	}
}

// V2-006: dependent commands to one session keep their order.
func TestV2SessionLanePreservesOrder(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.Status = stateRunning, 1, "running"
	ws := newWSActor()
	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	go a.run()
	t.Cleanup(func() { a.control <- shutdownMsg{}; <-a.done })

	for i := 0; i < 3; i++ {
		raw, _ := json.Marshal(map[string]any{"type": "get_session", "sessionId": a.id, "requestId": fmt.Sprintf("r%d", i)})
		server.dispatch(raw)
	}
	for want := 0; want < 3; want++ {
		select {
		case ev := <-ws.outbound:
			m := ev.(map[string]any)
			if m["type"] != "session_data" {
				t.Fatalf("unexpected event %v", m["type"])
			}
			if m["requestId"] != fmt.Sprintf("r%d", want) {
				t.Fatalf("session commands reordered: got %v want r%d", m["requestId"], want)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("session_data missing")
		}
	}
}

// V2-006: dispatch saturation refuses with an explicit busy error
// instead of queueing unboundedly or blocking the socket reader.
func TestV2DispatchSaturationAnswersBusy(t *testing.T) {
	a := reviewActor(t)
	stalled, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseIt := func() { releaseOnce.Do(func() { close(release) }) }
	a.inbox <- Envelope{Payload: hookMsg{fn: func() { close(stalled); <-release }}}
	go a.run()
	t.Cleanup(func() {
		releaseIt()
		a.control <- shutdownMsg{}
		<-a.done
	})
	reviewRecv(t, stalled)

	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	ws := newWSActor()
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)

	// One command holds the lane worker (blocked on the stalled actor);
	// the rest fill the queue; further commands must be refused loudly.
	for i := 0; i < tuneDispatchQueue+2; i++ {
		raw, _ := json.Marshal(map[string]any{"type": "get_session", "sessionId": a.id, "requestId": fmt.Sprintf("r%d", i)})
		server.dispatch(raw)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case ev := <-ws.outbound:
			if m, ok := ev.(map[string]any); ok && m["type"] == "error" {
				if msg, _ := m["message"].(string); strings.Contains(msg, "busy") || strings.Contains(msg, "Busy") {
					return
				}
			}
		case <-deadline:
			t.Fatal("saturated dispatch lane never answered with an explicit busy error")
		}
	}
}

// V2-003: explicit session deletion terminates pending delivery — a late
// notice must never resurrect the session.
func TestV2BGNoticeDroppedOnSessionDeletion(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	inbox := make(chan Envelope, 1)
	b.session = func(string) (chan Envelope, chan any, bool) { return inbox, nil, true }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() { b.control <- shutdownMsg{}; wg.Wait() })

	// Finish a job while its session cannot accept the notice.
	inbox <- Envelope{Payload: workerHeartbeatMsg{gen: 1}}
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{SessionID: "doomed", Kind: "bash", Label: "build", Reply: reply}}
	jobID := (<-reply).(bgRegisterResult).JobID
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: jobID, Status: BgStatusDone, Result: "done"}}
	time.Sleep(50 * time.Millisecond)

	// Delete the session: its pending notices die with it.
	b.inbox <- Envelope{Payload: bgDropNoticesMsg{SessionID: "doomed"}}
	time.Sleep(50 * time.Millisecond)
	<-inbox // drain the filler
	select {
	case env := <-inbox:
		if n, ok := env.Payload.(bgNoticeMsg); ok && n.JobID == jobID {
			t.Fatal("late notice resurrected a deleted session")
		}
	default:
	}
}
