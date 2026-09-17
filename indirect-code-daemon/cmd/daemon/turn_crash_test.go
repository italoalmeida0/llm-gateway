package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// A real process boundary: kill while the next provider request is in flight,
// then recover the same WAL in a fresh process.
func TestDaemonProcessCrashRecoversSameTurn(t *testing.T) {
	dataDir, cwd := t.TempDir(), t.TempDir()
	var calls atomic.Int32
	waiting := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			fmt.Fprint(w, `{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`)
			return
		}
		n := calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 2 {
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			close(waiting)
			<-r.Context().Done()
			return
		}
		emit := func(event string, payload any) {
			b, _ := json.Marshal(payload)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		}
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"model": "m", "usage": map[string]int{"input_tokens": 1}}})
		name, args := "mark_task_as_complete", `{"notes":"Recovered"}`
		if n == 1 {
			name, args = "write", `{"path":"created.txt","content":"saved before crash"}`
		}
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": fmt.Sprintf("call-%d", n), "name": name, "input": map[string]any{}}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]int{"output_tokens": 1}})
		emit("message_stop", map[string]any{"type": "message_stop"})
	}))
	defer upstream.Close()
	defer upstream.CloseClientConnections()
	worker := func() (*exec.Cmd, context.CancelFunc) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestTurnCrashWorker$")
		cmd.Env = append(os.Environ(), "TURN_CRASH_DATA="+dataDir, "TURN_CRASH_CWD="+cwd, "TURN_CRASH_UPSTREAM="+upstream.URL)
		return cmd, cancel
	}
	first, cancelFirst := worker()
	defer cancelFirst()
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	defer first.Process.Kill()
	select {
	case <-waiting:
	case <-time.After(10 * time.Second):
		t.Fatal("worker never reached the second request")
	}
	observer := testDaemon(t)
	observer.dataDir = dataDir
	before, err := observer.loadSession("crash")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	header, herr := observer.readWALHeader("crash")
	if herr != nil || header == nil || header.TurnIndex != 1 {
		t.Fatalf("crash WAL header was not durable: %v", herr)
	}
	fused, _, ferr := observer.loadSessionFused("crash")
	if ferr != nil || len(walLatestIncoming(mustReadWAL(t, observer, "crash"), header.Incoming)) != 1 {
		t.Fatalf("original file snapshot was not durable: %v", ferr)
	}
	_ = fused
	second, cancelSecond := worker()
	defer cancelSecond()
	if out, err := second.CombinedOutput(); err != nil {
		t.Fatalf("recovery process failed: %v\n%s", err, out)
	}
	after, err := observer.loadSession("crash")
	if err != nil {
		t.Fatal(err)
	}
	if after.TurnSeq != 1 || after.Turn.StartedAt != before.Turn.StartedAt || after.Turn.Status != "completed" {
		t.Fatalf("recovery changed turn identity: %+v", after.Turn)
	}
	if len(after.FileBalloons) != 1 || after.FileBalloons[0].TurnIndex != 1 || len(after.FileBalloons[0].Files) != 1 || after.FileBalloons[0].Files[0].Status != "new" {
		t.Fatal("crash lost the turn's file changes")
	}
	if calls.Load() != 3 {
		t.Fatalf("unexpected repeated work: %d requests", calls.Load())
	}
	users := 0
	for _, m := range after.Messages {
		if m.Role == "user" {
			users++
		}
		if m.TurnIndex != 1 {
			t.Fatal("recovery split the turn")
		}
	}
	if users != 1 {
		t.Fatalf("opening user message repeated %d times", users)
	}
	if data, err := os.ReadFile(filepath.Join(cwd, "created.txt")); err != nil || string(data) != "saved before crash" {
		t.Fatal("file contents lost")
	}
}

func mustReadWAL(t *testing.T, d *DaemonServer, sid string) []byte {
	t.Helper()
	data, err := os.ReadFile(d.walPath(sid))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestTurnCrashWorker(t *testing.T) {
	dataDir := os.Getenv("TURN_CRASH_DATA")
	if dataDir == "" {
		t.Skip("subprocess helper")
	}
	d := testDaemon(t)
	d.dataDir = dataDir
	d.config.GatewayURL = os.Getenv("TURN_CRASH_UPSTREAM")
	rec, err := d.loadSession("crash")
	if err != nil {
		rec = &SessionRecord{ID: "crash", CWD: os.Getenv("TURN_CRASH_CWD"), Model: "m", Status: "idle", Options: SessionOptions{Mode: "build", Access: "full"}}
		act := &ActiveSession{record: rec}
		d.sessions[rec.ID] = act
		d.runAgentTurn(act, "Create the file", "m", true, nil)
	} else {
		act := &ActiveSession{record: rec}
		d.sessions[rec.ID] = act
		header, herr := d.readWALHeader(rec.ID)
		if herr != nil || header == nil {
			t.Fatal("missing crash WAL")
		}
		fused, _, ferr := d.loadSessionFused(rec.ID)
		if ferr != nil {
			t.Fatal(ferr)
		}
		act.record = fused
		resumeHeader := cloneWALHeader(header)
		resumeHeader.Incoming = walLatestIncoming(mustReadWAL(t, d, rec.ID), header.Incoming)
		d.resumeAgentTurn(act, resumeHeader)
	}
}
