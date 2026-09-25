package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// These tests assert the intended behavior, so failures are review evidence.
func reviewRecv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(3 * time.Second):
		t.Fatal("reply timeout")
	}
	var zero T
	return zero
}

func reviewActor(t *testing.T) *sessionActor {
	t.Helper()
	st := newDiskStore(t.TempDir())
	rec := newTestRecord("review")
	rec.CWD = t.TempDir()
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	a := newSessionActor(rec.ID, rec, st, func(any) {}, nil, nil)
	a.done = make(chan struct{})
	return a
}

func TestReviewApprovalWireRoundTrip(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options = SessionOptions{Mode: "build", Access: "ask"}
	events := make(chan map[string]any, 10)
	a.wsSend = func(ev any) { events <- ev.(map[string]any) }
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &turnBridge{ctx: ctx, env: workerEnv{inbox: a.inbox, actorID: a.id}, snap: workerSnapshot{gen: 1, options: SessionOptions{Mode: "build", Access: "ask"}}}
	result := make(chan bool, 1)
	go func() {
		ok, _, _ := w.approveTool(provider.ToolCallBlock{ID: "tool-wire-id", Name: "bash", Arguments: json.RawMessage(`{}`)})
		result <- ok
	}()
	req := reviewRecv(t, events)
	a.inbox <- Envelope{Payload: approvalResponseMsg{ID: req["callId"].(string), Approved: true}}
	select {
	case ok := <-result:
		if !ok {
			t.Fatal("approval refused")
		}
	case <-time.After(150 * time.Millisecond):
		t.Fatal("the exact callId sent to the browser does not resolve approval")
	}
}

func TestReviewSleepTransitionsDoNotPanic(t *testing.T) {
	for _, scenario := range []string{"two-jobs", "sleep-expired"} {
		t.Run(scenario, func(t *testing.T) {
			b := newBGSupervisor(t.TempDir())
			register := func() string {
				r := make(chan any, 1)
				b.onRegister(bgRegisterMsg{SessionID: "s", Reply: r})
				return (<-r).(bgRegisterResult).JobID
			}
			one := register()
			if scenario == "two-jobs" {
				register()
			}
			done := make(chan struct{})
			wake := b.onSubscribe("s", done).(chan struct{})
			if scenario == "sleep-expired" {
				close(done)
				b.handle(reviewRecv(t, b.inbox))
				reviewRecv(t, wake)
			}
			defer func() {
				if p := recover(); p != nil {
					t.Errorf("job completion panicked: %v", p)
				}
			}()
			b.onFinish(one, BgStatusDone, "done")
		})
	}
}

func TestReviewIdleMutationsVisibleOnDiskAndMirror(t *testing.T) {
	for _, kind := range []string{"rename", "configure", "queue"} {
		t.Run(kind, func(t *testing.T) {
			a := reviewActor(t)
			r := make(chan any, 1)
			switch kind {
			case "rename":
				a.handleData(Envelope{Payload: renameMsg{Title: "new title", Reply: r}})
				<-r
			case "configure":
				a.handleData(Envelope{Payload: configureMsg{Model: "new-model", Options: SessionOptions{Access: "full"}}})
			case "queue":
				a.onQueueOp(queueOpMsg{Op: "add", Text: "do this later", Reply: r})
				<-r
			}
			disk, err := a.store.loadSession(a.id)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "rename" && disk.Title != a.rec.Title {
				t.Errorf("acknowledged rename lost: disk=%q RAM=%q", disk.Title, a.rec.Title)
			}
			if kind == "configure" && disk.Model != a.rec.Model {
				t.Errorf("configuration lost: disk=%q RAM=%q", disk.Model, a.rec.Model)
			}
			if kind == "queue" && len(disk.Queue) != len(a.rec.Queue) {
				t.Errorf("queue lost: disk=%d RAM=%d", len(disk.Queue), len(a.rec.Queue))
			}
			rows := listSessionSummaries(a.store.dataDir)
			if len(rows) > 0 && (rows[0].Title != a.rec.Title || rows[0].Model != a.rec.Model) {
				t.Errorf("mirror reads stale disk state after accepted mutation")
			}
		})
	}
}

func TestReviewWatchdogEscalatesRealCancelState(t *testing.T) {
	a := reviewActor(t)
	a.state = stateRunning
	a.workerDone = make(chan struct{}) // worker deliberately ignores cancellation
	a.lastProgress = time.Now().Add(-time.Hour).UnixMilli()
	a.cancel = func() {}
	s := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	s.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	for i := 0; i < maxCancelRounds+2; i++ {
		s.watchdogRound()
	}
	r := s.ping(a.id)
	if r.State != stateOrphaned {
		t.Fatalf("after six watchdog rounds, stuck worker remains %s instead of orphaned", r.State)
	}
}

func TestReviewCancelledWorkerAlwaysReportsFinish(t *testing.T) {
	c := &configCell{} // nil config makes the terminal path deterministic and network-free
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	lost := 0
	for i := 0; i < 200; i++ {
		inbox := make(chan Envelope, 1)
		runTurnWorker(ctx, workerEnv{cfg: c, inbox: inbox}, workerSnapshot{gen: 1})
		if len(inbox) == 0 {
			lost++
		}
	}
	if lost > 0 {
		t.Fatalf("%d/200 terminal notifications discarded despite available inbox", lost)
	}
}

func TestReviewPromptSnapshotIncludesAttachmentIDs(t *testing.T) {
	a := reviewActor(t)
	a.rec.Attachments = []AttachmentRef{{ID: "att-one", Name: "notes.txt"}}
	captures := make(chan workerSnapshot, 1)
	a.startWorker = func(s workerSnapshot, _ workerEnv, _ context.Context) { captures <- s }
	a.startTurn("read this", []string{"att-one"}, "m", false, nil)
	snap := reviewRecv(t, captures)
	defer a.doShutdown()
	if len(snap.attachIDs) != 1 {
		t.Fatalf("selected attachment lost before worker: %#v", snap.attachIDs)
	}
}

func reviewGateway(t *testing.T, respond func(http.ResponseWriter, *http.Request)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"models":[{"id":"m","limit":{"context":1000000,"output":1024}}]}`)
			return
		}
		respond(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}
func reviewTextSSE(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n")
	io.WriteString(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"ok\"}}\n\n")
	io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n")
	io.WriteString(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
	io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n")
	io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
}

func TestReviewManualCompactActuallyCompacts(t *testing.T) {
	reqs := make(chan string, 10)
	srv := reviewGateway(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		reqs <- string(body)
		reviewTextSSE(w)
	})
	a := reviewActor(t)
	a.supCfg.store(&DaemonConfig{HostID: "h", GatewayURL: srv.URL, Settings: HarnessSettings{NoAutoTitle: true}})
	a.rec.Options = SessionOptions{Access: "full", Mode: "talk", Effort: "none"}
	for i := 1; i <= 6; i++ {
		a.rec.Messages = append(a.rec.Messages, provider.Message{Role: provider.RoleUser, TurnIndex: i, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("user %d", i)}}}, provider.Message{Role: provider.RoleAssistant, TurnIndex: i, Content: []provider.Content{provider.TextBlock{Text: "previous answer"}}})
	}
	a.rec.TurnSeq = 6
	if err := a.store.saveSessionSync(a.rec); err != nil {
		t.Fatal(err)
	}
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	a.inbox <- Envelope{Payload: compactNowMsg{}}
	body := reviewRecv(t, reqs)
	deadline := time.Now().Add(3 * time.Second)
	for {
		rr := make(chan any, 1)
		a.control <- watchdogPingMsg{Reply: rr}
		if (<-rr).(watchdogReport).State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("compact did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	rr := make(chan any, 1)
	a.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rr}}
	rec := (<-rr).(readResult).Payload.(*SessionRecord)
	if rec.Compaction == nil {
		t.Fatalf("manual compact produced an ordinary request containing /compact=%v; compaction is nil and messages grew from 12 to %d", strings.Contains(body, "/compact"), len(rec.Messages))
	}
}

func TestReviewBackgroundNoticeReachesWorkerRequest(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen, a.rec.TurnSeq = stateRunning, 1, 1
	a.rec.Options = SessionOptions{Access: "full", Mode: "build", Effort: "none"}
	snap, env := snapshotTurn(a, 1, "work", nil)
	w := &turnBridge{snap: snap, env: env, ctx: context.Background(), modelInfo: provider.Model{ID: "m"}, reg: core.NewRegistry()}
	w.agent = core.NewAgent(nil, "m", "", core.NewRegistry())
	w.agent.SetMessages(snap.messages)
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	a.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "job-one", Text: "job completed, read /tmp/job.log", Finished: true}}
	if err := w.beforeRequest(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, m := range w.agent.History() {
		if m.Meta["background_delivery"] == "job-one" {
			return
		}
	}
	t.Fatal("actor stored completion, but worker context still has no background_delivery before its next request")
}

func TestReviewRealBackgroundProcessRecordsPID(t *testing.T) {
	b := testBG(t)
	st := newDiskStore(t.TempDir())
	w := &turnBridge{ctx: context.Background(), env: workerEnv{bg: b, actorID: "review", inbox: make(chan Envelope, 8), brainDir: st.ensureBrainDir}}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 20 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	tool := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox("/tmp"), Slow: w.slowHook()}
	_, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"sleep 10"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	rows := bgList(t, b)
	if len(rows) != 1 {
		t.Fatalf("jobs=%d", len(rows))
	}
	id := rows[0]["id"].(string)
	defer func() { r := make(chan any, 1); b.inbox <- Envelope{Payload: bgCancelMsg{JobID: id, Reply: r}}; <-r }()
	data, err := os.ReadFile(b.pidPath(id))
	if err != nil {
		t.Fatal(err)
	}
	var pf bgPidfile
	if err := json.Unmarshal(data, &pf); err != nil {
		t.Fatal(err)
	}
	if pf.PID <= 0 {
		t.Fatalf("real detached process persisted PID=%d; restart will classify live work as orphaned", pf.PID)
	}
}

func TestReviewCommitFailureRetainsRecoveryWAL(t *testing.T) {
	a := reviewActor(t)
	a.gen, a.rec.TurnSeq, a.state = 1, 1, stateRunning
	wal, err := a.store.openWAL(a.id, &walHeader{TurnIndex: 1, Prompt: "first"})
	if err != nil {
		t.Fatal(err)
	}
	a.wal = wal
	msg := provider.Message{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "first"}}}
	a.onWALAppend(walAppendMsg{gen: 1, ev: walMsgEvent(msg)})
	// A malformed committed file deterministically fails the commit.
	if err := os.WriteFile(a.store.sessionFile(a.id), []byte("not JSON\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a.finishTurn(true)
	a.startWorker = func(workerSnapshot, workerEnv, context.Context) {}
	r := make(chan any, 1)
	a.onUserPrompt(userPromptMsg{Text: "second", Reply: r})
	res := (<-r).(promptResult)
	data, _ := os.ReadFile(filepath.Join(a.store.sessionsDir(), a.id+".wal.jsonl"))
	defer func() {
		if a.wal != nil {
			_ = a.wal.close()
		}
	}()
	if res.Accepted && !strings.Contains(string(data), `"prompt":"first"`) {
		t.Fatal("failed commit reported idle, accepted new turn, and truncated the only recovery WAL")
	}
}

func TestReviewQuestionWireContainsFrontendID(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	var event any
	a.wsSend = func(ev any) { event = ev }
	a.onWorkerQuestionReq(workerQuestionReqMsg{gen: 1, id: "question-one", req: tools.QuestionRequest{Questions: []tools.Question{{Header: "Choice", Question: "Pick?", Options: []tools.QuestionOption{{Label: "One"}}}}}, reply: make(chan questionOutcome, 1)})
	defer a.clearPending()
	raw, _ := json.Marshal(event)
	var wire struct {
		Question struct {
			ID string `json:"id"`
		} `json:"question"`
	}
	json.Unmarshal(raw, &wire)
	if wire.Question.ID != "question-one" {
		t.Fatalf("question.id required by showQuestion/answerQuestion is missing: %s", raw)
	}
}

func TestReviewLiveAccessChangeEnforcedBeforeTool(t *testing.T) {
	a := reviewActor(t)
	a.state, a.gen = stateRunning, 1
	a.rec.Options = SessionOptions{Mode: "build", Access: "full", Effort: "none"}
	snap, env := snapshotTurn(a, 1, "work", nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &turnBridge{snap: snap, env: env, ctx: ctx, modelInfo: provider.Model{ID: "m"}, reg: core.NewRegistry()}
	w.agent = core.NewAgent(nil, "m", "", core.NewRegistry())
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	a.inbox <- Envelope{Payload: configureMsg{Options: SessionOptions{Mode: "build", Access: "ask", Effort: "none"}}}
	if err := w.beforeRequest(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := make(chan bool, 1)
	go func() {
		ok, _, _ := w.approveTool(provider.ToolCallBlock{ID: "call-one", Name: "bash", Arguments: json.RawMessage(`{}`)})
		result <- ok
	}()
	select {
	case ok := <-result:
		if ok {
			t.Fatal("full -> ask was accepted, but next bash still bypassed approval")
		}
	case <-time.After(100 * time.Millisecond):
	}
}

func TestReviewResidentCapEnforcedBelowMemoryBudget(t *testing.T) {
	old := maxResidentActors
	maxResidentActors = 2
	defer func() { maxResidentActors = old }()
	cfg := &configCell{}
	cfg.store(&DaemonConfig{})
	s := newSessionSupervisor(t.TempDir(), cfg, nil, nil)
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("cap%d", i)
		s.disk().saveSessionSync(newTestRecord(id))
		res := s.route(id, true)
		if res.Error != "" {
			t.Fatal(res.Error)
		}
	}
	s.evictIdle(false)
	s.mu.Lock()
	n := len(s.resident)
	s.mu.Unlock()
	defer func() {
		for i := 0; i < 3; i++ {
			s.passivate(fmt.Sprintf("cap%d", i))
		}
	}()
	if n > maxResidentActors {
		t.Fatalf("cap=2 but %d idle actors remain (under memory budget and before TTL)", n)
	}
}

func TestReviewPassivationRechecksIdleAfterPrompt(t *testing.T) {
	a := reviewActor(t)
	a.startWorker = func(workerSnapshot, workerEnv, context.Context) {}
	r := make(chan any, 1)
	// Eviction selected idle earlier; a prompt reached the data lane first.
	a.inbox <- Envelope{Payload: userPromptMsg{Text: "new work", Reply: r}}
	a.control <- passivateMsg{}
	go a.run()
	if res := reviewRecv(t, r).(promptResult); !res.Accepted {
		t.Fatal(res.Error)
	}
	select {
	case <-a.done:
		t.Fatal("an idle-eviction request terminated a newly accepted running turn")
	case <-time.After(100 * time.Millisecond):
		a.control <- shutdownMsg{}
		<-a.done
	}
}

func TestReviewBackgroundWakeMetaPersists(t *testing.T) {
	srv := reviewGateway(t, func(w http.ResponseWriter, r *http.Request) { reviewTextSSE(w) })
	a := reviewActor(t)
	a.rec.Options = SessionOptions{Mode: "talk", Access: "full", Effort: "none"}
	a.supCfg.store(&DaemonConfig{GatewayURL: srv.URL, Settings: HarnessSettings{NoAutoTitle: true}})
	go a.run()
	defer func() { a.control <- shutdownMsg{}; <-a.done }()
	a.inbox <- Envelope{Payload: bgNoticeMsg{JobID: "bg-review", Text: "background completed", Finished: true}}
	deadline := time.Now().Add(3 * time.Second)
	for {
		r := make(chan any, 1)
		a.control <- watchdogPingMsg{Reply: r}
		if (<-r).(watchdogReport).State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("wake did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	r := make(chan any, 1)
	a.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: r}}
	rec := (<-r).(readResult).Payload.(*SessionRecord)
	for _, m := range rec.Messages {
		if m.Meta["background_delivery"] == "bg-review" {
			return
		}
	}
	t.Fatalf("real wake-up worker dropped background_delivery metadata (%d messages)", len(rec.Messages))
}
