package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/patriceckhart/zot/packages/provider"
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
		if r.URL.Path == "/api/remote/models" {
			fmt.Fprint(w, `{"models":[{"id":"model-a","limit":{"context":100000,"output":4096}},{"id":"model-b","limit":{"context":200000,"output":8192}}]}`)
			return
		}
		var req struct {
			Model    string `json:"model"`
			Effort   string `json:"reasoning_effort"`
			Max      int    `json:"max_completion_tokens"`
			Messages []struct {
				Content any `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
			return
		}
		step := calls.Add(1)
		hasWrite := false
		for _, tool := range req.Tools {
			if tool.Function.Name == "write" {
				hasWrite = true
			}
		}
		model, effort, mode, maxTokens := "model-a", "medium", "Build", 4096
		switch step {
		case 2:
			model, effort, mode, maxTokens = "model-b", "low", "Plan", 8192
		case 3:
			effort, mode = "high", "patient Socratic"
		case 4:
			effort = "low"
		}
		system, _ := req.Messages[0].Content.(string)
		if req.Model != model || req.Effort != effort || req.Max != maxTokens || !strings.Contains(system, mode) || hasWrite != (step == 1 || step == 4) {
			t.Errorf("request %d: model=%s effort=%s max=%d write=%t system=%s", step, req.Model, req.Effort, req.Max, hasWrite, system)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(delta any, finish string) {
			b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
			fmt.Fprintf(w, "data: %s\n\n", b)
		}
		tool := func(index int, id, name, args string) any {
			return map[string]any{"index": index, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}
		}
		switch step {
		case 1:
			event(map[string]any{"tool_calls": []any{tool(0, "shell", "bash", `{"command":"printf started > started; while [ ! -e release ]; do sleep 0.01; done; printf done"}`), tool(1, "blocked", "write", `{"path":"must-not-exist","content":"no"}`)}}, "tool_calls")
		case 2:
			event(map[string]any{"tool_calls": []any{tool(0, "read", "read", `{"path":"started"}`)}}, "tool_calls")
		case 3:
			configure("model-a", "low", "build", "full")
			event(map[string]any{"tool_calls": []any{tool(0, "read-again", "read", `{"path":"started"}`)}}, "tool_calls")
		default:
			event(map[string]any{"content": "Done"}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
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
