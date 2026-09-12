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

// Details is the frontend-only rendering data (bash terminal view, read
// line numbers, edit diffs). It is persisted with the transcript but
// never sent to the LLM. The on-disk round-trip must keep it: dropping
// it on hydrate makes the first save after a daemon restart strip it
// permanently, and the UI falls back to raw tool output.
func TestHydratePreservesToolResultDetails(t *testing.T) {
	msg := provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{provider.ToolResultBlock{
			CallID:  "call_1",
			Content: []provider.Content{provider.TextBlock{Text: "(no output)\n\nCommand exited with code 1"}},
			Details: map[string]any{"display": "$ ls\n[exit 1]  Took 0.0s", "exitCode": 1},
		}},
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	back, err := HydrateMessageObject(raw)
	if err != nil {
		t.Fatalf("hydrate: %v", err)
	}
	tr, ok := back.Content[0].(provider.ToolResultBlock)
	if !ok {
		t.Fatalf("hydrated content = %T; want ToolResultBlock", back.Content[0])
	}
	if tr.Details == nil {
		t.Fatal("Details = nil after hydrate; want preserved")
	}
	// The remarshal must be byte-identical so repeated load→save cycles
	// (restart, rename, usage events, ...) never degrade the transcript.
	rewritten, err := json.Marshal(back)
	if err != nil {
		t.Fatalf("remarshal: %v", err)
	}
	if string(rewritten) != string(raw) {
		t.Fatalf("round-trip changed bytes:\n got  %s\n want %s", rewritten, raw)
	}
	// Results without details hydrate with nil, not an empty value.
	plain, err := HydrateMessageObject([]byte(`{"role":"tool","content":[{"call_id":"c","content":[{"text":"ok"}]}]}`))
	if err != nil {
		t.Fatalf("hydrate plain: %v", err)
	}
	plainTR := plain.Content[0].(provider.ToolResultBlock)
	if plainTR.Details != nil {
		t.Fatalf("plain Details = %v; want nil", plainTR.Details)
	}
}
