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
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func testDaemon(t *testing.T) *DaemonServer {
	t.Helper()
	d := &DaemonServer{dataDir: t.TempDir(), config: &DaemonConfig{HostID: "host-test", Settings: HarnessSettings{NoAutoTitle: true, Reasoning: "high", Temperature: 0.4}}, sessions: map[string]*ActiveSession{}}
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
	events <- provider.EventTextDelta{Delta: "Fix Interface"}
	done := provider.EventDone{Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Fix Interface"}}}}
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
			rec := &SessionRecord{ID: "s", Title: "hi", TitleSource: "pending", Messages: []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}}}}
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
					rec.Title = "My title…"
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
				if stored.Title != "Fix Interface" || stored.TitleSource != "generated" {
					t.Fatalf("title duplicated or not persisted: %+v", stored)
				}
			}
			if scenario == "manual" && rec.Title != "My title…" {
				t.Fatal("manual rename overwritten")
			}
			if scenario == "deleted" {
				if _, err := d.loadSession(rec.ID); !os.IsNotExist(err) {
					t.Fatal("deleted session resurrected")
				}
			}
			if scenario == "failed" && rec.Title != "hi" {
				t.Fatal("failed stream generated a title")
			}
		})
	}
}

func TestGatewayMetadataUnknownLimits(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/indirect-code/models" || r.Header.Get("Authorization") != "Bearer test-daemon" {
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
	fallback := gatewayModel(context.Background(), upstream.URL, "test-daemon", "removed/model")
	if fallback.ID != "custom/alias" || fallback.ContextWindow != 1024000 {
		t.Fatal("removed model did not fall back to first catalog entry")
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
				if msg["type"] == "question_request" {
					question := msg["question"].(map[string]any)
					reply, _ := json.Marshal(map[string]any{"type": "question_response", "sessionId": msg["sessionId"], "questionId": question["id"], "answers": [][]string{{"Continue"}}})
					d.handleMessage(reply)
				}
			}
		}
		if r.URL.Path == "/api/indirect-code/models" {
			fmt.Fprint(w, `{"models":[{"id":"custom/alias","limit":{"context":1024000,"output":16384},"reasoning_parameters":{"efforts":["high"]}}]}`)
			return
		}
		if r.URL.Path != "/anthropic/v1/messages" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		var req struct {
			MaxTokens int `json:"max_tokens"`
		}
		if json.NewDecoder(r.Body).Decode(&req) != nil {
			t.Error("bad model request")
		}
		// The Anthropic wire carries no reasoning-effort knob; effort stays a
		// daemon-side option. Only the output budget is asserted on the wire.
		if req.MaxTokens != 16384 {
			t.Errorf("settings not forwarded: %+v", req)
		}
		mu.Lock()
		normalCalls++
		step := normalCalls
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		emit := func(event string, data any) {
			encoded, _ := json.Marshal(data)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, encoded)
		}
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"model": "custom/alias", "usage": map[string]any{"input_tokens": 400000, "cache_read_input_tokens": 32000}}})
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "thinking", "thinking": ""}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "thinking_delta", "thinking": "Inspecting the workspace."}})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		text := func(index int, s string) {
			emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "text", "text": ""}})
			emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "text_delta", "text": s}})
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		}
		toolUse := func(index int, id, name, args string) {
			emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": name, "input": map[string]any{}}})
			emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}})
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		}
		if step%2 == 1 {
			text(1, "I will read the file now.")
			args, _ := json.Marshal(map[string]any{"path": "hello.txt"})
			toolUse(2, fmt.Sprintf("read-%d", step), "read", string(args))
			toolUse(3, fmt.Sprintf("todo-%d", step), "todo", `{"items":[{"id":"read","text":"Read hello.txt","status":"completed"}]}`)
			toolUse(4, fmt.Sprintf("question-%d", step), "question", `{"questions":[{"header":"Next step","question":"How should I proceed?","options":[{"label":"Continue"}]}]}`)
			toolUse(5, fmt.Sprintf("complete-%d", step), "mark_task_as_complete", `{"notes":"done"}`)
			emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]any{"output_tokens": 500}})
		} else {
			text(1, "The file is readable.")
			emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}, "usage": map[string]any{"output_tokens": 500}})
		}
		emit("message_stop", map[string]any{"type": "message_stop"})
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
	rec := &SessionRecord{ID: "session", CWD: cwd, Title: "Manual", TitleSource: "manual", Model: "custom/alias", Status: "idle", Options: SessionOptions{Effort: "high"}}
	act := &ActiveSession{record: rec, approvalReqs: map[string]chan bool{}}
	d.sessions[rec.ID] = act
	d.runAgentTurn(act, "Read hello.txt", rec.Model, true, nil)
	stored, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Todos) != 1 || stored.Todos[0].Status != "completed" {
		t.Fatal("todo tool did not persist the visible checklist")
	}
	answered := false
	timed := false
	for _, message := range stored.Messages {
		for _, block := range message.Content {
			if result, ok := block.(provider.ToolResultBlock); ok && result.CallID == "read-1" {
				timed = result.StartedAt > 0 && result.DurationMs >= 0
			}
			if result, ok := block.(provider.ToolResultBlock); ok && result.CallID == "question-1" {
				answered = !result.IsError && len(result.Content) == 1 && result.Content[0].(provider.TextBlock).Text == `{"answers":[["Continue"]]}`
			}
		}
	}
	if !answered {
		t.Fatal("question answers did not persist in the model's transcript")
	}
	if !timed {
		t.Fatal("tool timing did not survive persistence and hydration")
	}
	if stored.Usage.OutputTokens != 1000 || stored.Context.UsedTokens != 432500 || stored.Context.WindowTokens != 1024000 {
		t.Fatalf("wrong persisted usage/context: %+v %+v", stored.Usage, stored.Context)
	}
	reasoning := false
	for _, m := range stored.Messages {
		for _, b := range m.Content {
			if r, ok := b.(provider.ReasoningBlock); ok && r.Summary != "" {
				reasoning = true
				if m.Meta["thinking_ms"] == "" {
					t.Error("thinking duration not persisted")
				}
			}
		}
	}
	if !reasoning {
		t.Fatal("reasoning disappeared from persisted transcript")
	}
	if stored.Turn == nil || stored.Turn.Status != "completed" || stored.Turn.EndedAt < stored.Turn.StartedAt {
		t.Fatal("turn timer did not survive persistence")
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
	idle, starts, thinking, assistantMessages := 0, 0, 0, 0
	for _, msg := range wire {
		if msg["type"] == "session_status" && msg["status"] == "idle" {
			idle++
		}
		if ev, ok := msg["event"].(map[string]any); ok {
			if ev["type"] == "assistant_message" {
				assistantMessages++
			}
			if ev["type"] == "assistant_start" {
				starts++
			}
			if ev["type"] == "reasoning_delta" {
				thinking++
			}
		}
	}
	if idle != 2 || starts != 4 || thinking != 4 || assistantMessages != 4 {
		t.Fatalf("wrong task/step lifecycle: idle=%d starts=%d thinking=%d", idle, starts, thinking)
	}
}

func TestManualCompactPreservesHistoryUntilSummarySucceeds(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			d := testDaemon(t)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/indirect-code/models" {
					fmt.Fprint(w, `{"models":[{"id":"alias","limit":{"context":1024000}}]}`)
					return
				}
				if fail {
					http.Error(w, "Unavailable", http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"alias\",\"usage\":{\"input_tokens\":0}}}\n\n")
				fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
				fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"A summary preserving the project decisions.\"}}\n\n")
				fmt.Fprint(w, "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
				fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":0}}\n\n")
				fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
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
			// Non-destructive history + projection: manual
			// compaction advances the chain head; the on-disk record keeps
			// the FULL history. The compacted view is derived.
			if len(saved.Messages) != 10 {
				t.Fatalf("history must survive compaction, got %d messages", len(saved.Messages))
			}
			if saved.Compaction == nil || !strings.Contains(saved.Compaction.PreviousSummary, "preserving the project decisions") {
				t.Fatalf("chain head missing or summary wrong: %+v", saved.Compaction)
			}
			if saved.Compaction.KeepFrom < 1 || saved.Compaction.KeepFrom > 3 {
				t.Fatalf("keep-tail ~70%% of 10 messages => anchor 1..3, got %d", saved.Compaction.KeepFrom)
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
	trackLiveEvent(act, core.EvToolProgress{ID: "call", Text: "first line\n"})
	snapshot := liveSessionPayload(act)
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("partial tool JSON broke reconnect: %v", err)
	}
	if !strings.Contains(string(data), "Inspecting the workspace.") || !strings.Contains(string(data), "Opening the file.") {
		t.Fatal("live content missing from reconnect snapshot")
	}
	trackLiveEvent(act, core.EvToolUseArgs{ID: "call", Delta: `lo.txt"}`})
	trackLiveEvent(act, core.EvToolProgress{ID: "call", Text: "second line\n"})
	if liveSessionPayload(act)["toolProgress"].(map[string]string)["call"] != "first line\nsecond line\n" {
		t.Fatal("reconnect lost accumulated tool output")
	}
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
