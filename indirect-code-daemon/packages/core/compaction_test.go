package core

import (
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func textMsg(role provider.Role, text string) provider.Message {
	return provider.Message{Role: role, Content: []provider.Content{provider.TextBlock{Text: text}}}
}

func toolTurn(name, args, output string) (provider.Message, provider.Message) {
	asst := provider.Message{
		Role: provider.RoleAssistant,
		Content: []provider.Content{
			provider.ToolCallBlock{ID: "call-1", Name: name, Arguments: mustRaw(args)},
		},
	}
	tool := provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{
			provider.ToolResultBlock{CallID: "call-1", Content: []provider.Content{provider.TextBlock{Text: output}}},
		},
	}
	return asst, tool
}

func TestEstimateMessageTokensCharsOverFour(t *testing.T) {
	m := textMsg(provider.RoleUser, "abcdefgh") // 8 chars -> 2 tokens
	if got := EstimateMessageTokens(m); got != 2 {
		t.Fatalf("EstimateMessageTokens = %d, want 2", got)
	}
}

func TestSerializeConversationShape(t *testing.T) {
	asst, tool := toolTurn("read", `{"path":"a.ts"}`, "content here")
	msgs := []provider.Message{textMsg(provider.RoleUser, "hello"), asst, tool}
	out := SerializeConversation(msgs)
	for _, want := range []string{"<conversation>", "<user>", "hello", "</user>", "<assistant>", "[tool call: read", "<tool_result>", "content here", "</tool_result>", "</conversation>"} {
		if !strings.Contains(out, want) {
			t.Fatalf("SerializeConversation missing %q:\n%s", want, out)
		}
	}
}

func TestExtractFileOpsReadVsModified(t *testing.T) {
	r, _ := toolTurn("read", `{"path":"a.ts"}`, "x")
	w, _ := toolTurn("write", `{"path":"b.ts"}`, "ok")
	e, _ := toolTurn("edit", `{"path":"a.ts"}`, "ok")
	g, _ := toolTurn("glob", `{"pattern":"src/**"}`, "f")
	ops := ExtractFileOps([]provider.Message{r, w, e, g})
	if len(ops.Modified) != 2 || ops.Modified[0] != "b.ts" || ops.Modified[1] != "a.ts" {
		t.Fatalf("Modified = %v", ops.Modified)
	}
	// pi semantics: a file read and later modified appears in both lists
	// (explored, then changed). Modified membership is the assertion.
	found := false
	for _, f := range ops.Read {
		if f == "a.ts" {
			found = true
		}
	}
	if !found {
		t.Fatalf("a.ts should stay in Read (read before edit): %v", ops.Read)
	}
}

func TestMergeFileOpsDedupes(t *testing.T) {
	got := MergeFileOps([]string{"a", "b"}, []string{"b", "c"})
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("MergeFileOps = %v", got)
	}
}

func TestFindCutPointKeepsFloorAndToolPairs(t *testing.T) {
	var msgs []provider.Message
	for i := 0; i < 10; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, strings.Repeat("x", 400)))
		msgs = append(msgs, textMsg(provider.RoleAssistant, strings.Repeat("y", 400)))
	}
	asst, tool := toolTurn("read", `{"path":"a"}`, strings.Repeat("z", 400))
	msgs = append(msgs, asst, tool)
	msgs = append(msgs, textMsg(provider.RoleUser, strings.Repeat("w", 400)))

	cut := FindCutPoint(msgs, 400) // ~4 messages of 100 tokens each
	if cut.Index <= 0 || cut.Index >= len(msgs) {
		t.Fatalf("cut out of range: %+v (len=%d)", cut, len(msgs))
	}
	// The boundary must not orphan a tool result: the message at Index
	// must not be a tool result whose owner was cut away.
	if isToolResultHead(msgs[cut.Index]) && !ownsToolCall(msgs, cut.Index) {
		t.Fatalf("cut orphans tool result at %d", cut.Index)
	}
}

func TestShouldCompactReserveMath(t *testing.T) {
	if !ShouldCompact(100000, 80000, 5000) { // 85k > 100k-16384
		t.Fatal("expected compact")
	}
	if ShouldCompact(100000, 50000, 1000) {
		t.Fatal("expected no compact")
	}
	if ShouldCompact(0, 999999, 999999) {
		t.Fatal("unknown window must not compact")
	}
}

func TestPrepareCompactionInitialVsUpdate(t *testing.T) {
	var msgs []provider.Message
	for i := 0; i < 8; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, strings.Repeat("q", 200)))
	}
	initial := PrepareCompaction(msgs, nil, 100)
	if initial.Incremental {
		t.Fatal("nil state must produce an initial prompt")
	}
	if !strings.Contains(initial.Prompt, "Summarize the following conversation:") {
		t.Fatalf("initial prompt wrong:\n%s", initial.Prompt[:200])
	}
	update := PrepareCompaction(msgs, &CompactionState{PreviousSummary: "old work", ReadFiles: []string{"a.ts"}}, 100)
	if !update.Incremental {
		t.Fatal("existing state must produce an update prompt")
	}
	for _, want := range []string{"<previous_summary>", "old work", "a.ts"} {
		if !strings.Contains(update.Prompt, want) {
			t.Fatalf("update prompt missing %q:\n%s", want, update.Prompt)
		}
	}
}

func TestApplyCompactionSpliceAndChain(t *testing.T) {
	var msgs []provider.Message
	for i := 0; i < 8; i++ {
		msgs = append(msgs, textMsg(provider.RoleUser, "msg"))
	}
	r, _ := toolTurn("read", `{"path":"keep.ts"}`, "x")
	msgs = append(msgs, r)
	plan := PrepareCompaction(msgs, nil, 100)
	next, state := applyCompaction(msgs, plan, "did things", nil)
	if len(next) != 1+(len(msgs)-plan.KeepFrom) {
		t.Fatalf("splice length = %d, keepFrom=%d", len(next), plan.KeepFrom)
	}
	first, ok := next[0].Content[0].(provider.TextBlock)
	if !ok || !strings.Contains(first.Text, "## Context Summary (compacted)") || !strings.Contains(first.Text, "did things") {
		t.Fatalf("synthetic summary head wrong: %+v", next[0])
	}
	if state == nil || state.PreviousSummary != "did things" || state.Count != 1 {
		t.Fatalf("chain head wrong: %+v", state)
	}
	// Second compaction chains: count bumps, file ops merge.
	plan2 := PrepareCompaction(next, state, 100)
	_, state2 := applyCompaction(next, plan2, "more things", state)
	if state2.Count != 2 || state2.PreviousSummary != "more things" {
		t.Fatalf("chained head wrong: %+v", state2)
	}
}

func TestTrailingTokensOnlyCountsAfterLastAssistant(t *testing.T) {
	msgs := []provider.Message{
		textMsg(provider.RoleUser, strings.Repeat("a", 400)),
		textMsg(provider.RoleAssistant, strings.Repeat("b", 400)),
		textMsg(provider.RoleUser, strings.Repeat("c", 40)),
	}
	got := TrailingTokens(msgs, provider.Usage{InputTokens: 1000})
	if got != 10 { // 40 chars -> 10 tokens
		t.Fatalf("TrailingTokens = %d, want 10", got)
	}
}

func mustRaw(s string) json.RawMessage {
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		panic(err)
	}
	b, _ := json.Marshal(v)
	return b
}
