package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// BgAwaitArgs are the model-facing arguments of the bg_await tool.
type BgAwaitArgs struct {
	// Seconds to wait (1–3600). The wait ends early — with a notice —
	// when a background task finishes while sleeping.
	MaxWaitSeconds float64 `json:"max_wait_seconds"`
	// WaitingFor is the bg task id (the job_id from the detached
	// command's placeholder) this sleep waits on. Required:
	// it pins the wait to a task that is still running, so a stale
	// sleep (task already finished) returns immediately instead of
	// dead-waiting or failing.
	WaitingFor string `json:"waiting_for"`
	// Summary is a ≤100-char note shown in the row body (what is being
	// waited on). Required, non-empty after trim; longer text is cut.
	Reason string `json:"reason"`
}

// BgAwaitHost lets the bg_await tool observe background jobs: while it waits,
// any of the session's jobs finishing wakes it immediately.
type BgAwaitHost interface {
	// WaitForAnyJob reports (via channel close) when any job owned by
	// sessionID leaves the running state. The channel is closed at most
	// once; nil = no background support (the await runs its full duration).
	WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{}
}

// BgAwaitCheckHost is an optional BgAwaitHost extension: it reports the
// state of ONE task, so bg_await(waiting_for=id) can return immediately when
// the pinned task already left the running state.
type BgAwaitCheckHost interface {
	// BgTaskStatus returns the task status ("running", "done", "error",
	// "cancelled") and label. ok=false when the id is unknown or foreign.
	BgTaskStatus(sessionID, jobID string) (status, label string, ok bool)
}

// BgAwaitTool parks the model for a bounded wait — the "wait for the
// background task" primitive. It ends early when a background task of the
// session finishes (the system-reminder delivery lands in context right
// after), so the model does not need to poll or guess durations.
type BgAwaitTool struct {
	Host      BgAwaitHost
	SessionID string
}

func (*BgAwaitTool) Name() string { return "bg_await" }

func (*BgAwaitTool) Description() string {
	return `Wait for a background task to finish (or for max_wait_seconds to pass). REQUIRED args: waiting_for (the bg task id from the detach placeholder) and reason (≤100 chars describing what you are waiting for, shown in the UI). The wait ends EARLY — with a notice — as soon as one of your background tasks finishes. If the pinned task already finished, bg_await returns immediately (no dead-wait, never fails). Prefer a generous max_wait_seconds: bg_await(300, ...) returns immediately when the task completes after 5s. Use this instead of a terminal sleep command: a shell sleep would itself detach into another background task.`
}

func (*BgAwaitTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"max_wait_seconds":{"type":"number","minimum":1,"maximum":3600,"description":"Upper bound of the wait in seconds (1–3600). Ends early when a background task finishes."},"waiting_for":{"type":"string","description":"Background task id — the exact job_id from the detached command's placeholder. Required."},"reason":{"type":"string","description":"What you are waiting for, max 100 chars (shown in the UI). Required.","maxLength":100}},"required":["max_wait_seconds","waiting_for","reason"]}`)
}

func (t *BgAwaitTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a BgAwaitArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if a.MaxWaitSeconds < 1 || a.MaxWaitSeconds != a.MaxWaitSeconds || a.MaxWaitSeconds > 3600 {
		return core.ToolResult{}, fmt.Errorf("max_wait_seconds must be between 1 and 3600")
	}
	jobID := strings.TrimSpace(a.WaitingFor)
	if jobID == "" {
		return core.ToolResult{}, fmt.Errorf("waiting_for is required: pass the background task id (the job_id from the detached command's placeholder) this await waits on")
	}
	reason := strings.TrimSpace(a.Reason)
	if reason == "" {
		return core.ToolResult{}, fmt.Errorf("reason is required: describe in ≤100 chars what you are waiting for")
	}
	if len(reason) > 100 {
		reason = reason[:100]
	}
	wait := time.Duration(a.MaxWaitSeconds * float64(time.Second))
	// Pinned-task shortcut: the wait is justified by a task that is still
	// running. Unknown/foreign ids warn (never fail); an already-terminal
	// task returns immediately with a pointer to bg_check.
	if t.Host != nil {
		if ch, ok := t.Host.(BgAwaitCheckHost); ok {
			status, label, found := ch.BgTaskStatus(t.SessionID, jobID)
			if !found {
				return core.ToolResult{Attrs: []core.Attr{
					{Key: "summary", Value: reason},
					{Key: "status", Value: "unknown_task"},
					{Key: "job_id", Value: jobID},
					{Key: "info", Value: fmt.Sprintf("background task %s is unknown in this session — nothing to wait for. Use bg_check with a valid id.", jobID)},
				}}, nil
			}
			if status != "running" {
				return core.ToolResult{Attrs: []core.Attr{
					{Key: "summary", Value: reason},
					{Key: "status", Value: "already_" + status},
					{Key: "job_id", Value: jobID},
					{Key: "command", Value: label},
					{Key: "info", Value: fmt.Sprintf("background task %s (%s) already %s — its completion notice is in context above. Use bg_check with job_id %s to read the output.", jobID, label, status, jobID)},
				}}, nil
			}
		}
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	// No ticking progress: the row body stays empty while waiting and the
	// header shows a live remaining counter instead (computed client-side
	// from the tool start). Progress events append forever, so a per-second
	// tick would pile "29s left28s left…" into the transcript.
	_ = progress

	var wake <-chan struct{}
	if t.Host != nil {
		// Child context so the registry watcher exits when the wait
		// itself ends (timer, cancel or early wake): otherwise every
		// bg_await call leaks one polling goroutine until the turn ends.
		awaitCtx, stopWatch := context.WithCancel(context.Background())
		defer stopWatch()
		wake = t.Host.WaitForAnyJob(t.SessionID, awaitCtx.Done())
	}

	start := time.Now()
	select {
	case <-ctx.Done():
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: reason},
			{Key: "status", Value: "cancelled"},
			{Key: "job_id", Value: jobID},
		}}, nil
	case <-timer.C:
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: reason},
			{Key: "status", Value: "timeout"},
			{Key: "job_id", Value: jobID},
			{Key: "waited", Value: humanizeSeconds(a.MaxWaitSeconds)},
			{Key: "info", Value: fmt.Sprintf("background task %s is still running after %s — its completion notice has not arrived yet. Read what it produced so far with bg_check, or call bg_await again.", jobID, humanizeSeconds(a.MaxWaitSeconds))},
		}}, nil
	case <-wake:
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: reason},
			{Key: "status", Value: "woken_early"},
			{Key: "job_id", Value: jobID},
			{Key: "waited", Value: humanizeSeconds(time.Since(start).Seconds())},
			{Key: "info", Value: "a background task finished — its completion notice is now in context."},
		}}, nil
	}
}

// humanizeSeconds renders a duration in the "Xh Ym Zs" style. Zero parts
// are omitted ("7s", "50m 10s", "2h 20m 2s").
func formatHMS(total int) string {
	if total < 60 {
		return fmt.Sprintf("%ds", total)
	}
	h := total / 3600
	m := (total % 3600) / 60
	sec := total % 60
	if h > 0 {
		parts := fmt.Sprintf("%dh", h)
		if m > 0 {
			parts += fmt.Sprintf(" %dm", m)
		}
		if sec > 0 {
			parts += fmt.Sprintf(" %ds", sec)
		}
		return parts
	}
	if sec > 0 {
		return fmt.Sprintf("%dm %ds", m, sec)
	}
	return fmt.Sprintf("%dm", m)
}

func humanizeSeconds(s float64) string {
	return formatHMS(int(s))
}
