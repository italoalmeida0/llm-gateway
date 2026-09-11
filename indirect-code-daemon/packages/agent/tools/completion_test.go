package tools

import (
	"context"
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestMarkTaskAsCompleteTool(t *testing.T) {
	called := false
	tool := &MarkTaskAsCompleteTool{
		OnComplete: func() error {
			called = true
			return nil
		},
	}
	if tool.Name() != "mark_task_as_complete" {
		t.Fatalf("unexpected name: %s", tool.Name())
	}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{"notes":"done"}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("expected OnComplete callback to be invoked")
	}
	if len(res.Content) == 0 {
		t.Fatal("expected non-empty content")
	}
	if tb, ok := res.Content[0].(provider.TextBlock); !ok || tb.Text != "Task marked as complete." {
		t.Fatalf("unexpected result text: %v", res.Content[0])
	}
}

func TestMarkPlanAsReadyToExecuteTool(t *testing.T) {
	called := false
	tool := &MarkPlanAsReadyToExecuteTool{
		OnReady: func() error {
			called = true
			return nil
		},
	}
	if tool.Name() != "mark_plan_as_ready_to_execute" {
		t.Fatalf("unexpected name: %s", tool.Name())
	}
	res, err := tool.Execute(context.Background(), json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("expected OnReady callback to be invoked")
	}
	if len(res.Content) == 0 {
		t.Fatal("expected non-empty content")
	}
	if tb, ok := res.Content[0].(provider.TextBlock); !ok || tb.Text != "Plan marked as ready to execute." {
		t.Fatalf("unexpected result text: %v", res.Content[0])
	}
}
