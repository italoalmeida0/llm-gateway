package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// bgJobIDPattern matches the ids the daemon issues for detached
// commands ("bg_" + lowercase hex). Anything else is a hallucinated or
// copied-from-prose id and gets a self-explaining error up front.
var bgJobIDPattern = regexp.MustCompile(`^bg_[0-9a-f]+$`)

// checkBgJobID validates a bg job id and returns the model-facing error
// for a malformed one.
func checkBgJobID(tool, jobID string) error {
	if bgJobIDPattern.MatchString(jobID) {
		return nil
	}
	return fmt.Errorf("%s: %q is not a valid job_id — it must be the bg_… id from the detached command's placeholder (for example bg_1a2b3c4d5e6f7a8b). Never invent ids: call %s with the job_id reported when the command detached.", tool, jobID, tool)
}

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
	return fmt.Sprintf(`Read a background task's log (one of YOUR session's bg tasks that went to the background after %s). Works like read but for task output: paged by lines, tail by default. Pass the job_id from the detach placeholder; use offset/limit for large logs. The result shows lines From–To of Total plus whether the task is still running.`, humanDuration(AutoBackgroundAfter))
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
	jobID := strings.TrimSpace(a.JobID)
	if err := checkBgJobID("bg_check", jobID); err != nil {
		return core.ToolResult{}, err
	}
	if t.Host == nil {
		return core.ToolResult{}, fmt.Errorf("bg_check: no background support")
	}
	res, err := t.Host.ReadBackgroundTask(t.SessionID, jobID, a.Offset, a.Limit)
	if err != nil {
		return core.ToolResult{}, err
	}
	if !res.Found {
		return core.ToolResult{}, fmt.Errorf("bg_check: unknown background task %s", jobID)
	}
	var sb strings.Builder
	var attrs []core.Attr
	attrs = append(attrs,
		core.Attr{Key: "kind", Value: res.Kind},
		core.Attr{Key: "status", Value: res.Status},
		core.Attr{Key: "command", Value: res.Label},
	)
	if res.Status != "running" {
		attrs = append(attrs, core.Attr{Key: "exit", Value: fmt.Sprintf("%d", res.ExitCode)})
	}
	if res.Total == 0 {
		// Empty body: the log has no output yet. The note is metadata
		// (info=), never body prose — the body is only tool output.
		attrs = append(attrs, core.Attr{Key: "info", Value: "No output yet."})
	} else {
		attrs = append(attrs, core.Attr{Key: "page", Value: fmt.Sprintf("%d-%d/%d", res.From, res.To, res.Total)})
		if res.Dropped > 0 {
			attrs = append(attrs, core.Attr{Key: "dropped", Value: fmt.Sprintf("%d", res.Dropped)})
		}
		if res.Text != "" {
			sb.WriteString(numberedLines(res.Text, res.From))
		}
		if res.To < res.Total {
			attrs = append(attrs, core.Attr{Key: "next", Value: fmt.Sprintf("%d", res.To+1)})
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: sb.String()}},
		Attrs:   attrs,
	}, nil
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
