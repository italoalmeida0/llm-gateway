package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// BgCheckArgs are the model-facing arguments of the bg_check tool.
type BgCheckArgs struct {
	// JobID is the background task to read (bg_… from the detached
	// command's placeholder). Required.
	JobID string `json:"job_id"`
	// Offset is the 1-indexed first line to read (over the task's total
	// lines). <=0 (default) reads the tail: the last Limit lines.
	Offset int `json:"offset,omitempty"`
	// Limit caps the returned lines (default 50, max 500).
	Limit int `json:"limit,omitempty"`
}

// BgCheckResult is one paged read of a background task's log.
type BgCheckResult struct {
	Found     bool
	Kind      string
	Label     string
	Status    string
	ExitCode  int
	Text      string
	From      int64
	To        int64
	Total     int64
	Dropped   int64
	Truncated bool
}

// BgCheckHost is implemented by the daemon: the session owns the logs,
// the tool only validates args and delegates.
type BgCheckHost interface {
	ReadBackgroundTask(callerSessionID, jobID string, offset, limit int) (BgCheckResult, error)
}

// BgCheckTool reads a session background task's log, like read reads a
// file: paged by lines, tail by default. The header reports the stable
// range (lines From–To of Total) plus the task status; when the head was
// discarded by the tail cap, the dropped count is shown so line numbers
// stay stable across reads.
type BgCheckTool struct {
	Host      BgCheckHost
	SessionID string
}

func (*BgCheckTool) Name() string { return "bg_check" }
func (*BgCheckTool) Description() string {
	return `Read a background task's log (one of YOUR session's bg tasks that went to the background after 10s). Works like read but for task output: paged by lines, tail by default. Pass the job_id from the detach placeholder; use offset/limit for large logs. The result shows lines From–To of Total plus whether the task is still running. Available in plan, build and learning modes only.`
}
func (*BgCheckTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"job_id":{"type":"string","description":"Background task id (bg_…)."},"offset":{"type":"integer","description":"1-indexed first line to read (over total lines); <=0 reads the tail (default)"},"limit":{"type":"integer","description":"Maximum lines to return (default 50, max 500)"}},"required":["job_id"]}`)
}

func (t *BgCheckTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var a BgCheckArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, err
	}
	if strings.TrimSpace(a.JobID) == "" {
		return core.ToolResult{}, fmt.Errorf("bg_check: job_id is required")
	}
	if t.Host == nil {
		return core.ToolResult{}, fmt.Errorf("bg_check: no background support")
	}
	res, err := t.Host.ReadBackgroundTask(t.SessionID, strings.TrimSpace(a.JobID), a.Offset, a.Limit)
	if err != nil {
		return core.ToolResult{}, err
	}
	if !res.Found {
		return core.ToolResult{}, fmt.Errorf("bg_check: unknown background task %s", strings.TrimSpace(a.JobID))
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "Background Task (%s) — %s\n", res.Kind, res.Status)
	if res.Label != "" {
		fmt.Fprintf(&sb, "Command: %s\n", res.Label)
	}
	if res.Total == 0 {
		sb.WriteString("No output yet.\n")
	} else {
		fmt.Fprintf(&sb, "Lines %d–%d of %d", res.From, res.To, res.Total)
		if res.Dropped > 0 {
			fmt.Fprintf(&sb, " (%d earlier lines discarded by the tail cap)", res.Dropped)
		}
		sb.WriteString("\n")
		if res.Text != "" {
			sb.WriteString(numberedLines(res.Text, res.From))
		}
		if res.To < res.Total {
			fmt.Fprintf(&sb, "\n[%d more lines: call bg_check again with offset %d]", res.Total-res.To, res.To+1)
		}
	}
	if res.Status == "running" {
		sb.WriteString("\nStatus: still running.")
	} else {
		fmt.Fprintf(&sb, "\nStatus: %s (exit %d).", res.Status, res.ExitCode)
	}
	return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: sb.String()}}}, nil
}

func numberedLines(text string, from int64) string {
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	var sb strings.Builder
	for i, ln := range lines {
		fmt.Fprintf(&sb, "%d:%s", from+int64(i), ln)
		if i < len(lines)-1 {
			sb.WriteString("\n")
		}
	}
	return sb.String()
}
