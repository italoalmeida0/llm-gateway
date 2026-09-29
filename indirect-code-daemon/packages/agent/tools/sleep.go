package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// SleepArgs are the model-facing arguments of the sleep tool.
type SleepArgs struct {
	// Seconds to wait (1–3600). The wait ends early — with a notice —
	// when a background task finishes while sleeping.
	Seconds float64 `json:"seconds"`
	// WaitingFor is the bg task id (bg_…) this sleep waits on. Required:
	// it pins the wait to a task that is still running, so a stale
	// sleep (task already finished) returns immediately instead of
	// dead-waiting or failing.
	WaitingFor string `json:"waitingFor"`
	// Summary is a ≤100-char note shown in the row body (what is being
	// waited on). Required, non-empty after trim; longer text is cut.
	Summary string `json:"summary"`
}

// SleepHost lets the sleep tool observe background jobs: while it waits,
// any of the session's jobs finishing wakes it immediately.
type SleepHost interface {
	// WaitForAnyJob reports (via channel close) when any job owned by
	// sessionID leaves the running state. The channel is closed at most
	// once; nil = no background support (sleep runs its full duration).
	WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{}
}

// BgSleepCheckHost is an optional SleepHost extension: it reports the
// state of ONE task, so sleep(waitingFor=id) can return immediately when
// the pinned task already left the running state.
type BgSleepCheckHost interface {
	// BgTaskStatus returns the task status ("running", "done", "error",
	// "cancelled") and label. ok=false when the id is unknown or foreign.
	BgTaskStatus(sessionID, jobID string) (status, label string, ok bool)
}

// SleepTool parks the model for a bounded wait — the "wait for the
// background task" primitive. It ends early when a background task of the
// session finishes (the system-reminder delivery lands in context right
// after), so the model does not need to poll or guess durations.
type SleepTool struct {
	Host      SleepHost
	SessionID string
}

func (*SleepTool) Name() string { return "sleep" }

func (*SleepTool) Description() string {
	return `Wait for a bounded number of seconds while a background task runs. REQUIRED args: waitingFor (the bg task id from the detach placeholder) and summary (≤100 chars describing what you are waiting for, shown in the UI). The wait ends EARLY — with a notice — as soon as one of your background tasks finishes. If the pinned task already finished, sleep returns immediately (no dead-wait, never fails). Prefer overestimating: sleep(120) returns immediately when the task completes after 5s. Available in plan, build and learning modes only.`
}

func (*SleepTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"seconds":{"type":"number","minimum":1,"maximum":3600,"description":"Seconds to wait (1–3600). Ends early when a background task finishes."},"waitingFor":{"type":"string","description":"Background task id (bg_…) this sleep waits on. Required."},"summary":{"type":"string","description":"What you are waiting for, max 100 chars (shown in the UI). Required.","maxLength":100}},"required":["seconds","waitingFor","summary"]}`)
}

func (t *SleepTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a SleepArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if a.Seconds < 1 || a.Seconds != a.Seconds || a.Seconds > 3600 {
		return core.ToolResult{}, fmt.Errorf("seconds must be between 1 and 3600")
	}
	jobID := strings.TrimSpace(a.WaitingFor)
	if jobID == "" {
		return core.ToolResult{}, fmt.Errorf("waitingFor is required: pass the background task id (bg_…) this sleep waits on")
	}
	summary := strings.TrimSpace(a.Summary)
	if summary == "" {
		return core.ToolResult{}, fmt.Errorf("summary is required: describe in ≤100 chars what you are waiting for")
	}
	if len(summary) > 100 {
		summary = summary[:100]
	}
	wait := time.Duration(a.Seconds * float64(time.Second))
	// Pinned-task shortcut: the wait is justified by a task that is still
	// running. Unknown/foreign ids warn (never fail); an already-terminal
	// task returns immediately with a pointer to bg_check.
	if t.Host != nil {
		if ch, ok := t.Host.(BgSleepCheckHost); ok {
			status, label, found := ch.BgTaskStatus(t.SessionID, jobID)
			if !found {
				return core.ToolResult{Attrs: []core.Attr{
					{Key: "summary", Value: summary},
					{Key: "status", Value: "unknown_task"},
					{Key: "job_id", Value: jobID},
					{Key: "info", Value: fmt.Sprintf("background task %s is unknown in this session — nothing to wait for. Use bg_check with a valid id.", jobID)},
				}}, nil
			}
			if status != "running" {
				return core.ToolResult{Attrs: []core.Attr{
					{Key: "summary", Value: summary},
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
	// No ticking progress: the row body stays empty while sleeping and the
	// header shows a live remaining counter instead (computed client-side
	// from the tool start). Progress events append forever, so a per-second
	// tick would pile "29s left28s left…" into the transcript.
	_ = progress

	var wake <-chan struct{}
	if t.Host != nil {
		// Child context so the registry watcher exits when the sleep
		// itself ends (timer, cancel or early wake): otherwise every
		// sleep call leaks one polling goroutine until the turn ends.
		sleepCtx, stopWatch := context.WithCancel(context.Background())
		defer stopWatch()
		wake = t.Host.WaitForAnyJob(t.SessionID, sleepCtx.Done())
	}

	start := time.Now()
	select {
	case <-ctx.Done():
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: summary},
			{Key: "status", Value: "cancelled"},
			{Key: "job_id", Value: jobID},
		}}, nil
	case <-timer.C:
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: summary},
			{Key: "status", Value: "slept"},
			{Key: "job_id", Value: jobID},
			{Key: "waited", Value: humanizeSeconds(a.Seconds)},
		}}, nil
	case <-wake:
		return core.ToolResult{Attrs: []core.Attr{
			{Key: "summary", Value: summary},
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
