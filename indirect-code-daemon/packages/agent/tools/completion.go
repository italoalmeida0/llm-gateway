package tools

import (
	"context"
	"encoding/json"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// MarkTaskAsCompleteTool allows the model to signal completion in Build and
// Learning modes. Mode selects the description variant so the model only
// reads guidance for the mode it is actually in ("", "build" and "learning"
// are the accepted values; anything else falls back to the build text).
type MarkTaskAsCompleteTool struct {
	OnComplete func() error
	Mode       string
}

type completionArgs struct {
	ComprehensiveSummary string `json:"comprehensive_summary"`
	Notes                string `json:"notes"`
	Summary              string `json:"summary"`
}

func (*MarkTaskAsCompleteTool) Name() string { return "mark_task_as_complete" }
func (t *MarkTaskAsCompleteTool) Description() string {
	if t.Mode == "learning" {
		return "Signal that you have fully completed the requested task, or provide your direct answer if the user only asked a question without requesting file changes. Call this tool with a comprehensive_summary of what was completed or your complete answer to the user's inquiry: your report of what you read, tested and verified — observations, hints and the next guiding question; never the solution itself."
	}
	return "Signal that you have fully completed the requested task, or provide your direct answer if the user only asked a question without requesting file changes. Call this tool with a comprehensive_summary of what was completed or your complete answer to the user's inquiry."
}
func (*MarkTaskAsCompleteTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"comprehensive_summary":{"type":"string","description":"Comprehensive summary of completed work, or the direct answer to the user's question."},"notes":{"type":"string","description":"Optional notes."}},"required":["comprehensive_summary"]}`)
}
func (t *MarkTaskAsCompleteTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var args completionArgs
	_ = json.Unmarshal(raw, &args)
	summary := strings.TrimSpace(args.ComprehensiveSummary)
	if summary == "" {
		summary = strings.TrimSpace(args.Summary)
	}
	if summary == "" {
		summary = strings.TrimSpace(args.Notes)
	}
	if summary == "" {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: "comprehensive_summary is required: provide a comprehensive summary of completed work, or the direct answer to the user's question."}},
		}, nil
	}
	if t.OnComplete != nil {
		if err := t.OnComplete(); err != nil {
			return core.ToolResult{}, err
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "Task marked as complete."}},
		Attrs:   []core.Attr{{Key: "info", Value: "Task marked as complete."}},
	}, nil
}

// MarkPlanAsReadyToExecuteTool allows the model to signal that its plan is ready in Plan mode.
type MarkPlanAsReadyToExecuteTool struct {
	OnReady func() error
}

func (*MarkPlanAsReadyToExecuteTool) Name() string { return "mark_plan_as_ready_to_execute" }
func (*MarkPlanAsReadyToExecuteTool) Description() string {
	return "Signal that your implementation plan is complete and ready for user review and execution. Call this tool with a comprehensive_summary detailing the plan."
}
func (*MarkPlanAsReadyToExecuteTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"comprehensive_summary":{"type":"string","description":"Comprehensive summary of the proposed implementation plan."},"notes":{"type":"string","description":"Optional notes."}},"required":["comprehensive_summary"]}`)
}
func (t *MarkPlanAsReadyToExecuteTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var args completionArgs
	_ = json.Unmarshal(raw, &args)
	summary := strings.TrimSpace(args.ComprehensiveSummary)
	if summary == "" {
		summary = strings.TrimSpace(args.Summary)
	}
	if summary == "" {
		summary = strings.TrimSpace(args.Notes)
	}
	if summary == "" {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: "comprehensive_summary is required: provide a comprehensive summary of the proposed implementation plan."}},
		}, nil
	}
	if t.OnReady != nil {
		if err := t.OnReady(); err != nil {
			return core.ToolResult{}, err
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "Plan marked as ready to execute."}},
		Attrs:   []core.Attr{{Key: "info", Value: "Plan marked as ready to execute."}},
	}, nil
}
