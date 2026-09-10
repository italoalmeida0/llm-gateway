package core

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func testMsg(role provider.Role, text string) provider.Message {
	return textMsg(role, text)
}

func testToolTurn(id string) (provider.Message, provider.Message) {
	call, res := toolTurn("read", `{"path":"x"}`, "file contents here")
	// Re-ID the pair so tests can distinguish turns.
	setCallID := func(m provider.Message) provider.Message {
		out := m
		out.Content = append([]provider.Content(nil), m.Content...)
		switch c := out.Content[0].(type) {
		case provider.ToolCallBlock:
			c.ID = id
			out.Content[0] = c
		case provider.ToolResultBlock:
			c.CallID = id
			out.Content[0] = c
		}
		return out
	}
	return setCallID(call), setCallID(res)
}

func TestBuildContextKeepsTranscriptUntouched(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	call, res := testToolTurn("c1")
	a.messages = []provider.Message{
		testMsg(provider.RoleUser, "hello"),
		call, res,
		testMsg(provider.RoleAssistant, "done"),
	}
	before := len(a.messages)

	ctx := a.BuildContext()
	if len(a.messages) != before {
		t.Fatalf("BuildContext mutated transcript: %d -> %d", before, len(a.messages))
	}
	if len(ctx) != before {
		t.Fatalf("expected context to mirror transcript, got %d msgs (transcript %d)", len(ctx), before)
	}
}

func TestBuildContextFiltersHidden(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	hidden := testMsg(provider.RoleUser, "internal status")
	hidden.Meta = map[string]string{MetaHidden: "true"}
	a.messages = []provider.Message{
		testMsg(provider.RoleUser, "visible"),
		hidden,
	}
	ctx := a.BuildContext()
	if len(ctx) != 1 || extractText(ctx[0]) != "visible" {
		t.Fatalf("hidden message leaked into context: %+v", ctx)
	}
}

func TestAssistantTextTransforms(t *testing.T) {
	msg := testMsg(provider.RoleAssistant, "secret abc-123")
	// Suppress.
	out, suppressed := applyAssistantTextTransforms(msg, []AssistantTextTransform{
		func(text string) (string, bool) { return "", false },
	})
	if !suppressed {
		t.Fatalf("expected suppression")
	}
	_ = out
	// Replace.
	out, suppressed = applyAssistantTextTransforms(msg, []AssistantTextTransform{
		func(text string) (string, bool) { return "redacted", true },
	})
	if suppressed {
		t.Fatalf("unexpected suppression")
	}
	if extractText(out) != "redacted" {
		t.Fatalf("expected replacement, got %q", extractText(out))
	}
	if extractText(msg) != "secret abc-123" {
		t.Fatalf("transform mutated input")
	}
}

func TestSnapCutToUserBoundary(t *testing.T) {
	call, res := testToolTurn("c9")
	msgs := []provider.Message{
		testMsg(provider.RoleUser, "old"),
		call, res,
		testMsg(provider.RoleUser, "new"),
		testMsg(provider.RoleAssistant, "answering new"),
	}
	// Pair-safe index 1 starts mid-turn (assistant call); must snap to 3.
	if got := snapCutToUserBoundary(msgs, 1); got != 3 {
		t.Fatalf("expected snap to user boundary 3, got %d", got)
	}
	// Already at a user boundary: unchanged.
	if got := snapCutToUserBoundary(msgs, 3); got != 3 {
		t.Fatalf("expected 3, got %d", got)
	}
}

func TestCompactionCheckpointIsAppendOnly(t *testing.T) {
	var msgs []provider.Message
	for i := 0; i < 5; i++ {
		msgs = append(msgs, testMsg(provider.RoleUser, "old"))
	}
	// Append-only checkpoint: history untouched, chain head advances;
	// projection derives the compacted view.
	state := &CompactionState{
		PreviousSummary: "s",
		ModifiedFiles:   []string{"a.go"},
		KeepFrom:        3,
		Count:           1,
	}
	if len(msgs) != 5 {
		t.Fatalf("compaction must be append-only; full history = 5 rows, got %d", len(msgs))
	}
	projected := projectMessages(msgs, state)
	if len(projected) != 3 || extractText(projected[1]) != "old" {
		t.Fatalf("projection must be [summary][3 kept rows], got %+v", projected)
	}
	if tb, ok := projected[0].Content[0].(provider.TextBlock); !ok || tb.Text != summaryMessageText("s") {
		t.Fatalf("projected summary head wrong: %+v", projected[0])
	}
}
