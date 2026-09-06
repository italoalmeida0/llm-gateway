package core

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/patriceckhart/zot/packages/provider"
)

type cancelledMessageClient struct{}

func (cancelledMessageClient) Name() string { return "fixture" }
func (cancelledMessageClient) Stream(context.Context, provider.Request) (<-chan provider.Event, error) {
	events := make(chan provider.Event, 4)
	events <- provider.EventReasoningDelta{Delta: "Inspecting the source"}
	events <- provider.EventTextDelta{Delta: "I found the relevant function."}
	events <- provider.EventToolStart{ID: "unfinished", Name: "read"}
	events <- provider.EventDone{Stop: provider.StopAborted, Err: context.Canceled, Message: provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{
		provider.ReasoningBlock{Summary: "Inspecting the source"},
		provider.TextBlock{Text: "I found the relevant function."},
		provider.ToolCallBlock{ID: "unfinished", Name: "read", Arguments: json.RawMessage(`{}`)},
	}}}
	close(events)
	return events, nil
}

func TestCancelledTurnPreservesTextAndThinkingDurationWithoutUnfinishedCalls(t *testing.T) {
	agent := NewAgent(cancelledMessageClient{}, "fixture", "", Registry{})
	err := agent.Prompt(context.Background(), "Inspect", nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("expected cancelled turn")
	}
	messages := agent.Messages()
	if len(messages) != 2 {
		t.Fatal("partial assistant message was lost")
	}
	message := messages[1]
	if extractText(message) != "I found the relevant function." || message.Meta["thinking_ms"] == "" {
		t.Fatal("cancel lost text or thinking duration")
	}
	for _, block := range message.Content {
		if _, ok := block.(provider.ToolCallBlock); ok {
			t.Fatal("unfinished call would poison the next turn")
		}
	}
	data, _ := json.Marshal(message)
	reloaded, err := HydrateMessageObject(data)
	if err != nil || reloaded.Meta["thinking_ms"] != message.Meta["thinking_ms"] {
		t.Fatal("duration did not survive transcript hydration")
	}
}
