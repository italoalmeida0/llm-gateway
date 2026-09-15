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
	return `Wait for a bounded number of seconds. Use it to pause while a background task (a bash/python command that went to the background after 10s) runs, instead of polling in a tight loop. The wait ends EARLY — with a notice — as soon as one of your background tasks finishes, so prefer overestimating: sleep(120) returns immediately when the task completes after 5s. Available in plan, build and learning modes only.`
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

func humanizeSeconds(s float64) string {
	if s < 60 {
		return fmt.Sprintf("%.0fs", s)
	}
	m := int(s) / 60
	sec := int(s) % 60
	if m < 60 {
		return fmt.Sprintf("%dm%02ds", m, sec)
	}
	return fmt.Sprintf("%dh%02dm", m/60, m%60)
}
