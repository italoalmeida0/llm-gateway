package tools

import (
	"context"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
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

func sleepResult(t *testing.T, tool *SleepTool, args string) (core.ToolResult, time.Duration) {
	t.Helper()
	start := time.Now()
	res, err := tool.Execute(context.Background(), []byte(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res, time.Since(start)
}

// Pinned task already terminal: sleep returns immediately (no dead-wait,
// never fails) with a pointer to bg_check.
func TestSleepReturnsImmediatelyWhenPinnedDone(t *testing.T) {
	tool := &SleepTool{Host: pinHost{status: "done", label: "sleep 12"}, SessionID: "s"}
	res, elapsed := sleepResult(t, tool, `{"seconds":300,"waitingFor":"bg_1","summary":"waiting for build"}`)
	if elapsed > 10*time.Second {
		t.Fatalf("pinned-done 300s sleep must return immediately, took %s", elapsed)
	}
	info := envAttr(res, "info")
	if !strings.Contains(info, "bg_1") || !strings.Contains(info, "bg_check") {
		t.Fatalf("info must name the task + bg_check: %q", info)
	}
}

// Unknown pinned id: warn, never fail.
func TestSleepWarnsOnUnknownPinnedID(t *testing.T) {
	tool := &SleepTool{Host: pinHost{}, SessionID: "s"}
	res, _ := sleepResult(t, tool, `{"seconds":5,"waitingFor":"bg_nope","summary":"waiting"}`)
	if !strings.Contains(envAttr(res, "info"), "unknown") {
		t.Fatalf("unknown id must warn: %q", envAttr(res, "info"))
	}
	if got := envAttr(res, "status"); got != "unknown_task" {
		t.Fatalf("status attr = %q", got)
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
	res, elapsed := sleepResult(t, tool, `{"seconds":1,"waitingFor":"bg_1","summary":"waiting for build"}`)
	if elapsed < time.Second {
		t.Fatalf("sleep must run its full second, took %s", elapsed)
	}
	if envAttr(res, "summary") != "waiting for build" || envAttr(res, "status") != "slept" {
		t.Fatalf("expected summary + slept status, got %q / %q", envAttr(res, "summary"), envAttr(res, "status"))
	}
}
