package core

import (
	"context"
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type turnFakeClient struct{}

func (c *turnFakeClient) Name() string { return "turn-fake" }

func (c *turnFakeClient) Stream(_ context.Context, req provider.Request) (<-chan provider.Event, error) {
	out := make(chan provider.Event, 2)
	out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
		Role:    provider.RoleAssistant,
		Content: []provider.Content{provider.TextBlock{Text: "hi"}},
	}}
	close(out)
	return out, nil
}

// Every message a turn appends (user prompt + assistant answer) carries
// the turn index the host set on the agent. Later turns stamp their own index
// without touching earlier rows.
func TestPromptStampsTurnIndex(t *testing.T) {
	a := NewAgent(&turnFakeClient{}, "m", "", Registry{})
	a.TurnIndex = 7
	if err := a.Prompt(context.Background(), "hello", nil, nil); err != nil {
		t.Fatalf("turn 7: %v", err)
	}
	a.TurnIndex = 8
	if err := a.Prompt(context.Background(), "again", nil, nil); err != nil {
		t.Fatalf("turn 8: %v", err)
	}
	hist := a.History()
	if len(hist) != 4 {
		t.Fatalf("history = %d messages; want 4", len(hist))
	}
	for i, want := range []int{7, 7, 8, 8} {
		if hist[i].TurnIndex != want {
			t.Fatalf("message %d (%s) TurnIndex = %d; want %d", i, hist[i].Role, hist[i].TurnIndex, want)
		}
	}
	a.TurnIndex = 9
	a.AppendUserContext("ctx", nil)
	if got := a.History()[4].TurnIndex; got != 9 {
		t.Fatalf("appended context TurnIndex = %d; want 9", got)
	}
}

// The on-disk round-trip (marshal → HydrateMessageObject on load) must
// keep the stamp; otherwise every restart loses per-turn grouping.
func TestHydratePreservesTurnIndex(t *testing.T) {
	msg := provider.Message{
		Role:      provider.RoleUser,
		Content:   []provider.Content{provider.TextBlock{Text: "x"}},
		TurnIndex: 5,
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	back, err := HydrateMessageObject(raw)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	if back.TurnIndex != 5 {
		t.Fatalf("TurnIndex = %d; want 5", back.TurnIndex)
	}
	// Rows without the field hydrate as unknown, never as turn 0
	// colliding with a real stamped turn.
	plain, err := HydrateMessageObject([]byte(`{"role":"user","content":[{"text":"y"}]}`))
	if err != nil {
		t.Fatalf("hydrate plain: %v", err)
	}
	if plain.TurnIndex != 0 {
		t.Fatalf("plain TurnIndex = %d; want 0", plain.TurnIndex)
	}
}
