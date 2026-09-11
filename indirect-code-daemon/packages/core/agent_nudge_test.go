package core

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// emptyThenDoneFakeClient ends its first turn with a thinking-only
// response (no text, no tool calls) and answers the continue nudge with
// real text on the second call.
type emptyThenDoneFakeClient struct {
	calls int32
}

func (c *emptyThenDoneFakeClient) Name() string { return "empty-fake" }

func (c *emptyThenDoneFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	call := atomic.AddInt32(&c.calls, 1)
	out := make(chan provider.Event, 4)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "empty-fake", Model: req.Model}
		if call == 1 {
			out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ReasoningBlock{Summary: "thinking, no output"}},
			}}
			return
		}
		out <- provider.EventTextDelta{Delta: "done"}
		out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "done"}},
		}}
	}()
	return out, nil
}

func TestEmptyTerminalResponseNudgesInsteadOfEndingTurn(t *testing.T) {
	client := &emptyThenDoneFakeClient{}
	a := NewAgent(client, "fake-model", "system", Registry{})

	if err := a.Prompt(context.Background(), "hello", nil, nil); err != nil {
		t.Fatalf("Prompt returned %v", err)
	}
	if got := atomic.LoadInt32(&client.calls); got != 2 {
		t.Fatalf("Stream calls = %d; want 2 (empty response must nudge, not end turn)", got)
	}
	msgs := a.Messages()
	if len(msgs) != 4 {
		t.Fatalf("message count = %d; want user + empty assistant + nudge + final assistant", len(msgs))
	}
	if got := extractText(msgs[2]); got != ContinueNudgeText {
		t.Fatalf("nudge text = %q; want %q", got, ContinueNudgeText)
	}
	if msgs[2].Role != provider.RoleUser {
		t.Fatalf("nudge role = %q; want user", msgs[2].Role)
	}
	if got := extractText(msgs[3]); got != "done" {
		t.Fatalf("final assistant text = %q; want done", got)
	}
}

type nudgePingTool struct{}

func (nudgePingTool) Name() string            { return "ping" }
func (nudgePingTool) Description() string     { return "test tool" }
func (nudgePingTool) Schema() json.RawMessage { return json.RawMessage(`{}`) }
func (nudgePingTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (ToolResult, error) {
	return ToolResult{Content: []provider.Content{provider.TextBlock{Text: "pong"}}}, nil
}

// resetFakeClient script: e = empty terminal, t = tool_use, d = done text.
type resetFakeClient struct {
	calls  int32
	script []byte
}

func (c *resetFakeClient) Name() string { return "reset-fake" }

func (c *resetFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	call := int(atomic.AddInt32(&c.calls, 1))
	out := make(chan provider.Event, 4)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "reset-fake", Model: req.Model}
		kind := byte('e')
		if call-1 < len(c.script) {
			kind = c.script[call-1]
		}
		switch kind {
		case 't':
			out <- provider.EventDone{Stop: provider.StopToolUse, Message: provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{
					ID: "call-1", Name: "ping", Arguments: json.RawMessage(`{}`),
				}},
			}}
		case 's':
			out <- provider.EventDone{Stop: provider.StopToolUse, Message: provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.Content{provider.ToolCallBlock{
					ID: "srv-1", Name: "web_search", Server: true,
				}},
			}}
		case 'd':
			out <- provider.EventTextDelta{Delta: "done"}
			out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: "done"}},
			}}
		default:
			out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
				Role:    provider.RoleAssistant,
				Content: []provider.Content{provider.ReasoningBlock{Summary: "thinking"}},
			}}
		}
	}()
	return out, nil
}

// A tool call mid-turn must renew the empty-response nudge budget:
// maxContinueNudges empties, then work, then maxContinueNudges empties
// again must all be tolerated before the cap ends the turn.
func TestNudgeBudgetResetsOnToolUse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		toolOp byte // 't' = client tool, 's' = provider-executed server tool
	}{
		{"client tool", 't'},
		{"server tool", 's'},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script := []byte{'e', 'e', 'e', tc.toolOp, 'e', 'e', 'e', 'e'}
			client := &resetFakeClient{script: script}
			a := NewAgent(client, "fake-model", "system", NewRegistry(nudgePingTool{}))

			if err := a.Prompt(context.Background(), "hello", nil, nil); err != nil {
				t.Fatalf("Prompt returned %v", err)
			}
			// 3 empties (nudged) + tools (budget renews) + 3 empties
			// (nudged) + 1 empty ending the turn on the cap.
			if got, want := atomic.LoadInt32(&client.calls), int32(len(script)); got != want {
				t.Fatalf("Stream calls = %d; want %d (budget must reset on tool use)", got, want)
			}
		})
	}
}

func TestSanitizeUserText(t *testing.T) {
	if got := SanitizeUserText(ContinueNudgeText); got != "You should continue what you are doing." {
		t.Fatalf("bracketed nudge = %q; want brackets stripped", got)
	}
	if got := SanitizeUserText("  " + ContinueNudgeText + "  "); got != "You should continue what you are doing." {
		t.Fatalf("padded nudge = %q; want brackets stripped", got)
	}
	if got := SanitizeUserText(CompletionNudgeTextBuild); got != "Automatic system message: If you have completed the task, call mark_task_as_complete. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work." {
		t.Fatalf("build completion nudge = %q; want brackets stripped", got)
	}
	if got := SanitizeUserText("  " + CompletionNudgeTextBuild + "  "); got != "Automatic system message: If you have completed the task, call mark_task_as_complete. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work." {
		t.Fatalf("padded build completion nudge = %q; want brackets stripped", got)
	}
	if got := SanitizeUserText(CompletionNudgeTextPlan); got != "Automatic system message: If your plan is ready, call mark_plan_as_ready_to_execute. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work." {
		t.Fatalf("plan completion nudge = %q; want brackets stripped", got)
	}
	if got := SanitizeUserText("  " + CompletionNudgeTextPlan + "  "); got != "Automatic system message: If your plan is ready, call mark_plan_as_ready_to_execute. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work." {
		t.Fatalf("padded plan completion nudge = %q; want brackets stripped", got)
	}
	for _, s := range []string{"hello", "", "[unrelated]", "You should continue what you are doing."} {
		if got := SanitizeUserText(s); got != s {
			t.Fatalf("SanitizeUserText(%q) = %q; want unchanged", s, got)
		}
	}
}

// alwaysEmptyFakeClient never produces visible output: the turn must end
// after maxContinueNudges instead of looping forever.
type alwaysEmptyFakeClient struct {
	calls int32
}

func (c *alwaysEmptyFakeClient) Name() string { return "always-empty-fake" }

func (c *alwaysEmptyFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	atomic.AddInt32(&c.calls, 1)
	out := make(chan provider.Event, 2)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "always-empty-fake", Model: req.Model}
		out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
			Role: provider.RoleAssistant,
		}}
	}()
	return out, nil
}

func TestEmptyTerminalResponseNudgeCap(t *testing.T) {
	client := &alwaysEmptyFakeClient{}
	a := NewAgent(client, "fake-model", "system", Registry{})

	if err := a.Prompt(context.Background(), "hello", nil, nil); err != nil {
		t.Fatalf("Prompt returned %v", err)
	}
	want := int32(1 + maxContinueNudges)
	if got := atomic.LoadInt32(&client.calls); got != want {
		t.Fatalf("Stream calls = %d; want %d (initial + capped nudges)", got, want)
	}
}
