package core

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// startFakeClient answers the first model call with a tool use (resolves
// to no client results against the empty registry) and every later call
// with a plain text stop: two Prompts then run three BeforeTurn steps.
type startFakeClient struct {
	calls int32
}

func (c *startFakeClient) Name() string { return "start-fake" }

func (c *startFakeClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	call := atomic.AddInt32(&c.calls, 1)
	out := make(chan provider.Event, 4)
	go func() {
		defer close(out)
		out <- provider.EventStart{Provider: "start-fake", Model: req.Model}
		if call == 1 {
			out <- provider.EventToolStart{ID: "t1", Name: "echo"}
			out <- provider.EventToolEnd{ID: "t1"}
			out <- provider.EventDone{Stop: provider.StopToolUse, Message: provider.Message{
				Role: provider.RoleAssistant,
				Content: []provider.Content{
					provider.TextBlock{Text: "using tool"},
					provider.ToolCallBlock{ID: "t1", Name: "echo", Arguments: json.RawMessage(`{}`)},
				},
			}}
			return
		}
		out <- provider.EventDone{Stop: provider.StopEnd, Message: provider.Message{
			Role:    provider.RoleAssistant,
			Content: []provider.Content{provider.TextBlock{Text: "done"}},
		}}
	}()
	return out, nil
}

func TestBeforeStartLifecycle(t *testing.T) {
	a := NewAgent(&startFakeClient{}, "model", "base", Registry{})
	calls, turns := 0, 0
	a.BeforeStart = func(ctx context.Context, system string) string {
		calls++
		if system != "base" {
			t.Fatalf("reapplied to modified prompt %q", system)
		}
		return system + "/extension"
	}
	a.BeforeTurn = func(int) (bool, string) {
		turns++
		if calls != 1 || a.System != "base/extension" {
			t.Fatal("turn ran before preparation")
		}
		return true, ""
	}
	for range 2 {
		if err := a.Prompt(context.Background(), "hello", nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 || turns != 3 {
		t.Fatalf("calls=%d turns=%d", calls, turns)
	}
	a.BeforeTurn = nil
	for _, reset := range []func(){
		func() { a.Model = "other" },
		func() { a.SetMessages(nil) },
		func() { a.SessionID = "new-session" },
		func() { a.SetSystem("base") },
	} {
		reset()
		before := calls
		if err := a.Continue(context.Background(), nil); err != nil {
			t.Fatal(err)
		}
		if calls != before+1 || a.System != "base/extension" {
			t.Fatal("reset did not reprepare from base")
		}
	}
	a.BeforeStart = func(context.Context, string) string { return "" }
	a.SetSystem("base")
	if err := a.Continue(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if a.System != "" {
		t.Fatal("empty replacement lost")
	}
}

func TestBeforeStartCancellationRetriesPreparation(t *testing.T) {
	a := NewAgent(nil, "model", "base", nil)
	ctx, cancel := context.WithCancel(context.Background())
	a.BeforeStart = func(context.Context, string) string { cancel(); return "modified" }
	if err := a.Continue(ctx, nil); err != context.Canceled {
		t.Fatalf("error=%v", err)
	}
	if a.System != "base" || a.startPrepared {
		t.Fatal("canceled preparation committed")
	}
	a.BeforeStart = func(context.Context, string) string { return "retry" }
	a.BeforeTurn = func(int) (bool, string) { return false, "test" }
	if err := a.Continue(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if a.System != "retry" {
		t.Fatal("preparation not retried")
	}
}
