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
// It carries for_user (the visible progress message) and for_me (the model's
// private note, kept in its own transcript and never shown to the user).
type SummaryTool struct {
	OnSummary func(forUser, forMe string) error
}

// SummaryArgs are the model-facing arguments of the summary tool.
type SummaryArgs struct {
	// ForUser is the user-facing progress update (100–500 chars). The
	// frontend extracts it from the tool call and renders it as a visible
	// text bubble; it is what the user reads mid-turn.
	ForUser string `json:"for_user"`
	// ForMe is a private note for the model itself: what it is doing, the
	// next steps, what it already verified. The daemon does NOT consume it
	// (no state, no event, no UI) — it stays in the transcript so the model
	// can re-read how it framed the work earlier. Never shown to the user.
	ForMe string `json:"for_me"`
}

func (*SummaryTool) Name() string { return "summary" }

func (*SummaryTool) Description() string {
	return "Report a progress summary when requested by an automated system notification. Two args: 'for_user' — the visible progress update for the user (100-500 chars; the UI renders it as a text bubble) — and 'for_me' — a private note for your own future reference (what you are doing, next steps, what you already verified). 'for_me' is never shown to the user, never acted on, and simply stays in your transcript so you can re-read it later."
}

func (*SummaryTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"for_user":{"type":"string","description":"Progress update written for the user; rendered as a visible text bubble. Minimum 100 characters, around 500."},"for_me":{"type":"string","description":"Private note for your own future reference: what you are doing, next steps, what you already verified. Never shown to the user and never acted on; it only stays in your transcript."}},"required":["for_user","for_me"]}`)
}

func (t *SummaryTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var args SummaryArgs
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
