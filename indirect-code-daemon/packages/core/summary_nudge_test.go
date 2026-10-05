package core

import (
	"context"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

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
