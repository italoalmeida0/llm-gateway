package tools

import (
	"context"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// pinHost fakes SleepHost + BgSleepCheckHost: one pinned task with a
// configurable status ("" = unknown id).
type pinHost struct {
	status string
	label  string
}

func (h pinHost) WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{} {
	return nil
}

func (h pinHost) BgTaskStatus(sessionID, jobID string) (string, string, bool) {
	if h.status == "" {
		return "", "", false
	}
	return h.status, h.label, true
}

func sleepResultText(t *testing.T, tool *SleepTool, args string) (string, time.Duration) {
	t.Helper()
	start := time.Now()
	res, err := tool.Execute(context.Background(), []byte(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("expected one text block, got %+v", res.Content)
	}
	tb, ok := res.Content[0].(provider.TextBlock)
	if !ok {
		t.Fatalf("expected TextBlock, got %T", res.Content[0])
	}
	return tb.Text, time.Since(start)
}

// Pinned task already terminal: sleep returns immediately (no dead-wait,
// never fails) with a pointer to bg_check.
func TestSleepReturnsImmediatelyWhenPinnedDone(t *testing.T) {
	tool := &SleepTool{Host: pinHost{status: "done", label: "sleep 12"}, SessionID: "s"}
	text, elapsed := sleepResultText(t, tool, `{"seconds":300,"waitingFor":"bg_1","summary":"waiting for build"}`)
	if elapsed > 10*time.Second {
		t.Fatalf("pinned-done 300s sleep must return immediately, took %s", elapsed)
	}
	if !strings.Contains(text, "bg_1") || !strings.Contains(text, "bg_check") {
		t.Fatalf("return must name the task + bg_check: %q", text)
	}
}

// Unknown pinned id: warn, never fail.
func TestSleepWarnsOnUnknownPinnedID(t *testing.T) {
	tool := &SleepTool{Host: pinHost{}, SessionID: "s"}
	text, _ := sleepResultText(t, tool, `{"seconds":5,"waitingFor":"bg_nope","summary":"waiting"}`)
	if !strings.Contains(text, "unknown") {
		t.Fatalf("unknown id must warn: %q", text)
	}
}

// waitingFor/summary are required; summary trims and caps at 100.
func TestSleepRequiresWaitingForAndSummary(t *testing.T) {
	tool := &SleepTool{Host: pinHost{status: "running", label: "x"}, SessionID: "s"}
	for _, args := range []string{
		`{"seconds":5,"summary":"waiting"}`,
		`{"seconds":5,"waitingFor":"bg_1"}`,
		`{"seconds":5,"waitingFor":"bg_1","summary":"   "}`,
	} {
		if _, err := tool.Execute(context.Background(), []byte(args), nil); err == nil {
			t.Fatalf("args %s must fail", args)
		}
	}
}

// Running pinned task: a short sleep runs its course with the summary up front.
func TestSleepRunsFullWhenPinnedRunning(t *testing.T) {
	tool := &SleepTool{Host: pinHost{status: "running", label: "sleep 12"}, SessionID: "s"}
	text, elapsed := sleepResultText(t, tool, `{"seconds":1,"waitingFor":"bg_1","summary":"waiting for build"}`)
	if elapsed < time.Second {
		t.Fatalf("sleep must run its full second, took %s", elapsed)
	}
	if !strings.Contains(text, "waiting for build") || !strings.Contains(text, "Slept 1s.") {
		t.Fatalf("expected summary + completion, got %q", text)
	}
}
