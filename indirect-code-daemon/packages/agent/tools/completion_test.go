package tools

import (
	"context"
	"encoding/json"
	"testing"
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
	if got := envAttr(res, "info"); got != "Task marked as complete." {
		t.Fatalf("info attr = %q", got)
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
	// Missing comprehensive_summary should error
	res, err := tool.Execute(context.Background(), json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected error on empty comprehensive_summary")
	}

	// Valid comprehensive_summary
	res, err = tool.Execute(context.Background(), json.RawMessage(`{"comprehensive_summary":"Plan is ready to proceed."}`), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("expected OnReady callback to be invoked")
	}
	if got := envAttr(res, "info"); got != "Plan marked as ready to execute." {
		t.Fatalf("info attr = %q", got)
	}
}
