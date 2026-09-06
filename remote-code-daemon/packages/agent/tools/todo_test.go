package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func TestTodoValidatesAndUpdatesCompleteChecklist(t *testing.T) {
	var saved []TodoItem
	tool := &TodoTool{Update: func(items []TodoItem) error { saved = items; return nil }}
	for _, raw := range []string{`{}`, `{"items":[{"id":"1","text":"work","status":"wrong"}]}`, `{"items":[{"id":"1","text":"a","status":"pending"},{"id":"1","text":"b","status":"pending"}]}`, `{"items":[{"id":"1","text":"a","status":"in_progress"},{"id":"2","text":"b","status":"in_progress"}]}`} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(raw), nil); err == nil {
			t.Fatal("accepted invalid checklist")
		}
	}
	if saved != nil {
		t.Fatal("invalid checklist modified state")
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"items":[{"id":"1","text":"Inspect","status":"completed"},{"id":"2","text":"Implement","status":"in_progress"}]}`), nil); err != nil {
		t.Fatal(err)
	}
	if len(saved) != 2 || saved[1].Status != "in_progress" {
		t.Fatal("checklist did not reach host")
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"items":[]}`), nil); err != nil || len(saved) != 0 {
		t.Fatal("explicit empty list did not clear the checklist")
	}
}
