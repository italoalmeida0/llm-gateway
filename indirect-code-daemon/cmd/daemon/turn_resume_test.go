package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestTurnJournalRoundTrip(t *testing.T) {
	d := testDaemon(t)
	j := &TurnJournal{
		TurnIndex: 4,
		StartedAt: 123456,
		Model:     "m",
		Incoming: []filetrack.TrackedFile{
			{Path: "/w/a.txt", Before: "old", HasBefore: true},
			{Path: "/w/b.txt", HasBefore: false, CreatedWithWrite: true},
		},
	}
	d.writeTurnJournal("sess_j", j)
	if got := d.scanTurnJournals(); len(got) != 1 || got[0] != "sess_j" {
		t.Fatalf("scan = %v; want [sess_j]", got)
	}
	back, err := d.readTurnJournal("sess_j")
	if err != nil || back == nil {
		t.Fatalf("read: %v %+v", err, back)
	}
	if back.TurnIndex != 4 || back.StartedAt != 123456 || back.Model != "m" {
		t.Fatalf("header lost: %+v", back)
	}
	if len(back.Incoming) != 2 {
		t.Fatalf("incoming = %d; want 2", len(back.Incoming))
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
	// Missing journal reads as nil without error; traversal refused.
	if j2, err := d.readTurnJournal("nope"); err != nil || j2 != nil {
		t.Fatalf("missing journal: %v %+v", err, j2)
	}
	if p := d.turnJournalPath("../evil"); p != "" {
		t.Fatalf("traversal accepted: %q", p)
	}
	d.deleteTurnJournal("sess_j")
	if _, err := os.Stat(filepath.Join(d.sessionsDir(), "sess_j.turn.json")); !os.IsNotExist(err) {
		t.Fatalf("journal not deleted")
	}
	if got := d.scanTurnJournals(); len(got) != 0 {
		t.Fatalf("scan after delete = %v", got)
	}
}

// turnResumeAbandoned: resume unless the turn already finished (balloon
// present) or never started on disk (no message of its index).
func TestTurnResumeAbandoned(t *testing.T) {
	msg := func(turn int) provider.Message {
		return provider.Message{Role: provider.RoleUser, TurnIndex: turn}
	}
	j := &TurnJournal{TurnIndex: 3}
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
// "running", journal kept) and concludes alone once the upstream
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
	rec := &SessionRecord{ID: "sess_int", CWD: t.TempDir(), Title: "t", Model: "m", Status: "idle"}
	act := &ActiveSession{record: rec, approvalReqs: map[string]chan bool{}}
	d.sessions[rec.ID] = act

	done := make(chan struct{})
	go func() {
		d.runAgentTurn(act, "hello?", "m", true, nil)
		close(done)
	}()

	// While the upstream keeps failing the turn must stay alive and
	// retrying: still running, journal kept, never parked, never ended.
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
	if j, err := d.readTurnJournal(rec.ID); err != nil || j == nil || j.TurnIndex != 1 {
		t.Fatalf("retrying turn must keep its journal: %+v %v", j, err)
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
	if j, _ := d.readTurnJournal(rec.ID); j != nil {
		t.Fatal("concluded turn must drop the journal")
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
