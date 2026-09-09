package core

import (
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestSessionRoundTrip(t *testing.T) {
	dir := t.TempDir()

	st, err := OpenSQLiteSessionStore(dir+"/s.db", "/tmp/project", SessionMeta{Provider: "anthropic", Model: "claude-sonnet-4-5", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	msg := provider.Message{
		Role: provider.RoleUser,
		Content: []provider.Content{
			provider.TextBlock{Text: "hello"},
		},
		Time: time.Now().UTC(),
	}
	if err := st.AppendMessage(msg); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSQLiteSessionStore(dir+"/s.db", "/tmp/project", SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	// Close the append writer before t.TempDir runs cleanup, otherwise
	// windows refuses to delete the open file.
	t.Cleanup(func() { _ = reopened.Close() })
	msgs, err := reopened.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("got %d messages", len(msgs))
	}
	tb, ok := msgs[0].Content[0].(provider.TextBlock)
	if !ok || tb.Text != "hello" {
		t.Fatalf("got %+v", msgs[0])
	}
}

func TestSessionRoundTripPreservesThoughtSignatures(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenSQLiteSessionStore(dir+"/s.db", "/tmp/project", SessionMeta{Provider: "google", Model: "gemini-3-flash", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	msg := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ReasoningBlock{Summary: "thinking"},
			provider.TextBlock{Text: "answer", ThoughtSignature: "text-sig"},
			provider.ImageBlock{MimeType: "image/png", Data: []byte("png"), ThoughtSignature: "image-sig"},
			provider.ToolCallBlock{
				ID:               "call-1",
				Name:             "read",
				Arguments:        []byte(`{"path":"a"}`),
				ThoughtSignature: "tool-sig",
			},
		},
	}
	if err := st.AppendMessage(msg); err != nil {
		t.Fatal(err)
	}
	if err := st.AppendMessage(provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{provider.ToolResultBlock{
			CallID:  "call-1",
			Content: []provider.Content{provider.TextBlock{Text: "result"}},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSQLiteSessionStore(dir+"/s.db", "/tmp/project", SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	msgs, err := reopened.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || len(msgs[0].Content) != 4 {
		t.Fatalf("round trip content = %+v", msgs)
	}
	if rb, ok := msgs[0].Content[0].(provider.ReasoningBlock); !ok || rb.Summary != "thinking" {
		t.Fatalf("reasoning block = %#v", msgs[0].Content[0])
	}
	if tb, ok := msgs[0].Content[1].(provider.TextBlock); !ok || tb.ThoughtSignature != "text-sig" {
		t.Fatalf("text block = %#v", msgs[0].Content[1])
	}
	if ib, ok := msgs[0].Content[2].(provider.ImageBlock); !ok || ib.ThoughtSignature != "image-sig" {
		t.Fatalf("image block = %#v", msgs[0].Content[2])
	}
	if tc, ok := msgs[0].Content[3].(provider.ToolCallBlock); !ok || tc.ThoughtSignature != "tool-sig" {
		t.Fatalf("tool call block = %#v", msgs[0].Content[3])
	}
}

func TestCostAdd(t *testing.T) {
	var c CostTracker
	c.Add(provider.Usage{InputTokens: 100, OutputTokens: 50, ReasoningTokens: 20, ReasoningTokensKnown: true, CostUSD: 0.01})
	c.Add(provider.Usage{InputTokens: 200, OutputTokens: 25, ReasoningTokens: 10, ReasoningTokensKnown: true, CostUSD: 0.02})
	if c.Total.InputTokens != 300 || c.Total.OutputTokens != 75 {
		t.Fatalf("got %+v", c.Total)
	}
	if c.Total.ReasoningTokens != 30 || !c.Total.ReasoningTokensKnown {
		t.Fatalf("got reasoning usage %+v", c.Total)
	}
	if c.Total.CostUSD < 0.0299 || c.Total.CostUSD > 0.0301 {
		t.Fatalf("got cost %v", c.Total.CostUSD)
	}
}
