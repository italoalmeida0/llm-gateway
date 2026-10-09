package tools

import (
	"context"
	"encoding/json"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// FinishEntireRequestTool is the ONLY way a turn ends with a user-visible
// message. There is no second, near-synonymous completion tool: plan, build
// and learning modes all expose this same name and differ only in the
// description variant selected by Mode ("", "build", "learning" and "plan"
// are accepted; anything else falls back to the build text).
type FinishEntireRequestTool struct {
	// OnFinish runs before the tool reports success (it records the turn as
	// completed). It is required in practice: without it the turn does not
	// end.
	OnFinish func() error
	Mode     string
}

// finishArgs is the model-facing argument set. There are no aliases or
// fallbacks: final_message_to_user is the one and only accepted key.
type finishArgs struct {
	FinalMessageToUser string `json:"final_message_to_user"`
}

const finishArgsJSON = `{"type":"object","properties":{"final_message_to_user":{"type":"string","description":"The final message delivered to the user (Markdown). This is the ONLY text the user ever reads: tool calls, commentary and progress updates are invisible to them. Write the complete answer here — what changed and where, how it was validated, anything the user must know or do next."}},"required":["final_message_to_user"]}`

func (*FinishEntireRequestTool) Name() string { return "finish_entire_request" }

// Description is mode-dependent: Build/Learning report finished work, Plan
// reports a finished plan for review.
func (t *FinishEntireRequestTool) Description() string {
	switch t.Mode {
	case "plan":
		return "Finish the turn and hand your implementation plan to the user for review. Call this tool once, when the plan is complete AND you have nothing left to inspect — never between plan steps. Put the entire plan in final_message_to_user: the single text the user reads. Everything you wrote outside this tool is discarded and invisible. Do not call this tool while more inspection or clarification is still pending."
	case "learning":
		return "Finish the turn and deliver your report to the learner. Call this tool once, when the whole request is handled AND you have nothing left to run — never between steps. Put the complete report in final_message_to_user: what you read, tested and verified, your observations, hints and the next guiding question — never the solution itself. This is the ONLY text the learner reads; everything written outside this tool is discarded and invisible. Do not call this tool while more inspection, verification or explanation is still pending."
	default:
		return "Finish the turn and deliver your final answer to the user. Call this tool EXACTLY ONCE, when the ENTIRE request is done — all requested changes implemented, validated and verified — or immediately when the user only asked a question. Never call it after an intermediate step, while a checklist item is still open, or while background tasks you depend on are still running. Put everything the user must know in final_message_to_user: this is the ONLY text they read, so tool calls, progress updates and any text written outside this tool are all invisible to them. If you still have work to do, do NOT call this tool: keep working or send a progress update with the summary tool. Do not call it while more implementation, validation or verification is still pending."
	}
}

func (*FinishEntireRequestTool) Schema() json.RawMessage {
	return json.RawMessage(finishArgsJSON)
}

func (t *FinishEntireRequestTool) Execute(ctx context.Context, raw json.RawMessage, _ func(string)) (core.ToolResult, error) {
	var args finishArgs
	_ = json.Unmarshal(raw, &args)
	message := strings.TrimSpace(args.FinalMessageToUser)
	if message == "" {
		return core.ToolResult{
			IsError: true,
			Content: []provider.Content{provider.TextBlock{Text: "final_message_to_user is required: write the complete final message for the user (Markdown). It is the only text they read."}},
		}, nil
	}
	if t.OnFinish != nil {
		if err := t.OnFinish(); err != nil {
			return core.ToolResult{}, err
		}
	}
	const done = "Request finished; final_message_to_user is the only text the user reads."
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: done}},
		Attrs:   []core.Attr{{Key: "info", Value: done}},
	}, nil
}
