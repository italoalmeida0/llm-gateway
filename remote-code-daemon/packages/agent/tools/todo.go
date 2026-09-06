package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

type TodoItem struct {
	ID     string `json:"id"`
	Text   string `json:"text"`
	Status string `json:"status"`
}

// TodoTool exposes the task plan in every mode. The host owns persistence.
type TodoTool struct{ Update func([]TodoItem) error }

func (*TodoTool) Name() string { return "todo" }
func (*TodoTool) Description() string {
	return "Create or update the visible task checklist. Send the full list, keep at most one item in_progress, and mark finished work completed. Use for multi-step tasks and keep it current as work progresses."
}
func (*TodoTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"items":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["id","text","status"]}}},"required":["items"]}`)
}
func (t *TodoTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var req struct {
		Items []TodoItem `json:"items"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return core.ToolResult{}, err
	}
	if req.Items == nil || len(req.Items) > 100 {
		return core.ToolResult{}, fmt.Errorf("items must be an array with at most 100 entries")
	}
	seen := map[string]bool{}
	active := 0
	for i := range req.Items {
		item := &req.Items[i]
		item.ID, item.Text = strings.TrimSpace(item.ID), strings.TrimSpace(item.Text)
		if item.ID == "" || seen[item.ID] || len(item.ID) > 100 || item.Text == "" || len(item.Text) > 1000 {
			return core.ToolResult{}, fmt.Errorf("each item needs a unique id and a nonempty short description")
		}
		seen[item.ID] = true
		switch item.Status {
		case "in_progress":
			active++
		case "pending", "completed":
		default:
			return core.ToolResult{}, fmt.Errorf("invalid todo status: %s", item.Status)
		}
	}
	if active > 1 {
		return core.ToolResult{}, fmt.Errorf("only one item can be in_progress")
	}
	if err := ctx.Err(); err != nil {
		return core.ToolResult{}, err
	}
	if t.Update != nil {
		if err := t.Update(req.Items); err != nil {
			return core.ToolResult{}, err
		}
	}
	data, _ := json.Marshal(req.Items)
	return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: string(data)}}, Details: req.Items}, nil
}
