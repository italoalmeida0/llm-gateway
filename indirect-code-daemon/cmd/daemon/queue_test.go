package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func queueAdd(t *testing.T, d *DaemonServer, sessionID, text string) {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"type": "queue_add", "sessionId": sessionID, "text": text})
	d.handleMessage(raw)
}

func loadQueue(t *testing.T, d *DaemonServer, sessionID string) []QueuedMessage {
	t.Helper()
	rec, err := d.loadSession(sessionID)
	if err != nil {
		t.Fatal(err)
	}
	return rec.Queue
}

func TestQueueAddUpdateRemove(t *testing.T) {
	d := testDaemon(t)
	dir := t.TempDir()
	rec := &SessionRecord{ID: "q", CWD: dir, Status: "idle", Model: "m"}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	queueAdd(t, d, "q", "first")
	queueAdd(t, d, "q", "second")
	got := loadQueue(t, d, "q")
	if len(got) != 2 || got[0].Text != "first" || got[1].Text != "second" {
		t.Fatalf("FIFO order broken: %+v", got)
	}
	if got[0].ID == "" || got[0].ID == got[1].ID {
		t.Fatalf("queue ids missing or duplicated: %+v", got)
	}
	// Update the head.
	raw, _ := json.Marshal(map[string]any{"type": "queue_update", "sessionId": "q", "queueId": got[0].ID, "text": "first-edited"})
	d.handleMessage(raw)
	got = loadQueue(t, d, "q")
	if got[0].Text != "first-edited" {
		t.Fatalf("update did not apply: %+v", got)
	}
	// Remove the head.
	raw, _ = json.Marshal(map[string]any{"type": "queue_remove", "sessionId": "q", "queueId": got[0].ID})
	d.handleMessage(raw)
	got = loadQueue(t, d, "q")
	if len(got) != 1 || got[0].Text != "second" {
		t.Fatalf("remove did not apply: %+v", got)
	}
	// Remove the last one: nil, not empty slice.
	raw, _ = json.Marshal(map[string]any{"type": "queue_remove", "sessionId": "q", "queueId": got[0].ID})
	d.handleMessage(raw)
	rec, err := d.loadSession("q")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Queue != nil {
		t.Fatalf("expected nil queue, got: %+v", rec.Queue)
	}
}

func TestQueueCap(t *testing.T) {
	d := testDaemon(t)
	dir := t.TempDir()
	rec := &SessionRecord{ID: "qcap", CWD: dir, Status: "idle", Model: "m"}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxQueueItems+5; i++ {
		queueAdd(t, d, "qcap", "msg")
	}
	if got := loadQueue(t, d, "qcap"); len(got) != maxQueueItems {
		t.Fatalf("want cap %d, got %d", maxQueueItems, len(got))
	}
}

func TestShiftQueue(t *testing.T) {
	rec := &SessionRecord{Queue: []QueuedMessage{{ID: "a"}, {ID: "b"}}}
	head, ok := shiftQueue(rec)
	if !ok || head.ID != "a" || len(rec.Queue) != 1 || rec.Queue[0].ID != "b" {
		t.Fatalf("shift broken: %+v %+v", head, rec.Queue)
	}
	head, ok = shiftQueue(rec)
	if !ok || head.ID != "b" || rec.Queue != nil {
		t.Fatalf("drain broken: %+v %+v", head, rec.Queue)
	}
	if _, ok := shiftQueue(rec); ok {
		t.Fatal("empty shift reported ok")
	}
}

func TestQueueSendNowWithoutRunningTurn(t *testing.T) {
	d := testDaemon(t)
	queueTestUpstream(t, d)
	dir := t.TempDir()
	rec := &SessionRecord{ID: "qnow", CWD: dir, Status: "idle", Model: "m", Options: SessionOptions{Access: "full"}}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	queueAdd(t, d, "qnow", "now")
	got := loadQueue(t, d, "qnow")
	raw, _ := json.Marshal(map[string]any{"type": "queue_send_now", "sessionId": "qnow", "queueId": got[0].ID})
	d.handleMessage(raw)
	// Item shifted out of the queue (prompt start proceeds async).
	if q := loadQueue(t, d, "qnow"); len(q) != 0 {
		t.Fatalf("send-now did not shift: %+v", q)
	}
	// The promoted turn runs to completion on the fake upstream.
	stored := waitUserTurns(t, d, "qnow", 1)
	if stored.Turn == nil || stored.Turn.Status != "completed" {
		t.Fatalf("send-now turn did not complete: %+v", stored.Turn)
	}
}

// queueTestUpstream answers every turn with an immediate task completion.
func queueTestUpstream(t *testing.T, d *DaemonServer) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			_, _ = w.Write([]byte(`{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		emit := func(event string, data any) {
			encoded, _ := json.Marshal(data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
		}
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"model": "m", "usage": map[string]any{"input_tokens": 10}}})
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "done"}})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 1, "content_block": map[string]any{"type": "tool_use", "id": "done-1", "name": "mark_task_as_complete", "input": map[string]any{}}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 1, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"notes":"done"}`}})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 1})
		emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]any{"output_tokens": 10}})
		emit("message_stop", map[string]any{"type": "message_stop"})
	}))
	t.Cleanup(upstream.Close)
	d.config.GatewayURL = upstream.URL
}

func waitUserTurns(t *testing.T, d *DaemonServer, sessionID string, n int) *SessionRecord {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		rec, err := d.loadSession(sessionID)
		if err != nil {
			t.Fatal(err)
		}
		if queueUserTurnCount(rec) >= n {
			return rec
		}
		if time.Now().After(deadline) {
			t.Fatalf("want %d user turns, got %d", n, queueUserTurnCount(rec))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func queueUserTurnCount(rec *SessionRecord) int {
	n := 0
	for _, m := range rec.Messages {
		if m.Role == "user" {
			n++
		}
	}
	return n
}

func TestQueueAutoStartsOnCompletedTurn(t *testing.T) {
	d := testDaemon(t)
	queueTestUpstream(t, d)
	dir := t.TempDir()
	rec := &SessionRecord{ID: "qauto", CWD: dir, Status: "idle", Model: "m", Options: SessionOptions{Access: "full"}}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	act, err := d.getOrCreateActiveSession("qauto")
	if err != nil {
		t.Fatal(err)
	}
	queueAdd(t, d, "qauto", "queued follow-up")
	done := make(chan struct{})
	go func() {
		d.runAgentTurn(act, "first turn", "m", true, nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("first turn did not finish")
	}
	// The completed turn must have promoted the head automatically:
	// wait for the queued turn to appear AND complete (queue empty).
	stored := waitUserTurns(t, d, "qauto", 2)
	if stored.Turn == nil || stored.Turn.Status != "completed" {
		t.Fatalf("turn not completed: %+v", stored.Turn)
	}
	if q := loadQueue(t, d, "qauto"); len(q) != 0 {
		t.Fatalf("queue not drained: %+v", q)
	}
}

func TestQueueNotDrainedOnCancel(t *testing.T) {
	d := testDaemon(t)
	msgArrived := make(chan struct{})
	var arrivedOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			_, _ = w.Write([]byte(`{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`))
			return
		}
		arrivedOnce.Do(func() { close(msgArrived) })
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done()
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(upstream.CloseClientConnections)
	d.config.GatewayURL = upstream.URL
	dir := t.TempDir()
	rec := &SessionRecord{ID: "qcancel", CWD: dir, Status: "idle", Model: "m", Options: SessionOptions{Access: "full"}}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	act, err := d.getOrCreateActiveSession("qcancel")
	if err != nil {
		t.Fatal(err)
	}
	queueAdd(t, d, "qcancel", "stays queued")
	done := make(chan struct{})
	go func() {
		d.runAgentTurn(act, "first turn", "m", true, nil)
		close(done)
	}()
	select {
	case <-msgArrived:
	case <-time.After(10 * time.Second):
		t.Fatal("model request never arrived")
	}
	time.Sleep(300 * time.Millisecond)
	d.cancelTurn("qcancel")
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("cancelled turn did not finish")
	}
	// A cancelled turn never drains: the item stays queued, no new turn.
	if q := loadQueue(t, d, "qcancel"); len(q) != 1 || q[0].Text != "stays queued" {
		t.Fatalf("cancel drained the queue: %+v", q)
	}
	stored, err := d.loadSession("qcancel")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Turn == nil || stored.Turn.Status != "cancelled" {
		t.Fatalf("turn not cancelled: %+v", stored.Turn)
	}
	if n := queueUserTurnCount(stored); n != 1 {
		t.Fatalf("queued item started after cancel: %d user turns", n)
	}
}
