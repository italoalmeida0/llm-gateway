package core

import (
	"context"
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type dummyTool struct {
	name string
}

func (d *dummyTool) Name() string            { return d.name }
func (d *dummyTool) Description() string     { return d.name }
func (d *dummyTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (d *dummyTool) Execute(ctx context.Context, raw json.RawMessage, p func(string)) (ToolResult, error) {
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "ok"}}}, nil
}

type scriptedClient struct {
	responses [][]provider.Event
	callIdx   int
}

func (s *scriptedClient) Name() string { return "scripted" }
func (s *scriptedClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	ch := make(chan provider.Event, len(s.responses[s.callIdx]))
	for _, ev := range s.responses[s.callIdx] {
		ch <- ev
	}
	close(ch)
	s.callIdx++
	return ch, nil
}

func TestNoCompletionToolNoNudge(t *testing.T) {
	// In talk mode or when no completion tool is registered, text ends turn immediately.
	client := &scriptedClient{
		responses: [][]provider.Event{
			{
				provider.EventTextDelta{Delta: "Chatting here."},
				provider.EventDone{
					Stop: provider.StopEnd,
					Message: provider.Message{
						Role:    provider.RoleAssistant,
						Content: []provider.Content{provider.TextBlock{Text: "Chatting here."}},
					},
				},
			},
		},
	}

	tools := NewRegistry(&dummyTool{name: "read"})
	agent := NewAgent(client, "test-model", "system", tools)

	err := agent.Continue(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msgs := agent.History()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (no nudge), got %d", len(msgs))
	}
}

func TestMaxCompletionNudgesCap(t *testing.T) {
	// Model returns text 4 times without ever calling tool.
	// Cap is maxCompletionNudges (3), so after 3 nudges (total 4 model calls), it terminates.
	makeMsg := func(txt string) []provider.Event {
		return []provider.Event{
			provider.EventTextDelta{Delta: txt},
			provider.EventDone{
				Stop: provider.StopEnd,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{provider.TextBlock{Text: txt}},
				},
			},
		}
	}
	client := &scriptedClient{
		responses: [][]provider.Event{
			makeMsg("attempt 1"),
			makeMsg("attempt 2"),
			makeMsg("attempt 3"),
			makeMsg("attempt 4"),
		},
	}

	tools := NewRegistry(&dummyTool{name: "mark_task_as_complete"})
	agent := NewAgent(client, "test-model", "system", tools)

	err := agent.Continue(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if client.callIdx != 4 {
		t.Fatalf("expected exactly 4 calls (1 original + 3 nudges), got %d", client.callIdx)
	}
}
