package core

import (
	"context"
	"errors"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type persistentClient struct {
	stream func(context.Context, provider.Request) (<-chan provider.Event, error)
}

func (c persistentClient) Name() string { return "persistent-test" }
func (c persistentClient) Stream(ctx context.Context, req provider.Request) (<-chan provider.Event, error) {
	return c.stream(ctx, req)
}
func terminalEvents(stop provider.StopReason, content ...provider.Content) <-chan provider.Event {
	ch := make(chan provider.Event, 1)
	ch <- provider.EventDone{Stop: stop, Message: provider.Message{Role: provider.RoleAssistant, Content: content}}
	close(ch)
	return ch
}

func TestPersistentTurnIgnoresNudgeCapsUntilExplicitStop(t *testing.T) {
	for _, text := range []string{"", "Still working"} {
		t.Run(text, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			c := persistentClient{stream: func(context.Context, provider.Request) (<-chan provider.Event, error) {
				calls++
				if calls == 8 {
					cancel()
				}
				return terminalEvents(provider.StopEnd, provider.TextBlock{Text: text}), nil
			}}
			a := NewAgent(c, "m", "", NewRegistry(&dummyTool{name: "mark_task_as_complete"}))
			a.PersistentTurns = true
			a.RetrySchedule = []time.Duration{0}
			if err := a.Prompt(ctx, "work", nil, nil); !errors.Is(err, context.Canceled) {
				t.Fatalf("want explicit cancellation, got %v", err)
			}
			if calls != 8 {
				t.Fatalf("ended after %d calls without completion", calls)
			}
		})
	}
}

func TestPersistentTurnRetriesRequestDeadlineAndCompaction(t *testing.T) {
	calls, compacts := 0, 0
	c := persistentClient{stream: func(context.Context, provider.Request) (<-chan provider.Event, error) {
		calls++
		if calls == 1 {
			return nil, context.DeadlineExceeded
		}
		return terminalEvents(provider.StopEnd, provider.TextBlock{Text: "Recovered"}), nil
	}}
	a := NewAgent(c, "m", "", Registry{})
	a.PersistentTurns = true
	a.RetrySchedule = []time.Duration{0}
	a.AutoCompact = func(context.Context, func(AgentEvent)) error {
		compacts++
		if compacts == 1 {
			return errors.New("temporary provider failure")
		}
		return nil
	}
	if err := a.Prompt(context.Background(), "work", nil, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || compacts != 2 {
		t.Fatalf("calls=%d compactions=%d", calls, compacts)
	}
}

func TestPersistentTurnRejectsTruncatedStreamsAndUncommittedOutput(t *testing.T) {
	calls := 0
	persisted := []provider.Message{}
	c := persistentClient{stream: func(context.Context, provider.Request) (<-chan provider.Event, error) {
		calls++
		if calls == 1 {
			return terminalEvents(provider.StopAborted, provider.TextBlock{Text: "Partial"}), nil
		}
		if calls == 2 {
			ch := make(chan provider.Event)
			close(ch)
			return ch, nil
		}
		return terminalEvents(provider.StopEnd, provider.TextBlock{Text: "Recovered"}), nil
	}}
	a := NewAgent(c, "m", "", Registry{})
	a.PersistentTurns = true
	a.RetrySchedule = []time.Duration{0}
	a.OnMessageAppended = func(m provider.Message) { persisted = append(persisted, m) }
	if err := a.Prompt(context.Background(), "work", nil, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 3 || len(persisted) != 2 || extractText(persisted[1]) != "Recovered" {
		t.Fatalf("calls=%d persisted=%v", calls, persisted)
	}
}

func TestPersistentCompletionNeedsSuccessfulToolAndSurvivesRestart(t *testing.T) {
	calls := 0
	c := persistentClient{stream: func(context.Context, provider.Request) (<-chan provider.Event, error) {
		calls++
		return terminalEvents(provider.StopToolUse, provider.TextBlock{Text: "Done"}, provider.ToolCallBlock{ID: "finish", Name: "mark_task_as_complete"}), nil
	}}
	a := NewAgent(c, "m", "", NewRegistry(&dummyTool{name: "mark_task_as_complete"}))
	a.PersistentTurns = true
	a.TurnIndex = 7
	if err := a.Prompt(context.Background(), "work", nil, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("completion made another provider request")
	}
	restored := NewAgent(c, "m", "", a.Tools)
	restored.PersistentTurns = true
	restored.TurnIndex = 7
	restored.SetMessages(a.History())
	if err := restored.Continue(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("restart repeated an already committed completion")
	}
	assistant := provider.Message{Content: []provider.Content{provider.ToolCallBlock{ID: "finish", Name: "mark_task_as_complete"}}}
	rejected := provider.Message{Content: []provider.Content{provider.ToolResultBlock{CallID: "finish", IsError: true}}}
	if successfulCompletion(assistant, rejected) {
		t.Fatal("rejected tool concluded the task")
	}
}

func TestPersistentTextCompletionSurvivesFinalizationCrash(t *testing.T) {
	calls := 0
	c := persistentClient{stream: func(context.Context, provider.Request) (<-chan provider.Event, error) {
		calls++
		return terminalEvents(provider.StopEnd, provider.TextBlock{Text: "Done"}), nil
	}}
	a := NewAgent(c, "m", "", Registry{})
	a.PersistentTurns = true
	a.TurnIndex = 1
	if err := a.Prompt(context.Background(), "work", nil, nil); err != nil {
		t.Fatal(err)
	}
	restored := NewAgent(c, "m", "", Registry{})
	restored.PersistentTurns = true
	restored.TurnIndex = 1
	restored.SetMessages(a.History())
	if err := restored.Continue(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("recovery made another request after committed text completion")
	}
}
