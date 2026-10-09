package tools

import (
	"context"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// pinHost fakes BgAwaitHost + BgAwaitCheckHost: one pinned task with a
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

func awaitResult(t *testing.T, tool *BgAwaitTool, args string) (core.ToolResult, time.Duration) {
	t.Helper()
	start := time.Now()
	res, err := tool.Execute(context.Background(), []byte(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res, time.Since(start)
}

// Pinned task already terminal: bg_await returns immediately (no dead-wait,
// never fails) with a pointer to bg_check.
func TestBgAwaitReturnsImmediatelyWhenPinnedDone(t *testing.T) {
	tool := &BgAwaitTool{Host: pinHost{status: "done", label: "bun test"}, SessionID: "s"}
	res, elapsed := awaitResult(t, tool, `{"max_wait_seconds":300,"waiting_for":"bg_1","reason":"waiting for build"}`)
	if elapsed > 10*time.Second {
		t.Fatalf("pinned-done 300s await must return immediately, took %s", elapsed)
	}
	info := envAttr(res, "info")
	if !strings.Contains(info, "bg_1") || !strings.Contains(info, "bg_check") {
		t.Fatalf("info must name the task + bg_check: %q", info)
	}
}

// Unknown pinned id: warn, never fail.
func TestBgAwaitWarnsOnUnknownPinnedID(t *testing.T) {
	tool := &BgAwaitTool{Host: pinHost{}, SessionID: "s"}
	res, _ := awaitResult(t, tool, `{"max_wait_seconds":5,"waiting_for":"bg_nope","reason":"waiting"}`)
	if !strings.Contains(envAttr(res, "info"), "unknown") {
		t.Fatalf("unknown id must warn: %q", envAttr(res, "info"))
	}
	if got := envAttr(res, "status"); got != "unknown_task" {
		t.Fatalf("status attr = %q", got)
	}
}

// waiting_for/reason are required; reason trims and caps at 100.
func TestBgAwaitRequiresWaitingForAndReason(t *testing.T) {
	tool := &BgAwaitTool{Host: pinHost{status: "running", label: "x"}, SessionID: "s"}
	for _, args := range []string{
		`{"max_wait_seconds":5,"reason":"waiting"}`,
		`{"max_wait_seconds":5,"waiting_for":"bg_1"}`,
		`{"max_wait_seconds":5,"waiting_for":"bg_1","reason":"   "}`,
		`{"waiting_for":"bg_1","reason":"waiting"}`,
	} {
		if _, err := tool.Execute(context.Background(), []byte(args), nil); err == nil {
			t.Fatalf("args %s must fail", args)
		}
	}
}

// Running pinned task: a short await runs its course with the reason up front.
func TestBgAwaitRunsFullWhenPinnedRunning(t *testing.T) {
	tool := &BgAwaitTool{Host: pinHost{status: "running", label: "bun test"}, SessionID: "s"}
	res, elapsed := awaitResult(t, tool, `{"max_wait_seconds":1,"waiting_for":"bg_1","reason":"waiting for build"}`)
	if elapsed < time.Second {
		t.Fatalf("bg_await must run its full second, took %s", elapsed)
	}
	if envAttr(res, "summary") != "waiting for build" || envAttr(res, "status") != "timeout" {
		t.Fatalf("expected reason + timeout status, got %q / %q", envAttr(res, "summary"), envAttr(res, "status"))
	}
	if envAttr(res, "waited") != "1s" {
		t.Fatalf("waited attr = %q", envAttr(res, "waited"))
	}
}
