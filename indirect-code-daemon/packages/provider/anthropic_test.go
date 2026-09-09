package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicBuildRequest(t *testing.T) {
	c := NewGatewayAnthropic("gw_key", "http://gw/anthropic/v1", Model{ID: "m"}).(*anthropicClient)
	temp := float32(0.5)
	wire, err := c.buildRequest(Request{
		Model:       "m",
		System:      "sys",
		Temperature: &temp,
		MaxTokens:   512,
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}},
			{Role: RoleAssistant, Content: []Content{
				TextBlock{Text: "calling"},
				ToolCallBlock{ID: "tu1", Name: "read", Arguments: json.RawMessage(`{"path":"a"}`)},
			}},
			{Role: RoleTool, Content: []Content{
				ToolResultBlock{CallID: "tu1", Content: []Content{TextBlock{Text: "file!"}}},
			}},
		},
		Tools: []Tool{{Name: "read", Description: "read", Schema: json.RawMessage(`{"type":"object"}`)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !wire.Stream {
		t.Fatal("stream must be true")
	}
	if wire.MaxTokens != 512 {
		t.Fatalf("max_tokens=%d", wire.MaxTokens)
	}
	if wire.System != "sys" {
		t.Fatalf("system=%q", wire.System)
	}
	if len(wire.Messages) != 3 {
		t.Fatalf("messages=%d want 3", len(wire.Messages))
	}
	asst, _ := json.Marshal(wire.Messages[1].Content)
	if !strings.Contains(string(asst), `"tool_use"`) || !strings.Contains(string(asst), `"tu1"`) {
		t.Fatalf("assistant blocks=%s", asst)
	}
	tool, _ := json.Marshal(wire.Messages[2].Content)
	if !strings.Contains(string(tool), `"tool_result"`) {
		t.Fatalf("tool blocks=%s", tool)
	}
	if len(wire.Tools) != 1 || wire.Tools[0].Name != "read" {
		t.Fatalf("tools=%+v", wire.Tools)
	}
}

func TestAnthropicHeadersAndPath(t *testing.T) {
	var path, key, ver string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, key, ver = r.URL.Path, r.Header.Get("x-api-key"), r.Header.Get("anthropic-version")
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte("event: message_stop\ndata: {}\n\n"))
	}))
	defer srv.Close()

	c := NewGatewayAnthropic("gw_secret", srv.URL, Model{ID: "m"})
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	for range evs {
	}
	if path != "/messages" {
		t.Fatalf("path=%q", path)
	}
	if key != "gw_secret" {
		t.Fatalf("x-api-key=%q", key)
	}
	if ver == "" {
		t.Fatal("anthropic-version missing")
	}
	if c.Name() != "anthropic" {
		t.Fatalf("name=%q", c.Name())
	}
}

func TestAnthropicStreamHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":12,\"cache_read_input_tokens\":4,\"cache_creation_input_tokens\":2}}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hel\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tu1\",\"name\":\"read\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a\\\"}\"}}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	var starts, ends int
	var done EventDone
	var usage Usage
	for ev := range evs {
		switch e := ev.(type) {
		case EventTextDelta:
			text += e.Delta
		case EventToolStart:
			starts++
			if e.ID != "tu1" || e.Name != "read" {
				t.Fatalf("tool start=%+v", e)
			}
		case EventToolEnd:
			ends++
		case EventUsage:
			usage = e.Usage
		case EventDone:
			done = e
		}
	}
	if text != "hello" {
		t.Fatalf("text=%q", text)
	}
	if starts != 1 || ends != 1 {
		t.Fatalf("starts=%d ends=%d", starts, ends)
	}
	if done.Stop != StopToolUse {
		t.Fatalf("stop=%v", done.Stop)
	}
	if len(done.Message.Content) != 2 {
		t.Fatalf("content blocks=%d", len(done.Message.Content))
	}
	if tc, ok := done.Message.Content[1].(ToolCallBlock); !ok || tc.ID != "tu1" || string(tc.Arguments) != `{"path":"a"}` {
		t.Fatalf("tool call=%+v", done.Message.Content[1])
	}
	if usage.InputTokens != 12 || usage.OutputTokens != 9 || usage.CacheReadTokens != 4 || usage.CacheWriteTokens != 2 {
		t.Fatalf("usage=%+v", usage)
	}
}

func TestAnthropicRedactedThinkingRoundTrip(t *testing.T) {
	const blob = "Q-PaDgFwOh2-a9QtXVxufcTIhYxZYEDDmu2n2cDsKwkH"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = w.Write([]byte(s))
			if fl != nil {
				fl.Flush()
			}
		}
		write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":10}}}\n\n")
		// Encrypted thinking arrives whole in content_block_start (no deltas).
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"" + blob + "\"}}\n\n")
		write("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n")
		write("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Entendido\"}}\n\n")
		write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n")
		write("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	evs, err := c.Stream(context.Background(), Request{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	var done EventDone
	for ev := range evs {
		if e, ok := ev.(EventDone); ok {
			done = e
		}
	}
	if len(done.Message.Content) != 2 {
		t.Fatalf("content blocks=%d want 2 (redacted + text)", len(done.Message.Content))
	}
	rb, ok := done.Message.Content[0].(ReasoningBlock)
	if !ok || rb.Encrypted != blob {
		t.Fatalf("first block=%+v want ReasoningBlock with blob", done.Message.Content[0])
	}
	if tb, ok := done.Message.Content[1].(TextBlock); !ok || tb.Text != "Entendido" {
		t.Fatalf("second block=%+v", done.Message.Content[1])
	}

	// Replay: the next turn must carry the blob verbatim, in position.
	ac := c.(*anthropicClient)
	wire, err := ac.buildRequest(Request{
		Model: "m",
		Messages: []Message{
			{Role: RoleUser, Content: []Content{TextBlock{Text: "Escolha uma palavra secreta."}}},
			done.Message,
			{Role: RoleUser, Content: []Content{TextBlock{Text: "Qual foi?"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(wire.Messages[1].Content)
	var blocks []struct {
		Type string `json:"type"`
		Data string `json:"data"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].Type != "redacted_thinking" || blocks[0].Data != blob {
		t.Fatalf("replayed blocks=%s", raw)
	}
	if blocks[1].Type != "text" || blocks[1].Text != "Entendido" {
		t.Fatalf("replayed blocks=%s", raw)
	}
}

func TestAnthropicErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"bad"}}`))
	}))
	defer srv.Close()

	c := NewAnthropic("x", srv.URL)
	_, err := c.Stream(context.Background(), Request{Model: "m"})
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want 401 err, got %v", err)
	}
}
