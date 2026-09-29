package core

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type loopFakeClient struct {
	attempts int
	loopKind string // "text" or "reasoning"
}

func (c *loopFakeClient) Name() string { return "loop-fake" }

func (c *loopFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	out := make(chan provider.Event, 50)
	c.attempts++
	attempt := c.attempts

	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "loop-fake", Model: req.Model}

		if attempt == 1 {
			// First attempt produces a repetition loop
			if c.loopKind == "reasoning" {
				unit := "Let me check the code carefully to make sure there are no remaining errors.\n"
				for range 4 {
					select {
					case <-ctx.Done():
						return
					case out <- provider.EventReasoningDelta{Delta: unit}:
					}
				}
			} else {
				unit := "Processing the current task step in the main pipeline...\n"
				for range 4 {
					select {
					case <-ctx.Done():
						return
					case out <- provider.EventTextDelta{Delta: unit}:
					}
				}
			}
			select {
			case <-ctx.Done():
				return
			case out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{Role: provider.RoleAssistant}}:
			}
		} else {
			// Second attempt produces clean output
			select {
			case <-ctx.Done():
				return
			case out <- provider.EventTextDelta{Delta: "All done cleanly!"}:
			}
			select {
			case <-ctx.Done():
				return
			case out <- provider.EventDone{
				Stop: provider.StopEnd,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{provider.TextBlock{Text: "All done cleanly!"}},
				},
			}:
			}
		}
	}()

	return out, nil
}

func TestAgentStreamTextRepetitionLoopRecovery(t *testing.T) {
	client := &loopFakeClient{loopKind: "text"}
	a := NewAgent(client, "test-model", "test-system", NewRegistry())
	a.RetrySchedule = []time.Duration{time.Millisecond}

	var events []AgentEvent
	sink := func(e AgentEvent) {
		events = append(events, e)
	}

	err := a.Prompt(context.Background(), "hello", nil, sink)
	if err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}

	if client.attempts != 2 {
		t.Fatalf("expected 2 attempts (1 loop + 1 retry), got %d", client.attempts)
	}

	// Verify the final message is the clean one
	messages := a.Messages()
	if len(messages) != 2 { // 1 user + 1 assistant
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	text := extractText(messages[1])
	if text != "All done cleanly!" {
		t.Fatalf("expected clean assistant text, got %q", text)
	}
}

func TestAgentStreamReasoningRepetitionLoopRecovery(t *testing.T) {
	client := &loopFakeClient{loopKind: "reasoning"}
	a := NewAgent(client, "test-model", "test-system", NewRegistry())
	a.RetrySchedule = []time.Duration{time.Millisecond}

	var events []AgentEvent
	sink := func(e AgentEvent) {
		events = append(events, e)
	}

	err := a.Prompt(context.Background(), "hello", nil, sink)
	if err != nil {
		t.Fatalf("Prompt failed: %v", err)
	}

	if client.attempts != 2 {
		t.Fatalf("expected 2 attempts (1 loop + 1 retry), got %d", client.attempts)
	}

	messages := a.Messages()
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	text := extractText(messages[1])
	if text != "All done cleanly!" {
		t.Fatalf("expected clean assistant text, got %q", text)
	}
}

type loopDummyTool struct{}

func (d *loopDummyTool) Name() string            { return "dummy" }
func (d *loopDummyTool) Description() string     { return "dummy tool" }
func (d *loopDummyTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (d *loopDummyTool) Execute(ctx context.Context, raw json.RawMessage, p func(string)) (ToolResult, error) {
	return ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "output"}},
	}, nil
}

func TestAgentToolCallLoopPrevention(t *testing.T) {
	registry := Registry{"dummy": &loopDummyTool{}}

	a := NewAgent(nil, "m", "s", registry)
	call := provider.ToolCallBlock{
		ID:        "call_1",
		Name:      "dummy",
		Arguments: json.RawMessage(`{"file":"main.go"}`),
	}

	// 1st call: normal execution
	res1 := a.runOneTool(context.Background(), call, func(AgentEvent) {})
	if res1.IsError {
		t.Fatalf("call 1 should not error: %v", res1)
	}

	// 2nd call: normal execution
	res2 := a.runOneTool(context.Background(), call, func(AgentEvent) {})
	if res2.IsError {
		t.Fatalf("call 2 should not error: %v", res2)
	}

	// 3rd call: loop prevention triggers!
	res3 := a.runOneTool(context.Background(), call, func(AgentEvent) {})
	if !res3.IsError {
		t.Fatalf("call 3 should trigger loop prevention error")
	}
	text := ""
	for _, c := range res3.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text += tb.Text
		}
	}
	if !strings.Contains(text, "Loop prevention") {
		t.Fatalf("expected Loop prevention message, got: %s", text)
	}
}
