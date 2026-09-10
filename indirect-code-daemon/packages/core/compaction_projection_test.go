package core

// Projection tests for the compaction layer:
// append-only history + projected context + proactive in-run trigger.
//
// The fake client below is scriptable per call: summarizer requests
// (System == SummarizationSystemPrompt) answer with the queued summary,
// model requests answer "ok". This lets Compact/MaybeAutoCompact and
// the run-loop hook run end-to-end without a network.

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// scriptableFakeClient answers summarizer calls with summaries[idx]
// and every other call with a plain "ok" assistant message.
type scriptableFakeClient struct {
	calls     int32
	summaries []string
}

func (c *scriptableFakeClient) Name() string { return "projection-fake" }

func (c *scriptableFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	atomic.AddInt32(&c.calls, 1)
	out := make(chan provider.Event, 8)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "projection-fake", Model: req.Model}
		if req.System == SummarizationSystemPrompt && len(c.summaries) > 0 {
			text := c.summaries[0]
			c.summaries = c.summaries[1:]
			out <- provider.EventTextDelta{Delta: text}
			out <- provider.EventUsage{Usage: provider.Usage{InputTokens: 50, OutputTokens: 25}}
			out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: text}},
			}}
			return
		}
		out <- provider.EventTextDelta{Delta: "ok"}
		out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "ok"}},
		}}
	}()
	return out, nil
}

func bigHistory(n int) []provider.Message {
	var msgs []provider.Message
	for i := 0; i < n; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, "user message number "+strings.Repeat("x", 40)))
		msgs = append(msgs, textMsg(provider.RoleAssistant, "assistant reply number "+strings.Repeat("y", 40)))
	}
	return msgs
}

// Active projection: history untouched, context = [summary]+tail.
func TestProjectionActiveHidesSummarizedPrefix(t *testing.T) {
	history := bigHistory(6) // 12 messages
	a := NewAgent(nil, "m", "", nil)
	a.SetMessages(history)
	if len(a.History()) != len(history) {
		t.Fatalf("History = %d, want full log %d", len(a.History()), len(history))
	}
	state := &CompactionState{
		PreviousSummary: "did stuff",
		KeepFrom:        8,
		Count:           1,
	}
	a.SeedCompactionState(state)
	msgs := a.Messages()
	if len(msgs) != 1+(len(history)-8) {
		t.Fatalf("projected len = %d, want %d", len(msgs), 1+(len(history)-8))
	}
	if !strings.Contains(extractText(msgs[0]), "## Context Summary (compacted)") {
		t.Fatalf("head must be the synthetic summary, got %q", extractText(msgs[0]))
	}
	if extractText(msgs[1]) != extractText(history[8]) {
		t.Fatalf("tail must map verbatim from history")
	}
	if len(a.History()) != len(history) {
		t.Fatalf("projection must not mutate history")
	}
}

// Corrupted anchors fail open: never hide user messages from the model.
func TestProjectionCorruptAnchorFailsOpen(t *testing.T) {
	history := bigHistory(4)
	a := NewAgent(nil, "m", "", nil)
	a.SetMessages(history)
	a.SeedCompactionState(&CompactionState{
		PreviousSummary: "s",
		KeepFrom:        len(history) + 100, // past the end
		Count:           1,
	})
	if got := len(a.Messages()); got != len(history) {
		t.Fatalf("corrupt anchor must fail open: got %d, want %d", got, len(history))
	}
}

// Compact end-to-end: non-destructive, chain advances, hooks fire.
func TestCompactNonDestructiveEndToEnd(t *testing.T) {
	client := &scriptableFakeClient{summaries: []string{"summary one"}}
	a := NewAgent(client, "m", "", nil)
	history := bigHistory(8) // 16 messages, well above the minimum
	a.SetMessages(history)

	var hookState *CompactionState
	a.OnCompactionState = func(s *CompactionState) { hookState = s }

	summary, err := a.Compact(context.Background(), 4, nil)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if summary != "summary one" {
		t.Fatalf("summary = %q", summary)
	}
	// History intact; context projected.
	if len(a.History()) != len(history) {
		t.Fatalf("Compact rewrote history: %d -> %d", len(history), len(a.History()))
	}
	if len(a.Messages()) != 1+4 {
		t.Fatalf("projected context = %d, want 5 (summary + 4 kept)", len(a.Messages()))
	}
	chain := a.CompactionChain()
	if chain == nil || chain.Count != 1 {
		t.Fatalf("chain head wrong: %+v", chain)
	}
	if chain.KeepFrom != len(history)-4 {
		t.Fatalf("KeepFrom = %d, want %d", chain.KeepFrom, len(history)-4)
	}
	if hookState == nil || hookState.Count != 1 {
		t.Fatalf("OnCompactionState not fired: %+v", hookState)
	}
}

// bigTokenHistory builds a transcript over the 20k keep floor (~1500
// tokens/message) so the auto path has something worth summarizing.
// Small transcripts correctly refuse with "fits under the keep floor".
func bigTokenHistory(pairs int) []provider.Message {
	var msgs []provider.Message
	for i := 0; i < pairs; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, "user message "+strings.Repeat("x", 6000)))
		msgs = append(msgs, textMsg(provider.RoleAssistant, "assistant reply "+strings.Repeat("y", 6000)))
	}
	return msgs
}

// MaybeAutoCompact: no-op when the next request fits, compacts past reserve.
func TestMaybeAutoCompactTriggerAndNoop(t *testing.T) {
	newSeeded := func() *Agent {
		client := &scriptableFakeClient{summaries: []string{"auto summary"}}
		a := NewAgent(client, "m", "", nil)
		a.SetMessages(bigTokenHistory(8)) // ~24k tokens
		// Last-turn usage approximates the prompt the model just saw.
		a.SeedLastTurnUsage(provider.Usage{InputTokens: 12000, OutputTokens: 500})
		return a
	}

	// Tight window: usage blows past window-reserve -> compacts.
	a := newSeeded()
	did, err := a.MaybeAutoCompact(context.Background(), 25000, nil)
	if err != nil {
		t.Fatalf("MaybeAutoCompact: %v", err)
	}
	if !did {
		t.Fatalf("expected compaction past the reserve")
	}
	if a.CompactionChain() == nil {
		t.Fatalf("chain head missing after auto-compact")
	}
	if len(a.History()) != 16 {
		t.Fatalf("auto-compact must not rewrite history")
	}
	if len(a.Messages()) >= 16 {
		t.Fatalf("projected context must drop the summarized prefix, got %d", len(a.Messages()))
	}

	// Huge window: same transcript fits -> no-op, no summarizer call.
	b := newSeeded()
	before := len(b.History())
	did, err = b.MaybeAutoCompact(context.Background(), 1_000_000, nil)
	if err != nil {
		t.Fatalf("MaybeAutoCompact: %v", err)
	}
	if did || b.CompactionChain() != nil {
		t.Fatalf("expected no-op on a fitting window")
	}
	if len(b.History()) != before {
		t.Fatalf("no-op must not touch history")
	}
}

// Proactive run-loop compaction: the AutoCompact hook fires before the
// model request, so a mid-run tool batch that blows the window still
// compacts before the next response.
func TestRunLoopAutoCompactBeforeNextResponse(t *testing.T) {
	client := &scriptableFakeClient{summaries: []string{"run summary"}}
	a := NewAgent(client, "m", "", nil)
	a.SetMessages(bigTokenHistory(8)) // ~24k tokens
	a.SeedLastTurnUsage(provider.Usage{InputTokens: 15000, OutputTokens: 500})

	autoFired := false
	a.AutoCompact = func(ctx context.Context, sink func(AgentEvent)) error {
		autoFired = true
		_, err := a.MaybeAutoCompact(ctx, 30000, nil)
		return err
	}
	if err := a.Prompt(context.Background(), "next question", nil, func(AgentEvent) {}); err != nil {
		t.Fatalf("Prompt: %v", err)
	}
	if !autoFired {
		t.Fatalf("AutoCompact hook never ran inside the loop")
	}
	if a.CompactionChain() == nil {
		t.Fatalf("expected the run loop to compact before the response")
	}
	if len(a.History()) < 16 {
		t.Fatalf("history must keep every message, got %d", len(a.History()))
	}
}

// Split-turn compaction: summarizes prior history and turn prefix separately.
func TestCompactSplitTurn(t *testing.T) {
	client := &scriptableFakeClient{summaries: []string{"prior history summary", "turn prefix summary"}}
	a := NewAgent(client, "m", "", nil)
	var msgs []provider.Message
	msgs = append(msgs, textMsg(provider.RoleUser, "first task"))
	msgs = append(msgs, textMsg(provider.RoleAssistant, "first answer"))
	msgs = append(msgs, textMsg(provider.RoleUser, "huge turn request"))
	for i := 0; i < 4; i++ {
		call, res := toolTurn("read", `{"path":"f.ts"}`, strings.Repeat("x", 400))
		msgs = append(msgs, call, res)
	}
	a.SetMessages(msgs)
	summary, err := a.Compact(context.Background(), 2, nil)
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if !strings.Contains(summary, "Turn Context (split turn):") {
		t.Fatalf("summary must contain split turn header, got: %s", summary)
	}
	if !strings.Contains(summary, "turn prefix summary") {
		t.Fatalf("summary missing prefix summary: %s", summary)
	}
	chain := a.CompactionChain()
	if chain == nil || chain.Usage == nil {
		t.Fatalf("chain head missing usage: %+v", chain)
	}
	if chain.Usage.InputTokens <= 0 {
		t.Fatalf("compaction usage should be recorded, got %+v", chain.Usage)
	}
}
