package core

import (
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestPruneOldToolResults(t *testing.T) {
	hugeOutput := strings.Repeat("A", 10000)

	msgs := []provider.Message{
		// Turn 1 (Old turn)
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "list files"}},
			Time:    time.Now(),
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "call_1", Name: "bash"},
			},
			Time: time.Now(),
		},
		{
			Role: provider.RoleTool,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID: "call_1",
					Content: []provider.Content{
						provider.TextBlock{Text: hugeOutput},
					},
				},
			},
			Time: time.Now(),
		},
		// Turn 2 (Recent turn 1)
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "read file"}},
			Time:    time.Now(),
		},
		{
			Role: provider.RoleAssistant,
			Content: []provider.Content{
				provider.ToolCallBlock{ID: "call_2", Name: "read"},
			},
			Time: time.Now(),
		},
		{
			Role: provider.RoleTool,
			Content: []provider.Content{
				provider.ToolResultBlock{
					CallID: "call_2",
					Content: []provider.Content{
						provider.TextBlock{Text: "small output"},
					},
				},
			},
			Time: time.Now(),
		},
		// Turn 3 (Recent turn 2)
		{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: "do something"}},
			Time:    time.Now(),
		},
	}

	pruned := PruneOldToolResults(msgs)
	if len(pruned) != len(msgs) {
		t.Fatalf("length changed: got %d, want %d", len(pruned), len(msgs))
	}

	// Turn 1's tool result was in an older turn and exceeded ToolOutputMaxChars,
	// so it should have been pruned to PrunedToolNotice
	trb1 := pruned[2].Content[0].(provider.ToolResultBlock)
	tb1 := trb1.Content[0].(provider.TextBlock)
	if tb1.Text != PrunedToolNotice {
		t.Errorf("expected pruned notice %q, got %q", PrunedToolNotice, tb1.Text)
	}
	if trb1.CallID != "call_1" {
		t.Errorf("call_id changed: got %q, want call_1", trb1.CallID)
	}

	// Turn 2's tool result is in the recent 2 turns and small, so it should remain untouched
	trb2 := pruned[5].Content[0].(provider.ToolResultBlock)
	tb2 := trb2.Content[0].(provider.TextBlock)
	if tb2.Text != "small output" {
		t.Errorf("recent small output changed: got %q", tb2.Text)
	}
}
