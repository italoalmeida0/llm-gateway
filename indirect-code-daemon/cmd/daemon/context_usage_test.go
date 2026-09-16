package main

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestEstimateContextCountsPayload(t *testing.T) {
	agent := core.NewAgent(nil, "m", "", core.NewRegistry())
	agent.SetMessages([]provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hello"}}},
	})
	got := estimateContext(agent, provider.Model{ID: "m", ContextWindow: 128000})
	if got == nil || got.UsedTokens <= 0 {
		t.Fatalf("estimateContext = %+v, want counted tokens", got)
	}
	if got.Estimated {
		t.Fatalf("counted context must not be flagged estimated: %+v", got)
	}
	if got.WindowTokens != 128000 {
		t.Fatalf("window = %d, want 128000", got.WindowTokens)
	}
}
