package core

import (
	"context"
	"encoding/json"
	"testing"
)

func TestMessageIdentityFromStreamStartThroughPersistence(t *testing.T) {
	agent := NewAgent(cancelledMessageClient{}, "fixture", "", Registry{})
	start, final := "", ""
	_ = agent.Prompt(context.Background(), "Inspect", nil, func(ev AgentEvent) {
		switch e := ev.(type) {
		case EvAssistantStart:
			start = e.ID
		case EvAssistantMessage:
			final = e.Message.ID
		}
	})
	messages := agent.Messages()
	if start == "" || final != start || messages[1].ID != start || messages[0].ID == "" || messages[0].ID == start {
		t.Fatal("stream identity does not match committed messages")
	}
	raw, _ := json.Marshal(messages[1])
	restored, err := HydrateMessageObject(raw)
	if err != nil || restored.ID != start {
		t.Fatal("persistence changed identity")
	}
}
