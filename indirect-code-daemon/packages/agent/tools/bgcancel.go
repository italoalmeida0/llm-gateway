package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// BgCancelArgs are the model-facing arguments of the bg_cancel tool.
type BgCancelArgs struct {
	// JobID is the background job to cancel (bg_… from the detached
	// command's placeholder). Required.
	JobID string `json:"job_id"`
}

// BgCancelOutcome is the daemon-side result of a cancel attempt.
type BgCancelOutcome struct {
	// OK reports whether the job was found, owned by the caller and
	// actually cancelled (false when it had already finished).
	OK bool
	// Status is the job status after the attempt ("cancelled", "done", …).
	Status string
	// Notice is the model-facing text.
	Notice string
}

// BgCancelHost is implemented by the daemon: the registry + ownership
// checks live there, the tool only validates args and delegates.
type BgCancelHost interface {
	CancelBackgroundJob(callerSessionID, jobID string) (BgCancelOutcome, error)
}

// BgCancelTool force-stops one of this session's background tasks — a
// detached bash/python process. Only registered in modes whose allowlist
// includes it (see modeRegistry in the daemon).
type BgCancelTool struct {
	Host      BgCancelHost
	SessionID string
}

func (*BgCancelTool) Name() string { return "bg_cancel" }
func (*BgCancelTool) Description() string {
	return `Force-stop one of YOUR background tasks: a bash/python command that went to the background (it gave you its job_id when it detached). The process is killed and the job is marked cancelled; no completion notice is delivered — re-run the command differently instead of waiting. Already-finished jobs cannot be cancelled. Unknown or foreign ids are refused.`
}
func (*BgCancelTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"job_id":{"type":"string","description":"Background job id (bg_…)."}},"required":["job_id"]}`)
}

func (t *BgCancelTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var a BgCancelArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, err
	}
	if strings.TrimSpace(a.JobID) == "" {
		return core.ToolResult{}, fmt.Errorf("bg_cancel: job_id is required")
	}
	if t.Host == nil {
		return core.ToolResult{}, fmt.Errorf("bg_cancel: host not configured")
	}
	out, err := t.Host.CancelBackgroundJob(t.SessionID, strings.TrimSpace(a.JobID))
	if err != nil {
		return core.ToolResult{}, err
	}
	attrs := []core.Attr{
		{Key: "job_id", Value: strings.TrimSpace(a.JobID)},
		{Key: "cancelled", Value: fmt.Sprintf("%t", out.OK)},
		{Key: "status", Value: out.Status},
	}
	if out.Notice != "" {
		attrs = append(attrs, core.Attr{Key: "info", Value: out.Notice})
	}
	return core.ToolResult{
		Content: nil,
		Attrs:   attrs,
		Details: map[string]any{
			"background_job_id": a.JobID,
			"cancelled":         out.OK,
			"status":            out.Status,
		},
	}, nil
}
