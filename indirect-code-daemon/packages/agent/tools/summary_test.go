package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func extractResultText(res core.ToolResult) string {
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			return tb.Text
		}
	}
	return ""
}

func TestSummaryToolValidation(t *testing.T) {
	tool := &SummaryTool{}

	// Test < 100 chars for_user
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"for_user":"Too short","for_me":"Valid internal monologue here"}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError || !strings.Contains(extractResultText(res), "too short") {
		t.Fatalf("expected too short error, got: %+v", res)
	}

	// Test missing for_me
	validUser := strings.Repeat("A", 120)
	res, err = tool.Execute(context.Background(), json.RawMessage(`{"for_user":"`+validUser+`","for_me":""}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError || !strings.Contains(extractResultText(res), "for_me is required") {
		t.Fatalf("expected for_me is required error, got: %+v", res)
	}

	// Test valid
	called := false
	tool.OnSummary = func(forUser, forMe string) error {
		called = true
		if len([]rune(forUser)) > 503 {
			t.Fatalf("expected truncation, got length %d", len([]rune(forUser)))
		}
		if forMe != "My notes" {
			t.Fatalf("unexpected forMe: %s", forMe)
		}
		return nil
	}

	longUser := strings.Repeat("B", 600)
	payload, _ := json.Marshal(map[string]string{
		"for_user": longUser,
		"for_me":   "My notes",
	})
	res, err = tool.Execute(context.Background(), payload, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", res.Content)
	}
	if !called {
		t.Fatal("expected OnSummary to be called")
	}
}
