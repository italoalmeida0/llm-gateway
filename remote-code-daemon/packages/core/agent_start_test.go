package core

import (
	"context"
	"testing"
)

func TestBeforeStartLifecycle(t *testing.T) {
	a := NewAgent(&queueFakeClient{}, "model", "base", Registry{})
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
