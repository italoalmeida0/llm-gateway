package core

import "testing"

// TestAgentEventTypeStrings locks the WS wire contract: the frontend and
// the frozen protocol in docs/actor-migration-plan.md discriminate events
// by these exact strings. Renaming one silently breaks every client.
func TestAgentEventTypeStrings(t *testing.T) {
	cases := []struct {
		ev   AgentEvent
		want string
	}{
		{EvTurnStart{}, "turn_start"},
		{EvUserMessage{}, "user_message"},
		{EvAssistantStart{}, "assistant_start"},
		{EvTextDelta{}, "text_delta"},
		{EvReasoningDelta{}, "reasoning_delta"},
		{EvToolCall{}, "tool_call"},
		{EvToolUseStart{}, "tool_use_start"},
		{EvToolUseArgs{}, "tool_use_args"},
		{EvToolUseEnd{}, "tool_use_end"},
		{EvToolProgress{}, "tool_progress"},
		{EvToolExecutionStart{}, "tool_execution_start"},
		{EvToolResult{}, "tool_result"},
		{EvUsage{}, "usage"},
		{EvAssistantMessage{}, "assistant_message"},
		{EvTurnEnd{}, "turn_end"},
		{EvRetry{}, "retry"},
		{EvDone{}, "done"},
	}
	for _, c := range cases {
		if got := c.ev.Type(); got != c.want {
			t.Errorf("%T.Type() = %q, want %q", c.ev, got, c.want)
		}
	}
}
