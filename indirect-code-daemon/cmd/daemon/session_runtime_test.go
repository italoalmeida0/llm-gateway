package main

import (
	"context"
	"encoding/json"
	"fmt"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveChoicesApplyToNextRequestAndToolWithinSameTask(t *testing.T) {
	d := testDaemon(t)
	d.configPath = filepath.Join(d.dataDir, "config.json")
	cwd := t.TempDir()
	act := &ActiveSession{record: &SessionRecord{ID: "live", CWD: cwd, Model: "model-a", Options: SessionOptions{Mode: "build", Effort: "medium", Access: "full"}}}
	d.sessions["live"] = act
	configure := func(model, effort, mode, access string) {
		raw, _ := json.Marshal(map[string]any{"type": "configure_session", "sessionId": "live", "model": model, "options": SessionOptions{Effort: effort, Mode: mode, Access: access}})
		d.handleMessage(raw)
	}
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			fmt.Fprint(w, `{"models":[{"id":"model-a","limit":{"context":100000,"output":4096}},{"id":"model-b","limit":{"context":200000,"output":8192}}]}`)
			return
		}
		if r.URL.Path != "/anthropic/v1/messages" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		var req struct {
			Model  string `json:"model"`
			Max    int    `json:"max_tokens"`
			System string `json:"system"`
			Tools  []struct {
				Name string `json:"name"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		step := calls.Add(1)
		hasWrite := false
		for _, tool := range req.Tools {
			if tool.Name == "write" {
				hasWrite = true
			}
		}
		// The Anthropic wire carries no reasoning-effort knob; effort stays a
		// daemon-side option and is not asserted here.
		model, mode, maxTokens := "model-a", "Build", 4096
		switch step {
		case 2:
			model, mode, maxTokens = "model-b", "Plan", 8192
		case 3:
			mode = "patient Socratic"
		}
		if req.Model != model || req.Max != maxTokens || !strings.Contains(req.System, mode) || hasWrite != (step == 1 || step == 4) {
			t.Errorf("request %d: model=%s max=%d write=%t system=%s", step, req.Model, req.Max, hasWrite, req.System)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		emit := func(event string, payload any) {
			b, _ := json.Marshal(payload)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		}
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"model": req.Model, "usage": map[string]any{"input_tokens": 100}}})
		toolUse := func(index int, id, name, args string) {
			emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": name}})
			emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}})
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		}
		text := func(index int, s string) {
			emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "text", "text": ""}})
			emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "text_delta", "text": s}})
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		}
		stop := func(reason string) {
			emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason}, "usage": map[string]any{"output_tokens": 10}})
			emit("message_stop", map[string]any{"type": "message_stop"})
		}
		switch step {
		case 1:
			toolUse(0, "shell", "bash", `{"command":"printf started > started; while [ ! -e release ]; do sleep 0.01; done; printf done"}`)
			toolUse(1, "blocked", "write", `{"path":"must-not-exist","content":"no"}`)
			stop("tool_use")
		case 2:
			toolUse(0, "read", "read", `{"path":"started"}`)
			stop("tool_use")
		case 3:
			configure("model-a", "low", "build", "full")
			toolUse(0, "read-again", "read", `{"path":"started"}`)
			stop("tool_use")
		default:
			text(0, "Done")
			stop("end_turn")
		}
	}))
	defer upstream.Close()
	d.config.GatewayURL = upstream.URL
	done := make(chan struct{})
	go func() { defer close(done); d.runAgentTurn(act, "Inspect", "model-a", true, nil) }()
	defer func() {
		act.mu.Lock()
		if act.cancel != nil {
			act.cancel()
		}
		act.mu.Unlock()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("task did not stop")
		}
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(cwd, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shell did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	configure("model-b", "low", "plan", "ask")
	if err := os.WriteFile(filepath.Join(cwd, "release"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	waitApproval(t, act, "read")
	if _, err := os.Stat(filepath.Join(cwd, "must-not-exist")); !os.IsNotExist(err) {
		t.Fatal("write ran after switching to Plan")
	}
	configure("model-a", "high", "learning", "full")
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("task timed out")
	}
	if calls.Load() != 4 {
		t.Fatalf("got %d requests", calls.Load())
	}
	rec, err := d.loadSession("live")
	if err != nil || rec.Options.Mode != "build" || rec.Options.Effort != "low" || rec.Model != "model-a" {
		t.Fatal("final choices overwritten")
	}
}

func TestSwitchingModeRejectsAnAlreadyPendingWrite(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "pending", Options: SessionOptions{Mode: "build", Access: "ask"}}, gen: 1}
	d.sessions["pending"] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan bool, 1)
	go func() {
		allowed, _, _ := d.toolApprovalHook(ctx, act, 1, d.config.HostID)(provider.ToolCallBlock{ID: "write", Name: "write"})
		result <- allowed
	}()
	waitApproval(t, act, "write")
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"pending","options":{"mode":"plan","access":"full"}}`))
	select {
	case allowed := <-result:
		if allowed {
			t.Fatal("pending write ran after mode change")
		}
	case <-time.After(time.Second):
		t.Fatal("pending write unresolved")
	}
}

func TestListSessionSummariesSkipsGhosts(t *testing.T) {
	d := testDaemon(t)
	dir := filepath.Join(d.dataDir, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Healthy session: listed.
	write("sess_ok.json", `{"id":"sess_ok","cwd":"/tmp","title":"Hi","createdAt":1,"updatedAt":2}`)
	// Turn-journal sidecar: valid JSON, no session fields — must never
	// appear as a blank sidebar row.
	write("sess_old.turn.json", `{"turnIndex":3,"startedAt":1,"model":"m"}`)
	// Valid JSON but no id: ghost (blank row, unopenable).
	write("empty.json", `{}`)
	// Content id does not match the filename: loadSession(id+".json")
	// would fail, so listing it only produces "Session not found".
	write("stale.json", `{"id":"sess_other","title":"Ghost"}`)
	// Corrupt JSON: skipped as before.
	write("broken.json", `{"id":`)

	got := d.listSessionSummaries()
	if len(got) != 1 || got[0].ID != "sess_ok" {
		ids := make([]string, 0, len(got))
		for _, s := range got {
			ids = append(ids, s.ID)
		}
		t.Fatalf("want only [sess_ok], got %v", ids)
	}
}
