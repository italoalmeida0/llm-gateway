package main

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestResolveContextUsageFallsBackToLocalEstimate(t *testing.T) {
	reported := provider.Usage{InputTokens: 0, OutputTokens: 574}
	fromReported := &SessionContext{UsedTokens: 574, WindowTokens: 128000, Model: "m", Estimated: false}
	local := &SessionContext{UsedTokens: 23000, WindowTokens: 128000, Model: "m", Estimated: true}
	got, warned := resolveContextUsage(reported, fromReported, local, "s1")
	if !warned {
		t.Fatalf("fallback should fire when provider reports zero input with large local context")
	}
	if got != local {
		t.Fatalf("should return local estimate, got %+v", got)
	}
}

func TestResolveContextUsageTrustsReportedInput(t *testing.T) {
	reported := provider.Usage{InputTokens: 1200, OutputTokens: 50}
	fromReported := &SessionContext{UsedTokens: 1250, WindowTokens: 128000, Model: "m", Estimated: false}
	local := &SessionContext{UsedTokens: 5000, WindowTokens: 128000, Model: "m", Estimated: true}
	got, warned := resolveContextUsage(reported, fromReported, local, "s1")
	if warned {
		t.Fatalf("fallback must not fire when provider reports input")
	}
	if got != fromReported {
		t.Fatalf("should keep reported context, got %+v", got)
	}
}

func TestResolveContextUsageKeepsLargerReported(t *testing.T) {
	reported := provider.Usage{InputTokens: 0, OutputTokens: 50000}
	fromReported := &SessionContext{UsedTokens: 50000, WindowTokens: 128000, Model: "m", Estimated: false}
	local := &SessionContext{UsedTokens: 1000, WindowTokens: 128000, Model: "m", Estimated: true}
	got, warned := resolveContextUsage(reported, fromReported, local, "s1")
	if warned {
		t.Fatalf("fallback must not fire when reported exceeds local")
	}
	if got != fromReported {
		t.Fatalf("should keep reported context, got %+v", got)
	}
}
