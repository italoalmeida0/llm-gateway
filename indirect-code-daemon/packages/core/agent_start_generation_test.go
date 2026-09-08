package core

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestBeforeStartDiscardsSupersededPreparation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		reset    func(*Agent)
		wantBase string
	}{
		{"new prompt", func(a *Agent) { a.SetSystem("new base") }, "new base"},
		{"same prompt reset", func(a *Agent) { a.SetSystem("base") }, "base"},
		{"ABA prompt reset", func(a *Agent) { a.SetSystem("temporary"); a.SetSystem("base") }, "base"},
		{"multiple rebuilds", func(a *Agent) { a.SetSystem("intermediate"); a.SetSystem("latest") }, "latest"},
		{"clear", func(a *Agent) { a.SetMessages(nil) }, "base"},
		{"model change", func(a *Agent) { a.Model = "new model" }, "base"},
		{"session change", func(a *Agent) { a.SessionID = "new session" }, "base"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := NewAgent(nil, "model", "base", nil)
			entered, release := make(chan struct{}), make(chan struct{})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var inputs []string
			a.BeforeStart = func(ctx context.Context, system string) string {
				inputs = append(inputs, system)
				if len(inputs) == 1 {
					close(entered)
					select {
					case <-release:
					case <-ctx.Done():
					}
				}
				return fmt.Sprintf("%s/replacement-%d", system, len(inputs))
			}
			a.BeforeTurn = func(int) (bool, string) { return false, "test" }
			done := make(chan struct{})
			var runErr error
			go func() { defer close(done); runErr = a.Continue(ctx, nil) }()
			t.Cleanup(func() { cancel(); <-done })
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("hook did not start")
			}
			// The hook is paused without the agent lock. Reset must remain responsive,
			// including when the base string has not changed at all.
			tc.reset(a)
			close(release)
			select {
			case <-done:
				if runErr != nil {
					t.Fatal(runErr)
				}
			case <-ctx.Done():
				t.Fatal("preparation did not finish")
			}
			if len(inputs) != 2 || inputs[1] != tc.wantBase {
				t.Fatalf("hook inputs=%q, want [base %q]", inputs, tc.wantBase)
			}
			want := tc.wantBase + "/replacement-2"
			if a.System != want || a.BaseSystem() != tc.wantBase {
				t.Fatalf("system=%q base=%q", a.System, a.BaseSystem())
			}
			if a.startModel != a.Model || a.startSession != a.SessionID {
				t.Fatal("prepared metadata does not match current runtime")
			}
			// The fresh result is cached; normal continuation must not run it again.
			if err := a.Continue(ctx, nil); err != nil {
				t.Fatal(err)
			}
			if len(inputs) != 2 {
				t.Fatal("fresh preparation was not cached")
			}
		})
	}
}

func TestBeforeStartCancellationDuringRepreparation(t *testing.T) {
	a := NewAgent(nil, "model", "base", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, second, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	calls := 0
	a.BeforeStart = func(ctx context.Context, system string) string {
		calls++
		if calls == 1 {
			close(first)
			select {
			case <-release:
			case <-ctx.Done():
			}
		} else {
			close(second)
			<-ctx.Done()
		}
		return "discard this replacement"
	}
	a.BeforeTurn = func(int) (bool, string) { return false, "test" }
	done := make(chan struct{})
	var runErr error
	go func() { defer close(done); runErr = a.Continue(ctx, nil) }()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-first:
	case <-ctx.Done():
		t.Fatal("first hook did not start")
	}
	a.SetSystem("new base")
	close(release)
	select {
	case <-second:
	case <-done:
		t.Fatal("stale preparation was committed instead of retried")
	case <-ctx.Done():
		t.Fatal("second hook did not start")
	}
	cancel()
	<-done
	if runErr != context.Canceled {
		t.Fatalf("error=%v", runErr)
	}
	if a.System != "new base" || a.startPrepared {
		t.Fatal("cancellation committed a stale result")
	}
}
