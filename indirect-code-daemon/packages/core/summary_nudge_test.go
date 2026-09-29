package core

import (
	"context"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestStripIntermediateAssistantText(t *testing.T) {
	msgs := []provider.Message{
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.TextBlock{Text: "I am about to read the file."},
				provider.ToolCallBlock{ID: "call_1", Name: "read"},
			},
		},
	}
	cleaned := stripIntermediateAssistantText(msgs)
	if len(cleaned[0].Content) != 1 {
		t.Fatalf("expected 1 block, got %d", len(cleaned[0].Content))
	}
	if tc, ok := cleaned[0].Content[0].(provider.ToolCallBlock); !ok || tc.Name != "read" {
		t.Fatalf("expected ToolCallBlock for read, got %+v", cleaned[0].Content[0])
	}
}

func TestStripIntermediateAssistantTextStandalone(t *testing.T) {
	msgs := []provider.Message{
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "Fix the bug"}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "Boa, tenho artefatos ricos. Vou montar um plano..."}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.ToolCallBlock{ID: "call_1", Name: "read"}},
		},
	}
	cleaned := stripIntermediateAssistantText(msgs)
	if len(cleaned) != 2 {
		t.Fatalf("expected 2 messages (user + tool call), got %d: %+v", len(cleaned), cleaned)
	}
	if cleaned[1].Role != provider.RoleAssistant || len(cleaned[1].Content) != 1 {
		t.Fatalf("expected 1 tool call in assistant message, got %+v", cleaned[1])
	}
}

func TestStripNudgedAssistantText(t *testing.T) {
	msgs := []provider.Message{
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "do something"}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "Sure, I will do it."}},
		},
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: CompletionNudgeTextBuild}},
		},
		{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.ToolCallBlock{ID: "call_1", Name: "mark_task_as_complete"}},
		},
		{
			Role:    provider.RoleTool,
			Content: []provider.Content{provider.ToolResultBlock{CallID: "call_1", Content: []provider.Content{provider.TextBlock{Text: "ok"}}}},
		},
	}

	cleaned := stripNudgedAssistantText(msgs)
	// msgs[1] (chatter) and msgs[2] (nudge) should be stripped because msgs[3] and msgs[4] succeeded
	if len(cleaned) != 3 {
		t.Fatalf("expected 3 messages, got %d: %+v", len(cleaned), cleaned)
	}
	if extractText(cleaned[0]) != "do something" {
		t.Fatalf("expected first msg to be 'do something', got %q", extractText(cleaned[0]))
	}
	if _, ok := cleaned[1].Content[0].(provider.ToolCallBlock); !ok {
		t.Fatalf("expected second msg to be ToolCallBlock, got %+v", cleaned[1].Content[0])
	}
}

func TestSummaryNudgeTriggerOn30Tools(t *testing.T) {
	var responses [][]provider.Event
	// Generate 30 tool turns
	for i := 0; i < 30; i++ {
		callID := "call_" + string(rune('a'+i))
		responses = append(responses, []provider.Event{
			provider.EventToolStart{ID: callID, Name: "bash"},
			provider.EventToolEnd{ID: callID},
			provider.EventDone{
				Stop: provider.StopToolUse,
				Message: provider.Message{
					Role:    provider.RoleAssistant,
					Content: []provider.Content{provider.ToolCallBlock{ID: callID, Name: "bash"}},
				},
			},
		})
	}
	// 31st response after receiving SummaryWarnNudge: model calls summary tool
	responses = append(responses, []provider.Event{
		provider.EventToolStart{ID: "call_sum", Name: "summary"},
		provider.EventToolEnd{ID: "call_sum"},
		provider.EventDone{
			Stop: provider.StopToolUse,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{ID: "call_sum", Name: "summary"}},
			},
		},
	})
	// 32nd response: mark completion
	responses = append(responses, []provider.Event{
		provider.EventToolStart{ID: "call_done", Name: "mark_task_as_complete"},
		provider.EventToolEnd{ID: "call_done"},
		provider.EventDone{
			Stop: provider.StopToolUse,
			Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{ID: "call_done", Name: "mark_task_as_complete"}},
			},
		},
	})

	client := &scriptedClient{responses: responses}
	tools := NewRegistry(
		&dummyTool{name: "bash"},
		&dummyTool{name: "summary"},
		&dummyTool{name: "mark_task_as_complete"},
	)
	agent := NewAgent(client, "test-model", "system", tools)
	agent.PersistentTurns = true

	var nudgeReceived bool
	_ = agent.Continue(context.Background(), func(e AgentEvent) {
		if ev, ok := e.(EvUserMessage); ok {
			if strings.Contains(extractText(ev.Message), "Multiple tools have been executed without a progress update") {
				nudgeReceived = true
			}
		}
	})

	if !nudgeReceived {
		t.Fatal("expected SummaryWarnNudge to be triggered after 30 tool calls")
	}
}
