package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestWALRoundTrip(t *testing.T) {
	d := testDaemon(t)
	header := &walHeader{
		TurnIndex: 4,
		StartedAt: 123456,
		Model:     "m",
		Prompt:    "do it",
		Incoming: []filetrack.TrackedFile{
			{Path: "/w/a.txt", Before: "old", HasBefore: true},
			{Path: "/w/b.txt", HasBefore: false, CreatedWithWrite: true},
		},
	}
	ww, err := d.openWAL("sess_j", header)
	if err != nil {
		t.Fatal(err)
	}
	if err := ww.append(walMsgEvent(provider.Message{Role: provider.RoleUser, TurnIndex: 4, Content: []provider.Content{provider.TextBlock{Text: "hi"}}})); err != nil {
		t.Fatal(err)
	}
	if err := ww.close(); err != nil {
		t.Fatal(err)
	}
	if got := d.scanWALs(); len(got) != 1 || got[0] != "sess_j" {
		t.Fatalf("scan = %v; want [sess_j]", got)
	}
	back, err := d.readWALHeader("sess_j")
	if err != nil || back == nil {
		t.Fatalf("read: %v %+v", err, back)
	}
	if back.TurnIndex != 4 || back.StartedAt != 123456 || back.Model != "m" || back.Prompt != "do it" {
		t.Fatalf("header lost: %+v", back)
	}
	if len(back.Incoming) != 2 {
		t.Fatalf("incoming = %d; want 2", len(back.Incoming))
	}
	// Replay fuses the appended message onto the frozen base.
	base := &SessionRecord{ID: "sess_j"}
	data, err := os.ReadFile(d.walPath("sess_j"))
	if err != nil {
		t.Fatal(err)
	}
	fused, h, err := replayWAL(base, data)
	if err != nil || h == nil || len(fused.Messages) != 1 {
		t.Fatalf("replay: %v %+v %d", err, h, len(fused.Messages))
	}
	// Tracker restore keeps first-sighting semantics: the restored entry
	// wins over later touches, exactly as an uninterrupted turn.
	tr := filetrack.RestoreTurnTracker(back.Incoming)
	tr.NoteEditBefore("/w/a.txt", "later-touch-ignored")
	snap := tr.Snapshot()
	for _, f := range snap {
		if f.Path == "/w/a.txt" && f.Before != "old" {
			t.Fatalf("restore lost first sighting: %+v", f)
		}
	}
	// Missing WAL reads as nil without error; traversal refused.
	if h2, err := d.readWALHeader("nope"); err != nil || h2 != nil {
		t.Fatalf("missing wal: %v %+v", err, h2)
	}
	if p := d.walPath("../evil"); p != "" {
		t.Fatalf("traversal accepted: %q", p)
	}
	_ = os.Remove(d.walPath("sess_j"))
	if got := d.scanWALs(); len(got) != 0 {
		t.Fatalf("scan after delete = %v", got)
	}
}

// turnResumeAbandoned: resume unless the turn already finished (balloon
// present) or never started on disk (no message of its index).
func TestTurnResumeAbandoned(t *testing.T) {
	msg := func(turn int) provider.Message {
		return provider.Message{Role: provider.RoleUser, TurnIndex: turn}
	}
	j := &walHeader{TurnIndex: 3}
	full := &SessionRecord{
		Messages:     []provider.Message{msg(1), msg(3)},
		FileBalloons: []filetrack.TurnChanges{{TurnIndex: 1}},
	}
	if turnResumeAbandoned(full, j) {
		t.Fatalf("live turn must resume")
	}
	done := &SessionRecord{
		Messages:     []provider.Message{msg(1), msg(3)},
		FileBalloons: []filetrack.TurnChanges{{TurnIndex: 3}},
	}
	if !turnResumeAbandoned(done, j) {
		t.Fatalf("finished turn (balloon present) must not resume")
	}
	empty := &SessionRecord{Messages: []provider.Message{msg(1)}}
	if !turnResumeAbandoned(empty, j) {
		t.Fatalf("turn with no persisted message must not resume")
	}
}

// TestCancelBeforeFirstUsageKeepsContext: cancelling a turn before the
// first upstream usage row must not zero the context display. The daemon
// seeds an estimate at turn start (and again at finish when missing), so
// the snapshot after cancel carries a usable context instead of nil.
func TestCancelBeforeFirstUsageKeepsContext(t *testing.T) {
	d := testDaemon(t)
	msgArrived := make(chan struct{})
	var arrivedOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			_, _ = w.Write([]byte(`{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`))
			return
		}
		arrivedOnce.Do(func() { close(msgArrived) })
		// Headers flushed but zero events: the stream is open yet no usage
		// row ever arrives (cancel lands before message_start). A fake that
		// never writes headers would leave the server side deaf to client
		// abort (nothing in flight to tear down) and hang Close.
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	// CloseClientConnections runs before Close (LIFO): with the handler
	// blocked mid-stream, plain Close would wait for it forever.
	defer upstream.Close()
	defer upstream.CloseClientConnections()
	d.config.GatewayURL = upstream.URL
	rec := &SessionRecord{ID: "sess_ctx", CWD: t.TempDir(), Title: "t", Model: "m", Status: "idle"}
	act := &ActiveSession{record: rec, approvalReqs: map[string]chan bool{}}
	d.sessions[rec.ID] = act
	done := make(chan struct{})
	go func() {
		d.runAgentTurn(act, "hello?", "m", true, nil)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		act.mu.Lock()
		running := act.record.Status == "running"
		act.mu.Unlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("turn never started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Cancel once the model request is in flight with the stream open but
	// zero events delivered: the abort emits an all-zero usage row that
	// must not clobber the context estimate (nor leave it nil).
	select {
	case <-msgArrived:
	case <-time.After(5 * time.Second):
		t.Fatal("model request never arrived")
	}
	time.Sleep(300 * time.Millisecond)
	// Same as the "cancel" command handler.
	act.mu.Lock()
	if act.cancel != nil {
		act.cancel()
	}
	act.mu.Unlock()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("cancelled turn did not finish")
	}
	stored, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Turn == nil || stored.Turn.Status != "cancelled" {
		t.Fatalf("turn not marked cancelled: %+v", stored.Turn)
	}
	if stored.Context == nil {
		t.Fatal("context is nil after cancel: display would show 0/0%")
	}
	if stored.Context.UsedTokens <= 0 || stored.Context.WindowTokens != 100000 {
		t.Fatalf("context not seeded: %+v", stored.Context)
	}
}

// TestProviderErrorRetriesUntilRecovery enforces the single-stop
// contract: a turn ends ONLY by AI conclusion or user cancel. A failing
// upstream never parks the turn — it keeps retrying on backoff (still
// "running", WAL kept) and concludes alone once the upstream
// recovers, with zero user action in between.
func TestProviderErrorRetriesUntilRecovery(t *testing.T) {
	d := testDaemon(t)
	var failMode atomic.Bool
	failMode.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			_, _ = w.Write([]byte(`{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`))
			return
		}
		if failMode.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":12}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"recovered\"}}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":7}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	defer upstream.CloseClientConnections()
	d.config.GatewayURL = upstream.URL
	rec := &SessionRecord{ID: "sess_int", Options: SessionOptions{Mode: "talk"}, CWD: t.TempDir(), Title: "t", Model: "m", Status: "idle"}
	act := &ActiveSession{record: rec, approvalReqs: map[string]chan bool{}}
	d.sessions[rec.ID] = act

	done := make(chan struct{})
	go func() {
		d.runAgentTurn(act, "hello?", "m", true, nil)
		close(done)
	}()

	// While the upstream keeps failing the turn must stay alive and
	// retrying: still running, WAL kept, never parked, never ended.
	time.Sleep(2500 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("failing upstream must not end the turn")
	default:
	}
	act.mu.Lock()
	status := act.record.Status
	act.mu.Unlock()
	if status != "running" {
		t.Fatalf("failing upstream must keep retrying: status = %q", status)
	}
	if h, herr := d.readWALHeader(rec.ID); herr != nil || h == nil || h.TurnIndex != 1 {
		t.Fatalf("retrying turn must keep its WAL: %+v %v", h, herr)
	}

	// The upstream recovers: the turn concludes alone, no user action.
	failMode.Store(false)
	deadline := time.Now().Add(15 * time.Second)
	select {
	case <-done:
	case <-time.After(time.Until(deadline)):
		t.Fatal("recovered turn did not complete")
	}
	stored, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "idle" {
		t.Fatalf("recovered turn must conclude: status = %q", stored.Status)
	}
	if h, _ := d.readWALHeader(rec.ID); h != nil {
		t.Fatal("concluded turn must drop the WAL")
	}
	sawAnswer := false
	for _, m := range stored.Messages {
		if m.TurnIndex != 1 {
			t.Fatalf("recovery must not advance numbering: %+v", m)
		}
		if m.Role == provider.RoleAssistant {
			for _, c := range m.Content {
				if tb, ok := c.(provider.TextBlock); ok && tb.Text == "recovered" {
					sawAnswer = true
				}
			}
		}
	}
	if !sawAnswer {
		t.Fatal("recovered turn produced no answer")
	}
}
