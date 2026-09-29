package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// SummaryTool allows the agent to report progress during long turns.
// It requires for_user (user-facing progress message) and for_me (internal scratchpad/tracking).
type SummaryTool struct {
	OnSummary func(forUser, forMe string) error
}

type summaryArgs struct {
	ForUser string `json:"for_user"`
	ForMe   string `json:"for_me"`
}

func (*SummaryTool) Name() string { return "summary" }

func (*SummaryTool) Description() string {
	return "Report a progress summary when requested by an automated system notification. Requires 'for_user' (~500 chars, min 100 chars) as a user-facing update, and 'for_me' for internal tracking of next steps, hypotheses, and what was already tested."
}

func (*SummaryTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"for_user":{"type":"string","description":"Progress update written for the user (minimum 100 characters, around 500 characters)."},"for_me":{"type":"string","description":"Internal tracking for yourself: explain what you are currently doing, your planned next steps, and what you have already verified/tested."}},"required":["for_user","for_me"]}`)
}

func (t *SummaryTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var args summaryArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("invalid arguments for summary: %v", err)}},
		}, nil
	}

	userRunes := []rune(strings.TrimSpace(args.ForUser))
	if len(userRunes) < 100 {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("for_user summary is too short (must be at least 100 characters; received %d characters). Please provide a helpful progress update for the user.", len(userRunes))}},
		}, nil
	}

	forUser := strings.TrimSpace(args.ForUser)
	if len(userRunes) > 500 {
		forUser = string(userRunes[:500]) + "..."
	}

	forMe := strings.TrimSpace(args.ForMe)
	if forMe == "" {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: "for_me is required: explain what you are doing, your next steps, and what you have verified."}},
		}, nil
	}

	if t != nil && t.OnSummary != nil {
		if err := t.OnSummary(forUser, forMe); err != nil {
			return core.ToolResult{}, err
		}
	}

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: "Progress summary recorded. Continue your work towards completing the task."}},
		Attrs: []core.Attr{
			{Key: "info", Value: "Progress summary recorded."},
		},
	}, nil
}
