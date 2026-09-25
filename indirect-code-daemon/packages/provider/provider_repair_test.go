package provider

import (
	"encoding/json"
	"testing"
)

func TestRepairOrphanedToolResultsDropsUnmatchedResults(t *testing.T) {
	msgs := []Message{
		{Role: RoleAssistant, Content: []Content{
			ToolCallBlock{ID: "t1", Name: "read", Arguments: json.RawMessage(`{}`)},
		}},
		{Role: RoleTool, Content: []Content{
			ToolResultBlock{CallID: "t1", Content: []Content{TextBlock{Text: "ok"}}},
			ToolResultBlock{CallID: "ghost", Content: []Content{TextBlock{Text: "orphan"}}},
		}},
		// Result whose tool_use never existed, alone in its message:
		// the whole message must disappear, not just the block.
		{Role: RoleTool, Content: []Content{
			ToolResultBlock{CallID: "never-called", Content: []Content{TextBlock{Text: "x"}}},
		}},
	}
	out := RepairOrphanedToolResults(msgs)
	if len(out) != 2 {
		t.Fatalf("want 2 messages (orphan-only message dropped), got %d", len(out))
	}
	tr, ok := out[1].Content[0].(ToolResultBlock)
	if !ok || tr.CallID != "t1" {
		t.Fatalf("only the matched result must survive: %+v", out[1].Content)
	}
	if len(out[1].Content) != 1 {
		t.Errorf("orphan block must be filtered: %+v", out[1].Content)
	}
}

func TestRepairOrphanedToolResultsDropsDuplicateResults(t *testing.T) {
	msgs := []Message{
		{Role: RoleAssistant, Content: []Content{
			ToolCallBlock{ID: "t1", Name: "write", Arguments: json.RawMessage(`{}`)},
		}},
		{Role: RoleTool, Content: []Content{
			ToolResultBlock{CallID: "t1", Content: []Content{TextBlock{Text: "first"}}},
			ToolResultBlock{CallID: "t1", Content: []Content{TextBlock{Text: "second"}}},
		}},
	}
	out := RepairOrphanedToolResults(msgs)
	if len(out) != 2 {
		t.Fatalf("want 2 messages, got %d", len(out))
	}
	if len(out[1].Content) != 1 {
		t.Fatalf("exactly one result per call id, got %d blocks", len(out[1].Content))
	}
	tr := out[1].Content[0].(ToolResultBlock)
	if first, _ := tr.Content[0].(TextBlock); first.Text != "first" {
		t.Errorf("the FIRST result must win, got %+v", tr.Content[0])
	}
}

func TestRepairOrphanedToolResultsKeepsValidPairsUntouched(t *testing.T) {
	msgs := []Message{
		{Role: RoleUser, Content: []Content{TextBlock{Text: "hi"}}},
		{Role: RoleAssistant, Content: []Content{
			TextBlock{Text: "let me check"},
			ToolCallBlock{ID: "t1", Name: "read", Arguments: json.RawMessage(`{}`)},
		}},
		{Role: RoleTool, Content: []Content{ToolResultBlock{CallID: "t1", Content: []Content{TextBlock{Text: "ok"}}}}},
	}
	out := RepairOrphanedToolResults(msgs)
	if len(out) != 3 {
		t.Fatalf("valid transcript must pass through, got %d messages", len(out))
	}
	if len(out[1].Content) != 2 || len(out[2].Content) != 1 {
		t.Errorf("blocks must not be reordered or dropped: %+v", out)
	}
}

func TestUsageAddSumsBucketsAndCosts(t *testing.T) {
	a := Usage{
		InputTokens: 10, OutputTokens: 20, ReasoningTokens: 5, ReasoningTokensKnown: true,
		CacheReadTokens: 3, CacheWriteTokens: 4,
		CostUSD: 1.5, CostInputUSD: 0.5, CostCacheUSD: 0.25, CostOutputUSD: 0.75,
	}
	b := Usage{
		InputTokens: 1, OutputTokens: 2, ReasoningTokens: 3, ReasoningTokensKnown: true,
		CacheReadTokens: 1, CacheWriteTokens: 1,
		CostUSD: 0.5, CostInputUSD: 0.1, CostCacheUSD: 0.1, CostOutputUSD: 0.3,
	}
	sum := a.Add(b)
	if sum.InputTokens != 11 || sum.OutputTokens != 22 || sum.ReasoningTokens != 8 {
		t.Errorf("tokens: %+v", sum)
	}
	if sum.CacheReadTokens != 4 || sum.CacheWriteTokens != 5 {
		t.Errorf("cache: %+v", sum)
	}
	if sum.CostUSD != 2.0 || sum.CostInputUSD != 0.6 || sum.CostCacheUSD != 0.35 || sum.CostOutputUSD != 1.05 {
		t.Errorf("costs: %+v", sum)
	}
	// A reasoning total is only known when BOTH sides know theirs.
	if !sum.ReasoningTokensKnown {
		t.Errorf("both sides known must stay known")
	}
	if (a.Add(Usage{})).ReasoningTokensKnown {
		t.Errorf("one unknown side poisons the total (AND semantics)")
	}
}

func TestAnthropicCountToolResultContentShapes(t *testing.T) {
	// Empty result serializes to nothing.
	if got := anthropicCountToolResultContent(nil); got != "" {
		t.Errorf("empty: got %#v want \"\"", got)
	}
	// Single text result unwraps to the bare string.
	got := anthropicCountToolResultContent([]Content{TextBlock{Text: "hello"}})
	if s, ok := got.(string); !ok || s != "hello" {
		t.Errorf("single text: got %#v", got)
	}
	// Multiple blocks stay a list.
	got = anthropicCountToolResultContent([]Content{TextBlock{Text: "a"}, TextBlock{Text: "b"}})
	if list, ok := got.([]any); !ok || len(list) != 2 {
		t.Errorf("multi: got %#v", got)
	}
	// Image block keeps the base64 source shape the counter expects.
	img := ImageBlock{MimeType: "image/png", Data: []byte{1, 2, 3}}
	got = anthropicCountToolResultContent([]Content{img})
	list, ok := got.([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("image: got %#v", got)
	}
	m, ok := list[0].(map[string]any)
	if !ok || m["type"] != "image" {
		t.Fatalf("image map: got %#v", list[0])
	}
	src, ok := m["source"].(map[string]any)
	if !ok || src["type"] != "base64" || src["media_type"] != "image/png" {
		t.Errorf("image source: got %#v", m["source"])
	}
	if src["data"] != "AQID" { // base64 of {1,2,3}
		t.Errorf("image data: got %#v", src["data"])
	}
	// Unknown block types are skipped, never crash the counter.
	got = anthropicCountToolResultContent([]Content{ToolCallBlock{ID: "x"}})
	if got != "" {
		t.Errorf("unknown blocks serialize to nothing: got %#v", got)
	}
}
