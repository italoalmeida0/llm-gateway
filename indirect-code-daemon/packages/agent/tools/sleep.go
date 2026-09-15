package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// SleepArgs are the model-facing arguments of the sleep tool.
type SleepArgs struct {
	// Seconds to wait (1–3600). The wait ends early — with a notice —
	// when a background task finishes while sleeping.
	Seconds float64 `json:"seconds"`
}

// SleepHost lets the sleep tool observe background jobs: while it waits,
// any of the session's jobs finishing wakes it immediately.
type SleepHost interface {
	// WaitForAnyJob reports (via channel close) when any job owned by
	// sessionID leaves the running state. The channel is closed at most
	// once; nil = no background support (sleep runs its full duration).
	WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{}
}

// BgFreshnessHost is an optional SleepHost extension: it reports a task
// that finished just before the sleep started, so a long sleep decided
// on stale state returns immediately instead of waiting out the full
// duration for an event that already happened.
type BgFreshnessHost interface {
	// RecentBgFinish returns the label and age of the session's most
	// recently finished job (any terminal status) — but only when no
	// session job is still running (otherwise the watcher owns the wait).
	// ok=false when there is nothing freshly finished to skip for.
	RecentBgFinish(sessionID string) (label string, ago time.Duration, ok bool)
}

// sleepFreshGrace bounds the staleness window: a job that finished less
// than this ago (a model roundtrip) when a LONG sleep starts means the
// sleep was decided before the completion landed — return immediately.
// Short sleeps always run (cheap; preserves pacing/backoff uses).
const sleepFreshGrace = 60 * time.Second

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
	return `Wait for a bounded number of seconds. Use it to pause while a background task (a bash/python command that went to the background after 10s) runs, instead of polling in a tight loop. The wait ends EARLY — with a notice — as soon as one of your background tasks finishes, so prefer overestimating: sleep(120) returns immediately when the task completes after 5s. If the task already finished just before the sleep starts, a long sleep is skipped at once (the notice is already in context). Available in plan, build and learning modes only.`
}

func (*SleepTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"seconds":{"type":"number","minimum":1,"maximum":3600,"description":"Seconds to wait (1–3600). Ends early when a background task finishes."}},"required":["seconds"]}`)
}

func (t *SleepTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a SleepArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if a.Seconds < 1 || a.Seconds != a.Seconds || a.Seconds > 3600 {
		return core.ToolResult{}, fmt.Errorf("seconds must be between 1 and 3600")
	}
	wait := time.Duration(a.Seconds * float64(time.Second))
	// Stale-decision shortcut: the job finished after the model asked for
	// this sleep but before it started executing (detach at 10s, finish at
	// 11s, sleep issued from a stale roundtrip). Its delivery notice is
	// already in context — waiting the full duration would dead-wait.
	if t.Host != nil && wait > sleepFreshGrace {
		if fh, ok := t.Host.(BgFreshnessHost); ok {
			if label, ago, found := fh.RecentBgFinish(t.SessionID); found && ago < sleepFreshGrace {
				return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Background task %s finished %s ago — its delivery notice is already in context above (read the .log file for the output). Skipping the %s wait. If you still want to pause (e.g. rate-limit backoff), sleep again.", label, humanizeSeconds(ago.Seconds()), humanizeSeconds(a.Seconds))}}}, nil
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
		return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: "Sleep cancelled."}}}, nil
	case <-timer.C:
		return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Slept %s.", humanizeSeconds(a.Seconds))}}}, nil
	case <-wake:
		return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Woken early after %s: a background task finished — its completion notice is now in context.", humanizeSeconds(time.Since(start).Seconds()))}}}, nil
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
