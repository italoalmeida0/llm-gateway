package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

func testDaemon(t *testing.T) *DaemonServer {
	t.Helper()
	d := &DaemonServer{dataDir: t.TempDir(), config: &DaemonConfig{HostID: "host-test", Settings: ZotSettings{NoAutoTitle: true, Reasoning: "high", Temperature: 0.4}}, sessions: map[string]*ActiveSession{}}
	t.Cleanup(func() {
		d.pingMu.Lock()
		defer d.pingMu.Unlock()
		for _, timer := range d.pingTimers {
			timer.Stop()
		}
	})
	return d
}

type titleClient struct {
	hook    func(provider.Request)
	failure bool
}

func (titleClient) Name() string { return "openai" }
func (c titleClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	if c.hook != nil {
		c.hook(req)
	}
	events := make(chan provider.Event, 3)
	events <- provider.EventTextDelta{Delta: "Corrigir Interface"}
	done := provider.EventDone{Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Corrigir Interface"}}}}
	if c.failure {
		done.Err = fmt.Errorf("upstream failed")
	}
	events <- done
	close(events)
	return events, nil
}

func TestAutoTitleShortPromptAndManualRename(t *testing.T) {
	for _, scenario := range []string{"short", "manual", "deleted", "failed"} {
		t.Run(scenario, func(t *testing.T) {
			d := testDaemon(t)
			rec := &SessionRecord{ID: "s", Title: "oi", TitleSource: "pending", Messages: []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "oi"}}}}}
			act := &ActiveSession{record: rec, gen: 1}
			d.sessions[rec.ID] = act
			if err := d.saveSession(rec); err != nil {
				t.Fatal(err)
			}
			client := titleClient{failure: scenario == "failed", hook: func(req provider.Request) {
				if req.MaxTokens < 1024 {
					t.Error("title request starves reasoning models")
				}
				if scenario == "manual" {
					act.mu.Lock()
					rec.Title = "Meu título…"
					rec.TitleSource = "manual"
					act.mu.Unlock()
				}
				if scenario == "deleted" {
					d.purgeSession(rec.ID)
				}
			}}
			d.maybeAutoTitle(act, 1, client, "custom/alias")
			if scenario == "short" {
				stored, err := d.loadSession(rec.ID)
				if err != nil {
					t.Fatal(err)
				}
				if stored.Title != "Corrigir Interface" || stored.TitleSource != "generated" {
					t.Fatalf("title duplicated or not persisted: %+v", stored)
				}
			}
			if scenario == "manual" && rec.Title != "Meu título…" {
				t.Fatal("manual rename overwritten")
			}
			if scenario == "deleted" {
				if _, err := d.loadSession(rec.ID); !os.IsNotExist(err) {
					t.Fatal("deleted session resurrected")
				}
			}
			if scenario == "failed" && rec.Title != "oi" {
				t.Fatal("failed stream generated a title")
			}
		})
	}
}

func TestGatewayMetadataUnknownLimits(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/remote/models" || r.Header.Get("Authorization") != "Bearer test-daemon" {
			t.Error("wrong metadata endpoint/authentication")
		}
		fmt.Fprint(w, `{"models":[{"id":"custom/alias","limit":{"context":1024000,"output":16384},"reasoning_parameters":{"efforts":["low","high"]}},{"id":"gpt-4o","limit":{}}]}`)
	}))
	defer upstream.Close()
	model := gatewayModel(context.Background(), upstream.URL, "test-daemon", "custom/alias")
	if model.ContextWindow != 1024000 || model.MaxOutput != 16384 || !model.Reasoning {
		t.Fatalf("wrong configured metadata: %+v", model)
	}
	unknown := gatewayModel(context.Background(), upstream.URL, "test-daemon", "gpt-4o")
	if unknown.ContextWindow != 0 || unknown.MaxOutput != 0 {
		t.Fatal("guessed a built-in model limit")
	}
	u := provider.Usage{InputTokens: 400000, CacheReadTokens: 32000, OutputTokens: 500}
	if contextFromUsage(u, model).UsedTokens != 432500 {
		t.Fatal("wrong current context")
	}
}

func TestAgentTaskLifecycleReasoningAndPersistentUsage(t *testing.T) {
	d := testDaemon(t)
	var mu sync.Mutex
	var wire []map[string]any
	var normalCalls int
	upgrader := websocket.Upgrader{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			defer conn.Close()
			for {
				var msg map[string]any
				if conn.ReadJSON(&msg) != nil {
					return
				}
				mu.Lock()
				wire = append(wire, msg)
				mu.Unlock()
			}
		}
		if r.URL.Path == "/api/remote/models" {
			fmt.Fprint(w, `{"models":[{"id":"custom/alias","limit":{"context":1024000,"output":16384},"reasoning_parameters":{"efforts":["high"]}}]}`)
			return
		}
		var req struct {
			Reasoning   string  `json:"reasoning_effort"`
			MaxOutput   int     `json:"max_completion_tokens"`
			Temperature float64 `json:"temperature"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			t.Error("bad model request")
		}
		if req.Reasoning != "high" || req.MaxOutput != 16384 {
			t.Errorf("settings not forwarded: %+v", req)
		}
		mu.Lock()
		normalCalls++
		step := normalCalls
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		event := func(data any) { encoded, _ := json.Marshal(data); fmt.Fprintf(w, "data: %s\n\n", encoded) }
		event(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"reasoning": "Inspecting the workspace."}}}})
		if step%2 == 1 {
			args, _ := json.Marshal(map[string]any{"path": "hello.txt"})
			event(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": fmt.Sprintf("read-%d", step), "type": "function", "function": map[string]any{"name": "read", "arguments": string(args)}}}}, "finish_reason": "tool_calls"}}})
		} else {
			event(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": "The file is readable."}, "finish_reason": "stop"}}})
		}
		event(map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": 432000, "completion_tokens": 500, "prompt_tokens_details": map[string]any{"cached_tokens": 32000}}})
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	d.config.GatewayURL = upstream.URL
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstream.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	d.wsConn = conn
	defer conn.Close()
	cwd := t.TempDir()
	os.WriteFile(filepath.Join(cwd, "hello.txt"), []byte("hello"), 0600)
	rec := &SessionRecord{ID: "session", CWD: cwd, Title: "Manual", TitleSource: "manual", Model: "custom/alias", Status: "idle"}
	act := &ActiveSession{record: rec, approvalReqs: map[string]chan bool{}}
	d.sessions[rec.ID] = act
	d.runAgentTurn(act, "Read hello.txt", rec.Model, true, nil)
	stored, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Usage.OutputTokens != 1000 || stored.Context.UsedTokens != 432500 || stored.Context.WindowTokens != 1024000 {
		t.Fatalf("wrong persisted usage/context: %+v %+v", stored.Usage, stored.Context)
	}
	reasoning := false
	for _, m := range stored.Messages {
		for _, b := range m.Content {
			if r, ok := b.(provider.ReasoningBlock); ok && r.Summary != "" {
				reasoning = true
			}
		}
	}
	if !reasoning {
		t.Fatal("reasoning disappeared from persisted transcript")
	}
	d.runAgentTurn(act, "Read it again", rec.Model, true, nil)
	stored, err = d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Usage.OutputTokens != 2000 || stored.Context.UsedTokens != 432500 {
		t.Fatalf("context confused with cumulative usage: %+v", stored)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		idle := 0
		for _, msg := range wire {
			if msg["type"] == "session_status" && msg["status"] == "idle" {
				idle++
			}
		}
		mu.Unlock()
		if idle == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	idle, starts, thinking := 0, 0, 0
	for _, msg := range wire {
		if msg["type"] == "session_status" && msg["status"] == "idle" {
			idle++
		}
		if ev, ok := msg["event"].(map[string]any); ok {
			if ev["type"] == "assistant_start" {
				starts++
			}
			if ev["type"] == "reasoning_delta" {
				thinking++
			}
		}
	}
	if idle != 2 || starts != 4 || thinking != 4 {
		t.Fatalf("wrong task/step lifecycle: idle=%d starts=%d thinking=%d", idle, starts, thinking)
	}
}

func TestManualCompactPreservesHistoryUntilSummarySucceeds(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			d := testDaemon(t)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/remote/models" {
					fmt.Fprint(w, `{"models":[{"id":"alias","limit":{"context":1024000}}]}`)
					return
				}
				if fail {
					http.Error(w, "Unavailable", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"A summary preserving the project decisions.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer upstream.Close()
			d.config.GatewayURL = upstream.URL
			rec := &SessionRecord{ID: "compact", Model: "alias", Status: "idle", Usage: provider.Usage{OutputTokens: 1200}}
			for i := 0; i < 10; i++ {
				role := provider.RoleUser
				if i%2 == 1 {
					role = provider.RoleAssistant
				}
				rec.Messages = append(rec.Messages, provider.Message{Role: role, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Decision %d", i)}}})
			}
			act := &ActiveSession{record: rec}
			d.sessions[rec.ID] = act
			if err := d.saveSession(rec); err != nil {
				t.Fatal(err)
			}
			d.compactSession(act)
			saved, err := d.loadSession(rec.ID)
			if err != nil {
				t.Fatal(err)
			}
			if saved.Status != "idle" || saved.Usage.OutputTokens != 1200 {
				t.Fatal("compaction lost status or accumulated usage")
			}
			if fail {
				if len(saved.Messages) != 10 {
					t.Fatal("failed compaction discarded history")
				}
				return
			}
			if len(saved.Messages) != 8 || !strings.Contains(saved.Messages[0].Content[0].(provider.TextBlock).Text, "preserving the project decisions") {
				t.Fatal("history was dropped without a summary")
			}
			if saved.Context == nil || !saved.Context.Estimated || saved.Context.WindowTokens != 1024000 {
				t.Fatal("compacted context is not explicitly estimated from configured window")
			}
		})
	}
}

func TestDeletedSessionCannotStartQueuedTurn(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "removed", Status: "idle"}}
	d.runAgentTurn(act, "late queued prompt", "alias", true, nil)
	if _, err := d.loadSession("removed"); !os.IsNotExist(err) {
		t.Fatal("queued task resurrected deleted session")
	}
}

func TestLiveSnapshotReplaysReasoningAndIncompleteToolArguments(t *testing.T) {
	act := &ActiveSession{record: &SessionRecord{ID: "live", Status: "running"}}
	trackLiveEvent(act, core.EvAssistantStart{})
	trackLiveEvent(act, core.EvReasoningDelta{Delta: "Inspecting "})
	trackLiveEvent(act, core.EvReasoningDelta{Delta: "the workspace."})
	trackLiveEvent(act, core.EvTextDelta{Delta: "Opening the file."})
	trackLiveEvent(act, core.EvToolUseStart{ID: "call", Name: "read"})
	trackLiveEvent(act, core.EvToolUseArgs{ID: "call", Delta: `{"path":"hel`})
	snapshot := liveSessionPayload(act)
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("partial tool JSON broke reconnect: %v", err)
	}
	if !strings.Contains(string(data), "Inspecting the workspace.") || !strings.Contains(string(data), "Opening the file.") {
		t.Fatal("live content missing from reconnect snapshot")
	}
	trackLiveEvent(act, core.EvToolUseArgs{ID: "call", Delta: `lo.txt"}`})
	older, _ := json.Marshal(snapshot)
	if string(older) != string(data) {
		t.Fatal("later deltas mutated the snapshot being sent")
	}
	if len(act.record.Messages) != 0 {
		t.Fatal("partial tool arguments leaked into persistent transcript")
	}
	act.live = nil
	restored := liveSessionPayload(act)
	if restored["messages"] == nil {
		return
	}
	if len(restored["messages"].([]provider.Message)) != 0 {
		t.Fatal("completed assistant was replayed twice")
	}
}
