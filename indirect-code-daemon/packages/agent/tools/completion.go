package tools

import (
	"context"
	"encoding/json"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// MarkTaskAsCompleteTool allows the model to signal completion in Build mode.
type MarkTaskAsCompleteTool struct {
	OnComplete func() error
}

func (*MarkTaskAsCompleteTool) Name() string { return "mark_task_as_complete" }
func (*MarkTaskAsCompleteTool) Description() string {
	return "Signal that you have fully completed the requested task in Build mode. Call this tool when all requested changes, inspections, and validations are finished."
}
func (*MarkTaskAsCompleteTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"notes":{"type":"string","description":"Optional notes or summary of completed work."}}}`)
}
func (t *MarkTaskAsCompleteTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	if t.OnComplete != nil {
		if err := t.OnComplete(); err != nil {
			return core.ToolResult{}, err
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "Task marked as complete."}},
	}, nil
}

// MarkPlanAsReadyToExecuteTool allows the model to signal that its plan is ready in Plan mode.
type MarkPlanAsReadyToExecuteTool struct {
	OnReady func() error
}

func (*MarkPlanAsReadyToExecuteTool) Name() string { return "mark_plan_as_ready_to_execute" }
func (*MarkPlanAsReadyToExecuteTool) Description() string {
	return "Signal that your implementation plan in Plan mode is complete and ready for user review and execution. Call this tool when requirements are clarified, relevant files identified, and the plan is finalized."
}
func (*MarkPlanAsReadyToExecuteTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"notes":{"type":"string","description":"Optional notes or summary of the plan."}}}`)
}
func (t *MarkPlanAsReadyToExecuteTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	if t.OnReady != nil {
		if err := t.OnReady(); err != nil {
			return core.ToolResult{}, err
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "Plan marked as ready to execute."}},
	}, nil
}
