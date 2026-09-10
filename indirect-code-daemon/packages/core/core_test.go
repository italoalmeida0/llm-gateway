package core

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestCostAdd(t *testing.T) {
	var c CostTracker
	c.Add(provider.Usage{InputTokens: 100, OutputTokens: 50, ReasoningTokens: 20, ReasoningTokensKnown: true, CostUSD: 0.01})
	c.Add(provider.Usage{InputTokens: 200, OutputTokens: 25, ReasoningTokens: 10, ReasoningTokensKnown: true, CostUSD: 0.02})
	if c.Total.InputTokens != 300 || c.Total.OutputTokens != 75 {
		t.Fatalf("got %+v", c.Total)
	}
	if c.Total.ReasoningTokens != 30 || !c.Total.ReasoningTokensKnown {
		t.Fatalf("got reasoning usage %+v", c.Total)
	}
	if c.Total.CostUSD < 0.0299 || c.Total.CostUSD > 0.0301 {
		t.Fatalf("got cost %v", c.Total)
	}
}
