package main

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Legacy saved transcripts still need display filtering. New responses are
// already text-free when core sends them to persistence and live events.
func TestSanitizeMessagesForFrontendSilencesAssistantText(t *testing.T) {
	msgs := []provider.Message{
		{ID: "u1", Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		{ID: "a1", Role: provider.RoleAssistant, Content: []provider.Content{
			provider.TextBlock{Text: "chatter"},
			provider.ToolCallBlock{ID: "c1", Name: "bash", Arguments: []byte(`{"command":"ls"}`)},
		}},
	}
	for _, mode := range []string{"build", "plan", "learning"} {
		out := sanitizeMessagesForFrontend(mode, msgs)
		if len(out) != len(msgs) {
			t.Fatalf("%s: message count changed: %d != %d", mode, len(out), len(msgs))
		}
		for _, c := range out[1].Content {
			if _, ok := c.(provider.TextBlock); ok {
				t.Fatalf("%s: assistant text block leaked to frontend", mode)
			}
		}
		if len(out[1].Content) != 1 {
			t.Fatalf("%s: tool call must survive sanitization, got %d blocks", mode, len(out[1].Content))
		}
		if got := extractTestText(out[0]); got != "hi" {
			t.Fatalf("%s: user text must be preserved, got %q", mode, got)
		}
	}

	out := sanitizeMessagesForFrontend("talk", msgs)
	if got := extractTestText(out[1]); got != "chatter" {
		t.Fatalf("talk must preserve assistant text, got %q", got)
	}
}

// Message count and ordering must be stable: srcIdx bookkeeping on the
// client maps 1:1 to the raw daemon transcript.
func TestSanitizeMessagesForFrontendKeepsIndices(t *testing.T) {
	msgs := []provider.Message{
		{ID: "a1", Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "x"}}},
		{ID: "a2", Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "y"}}},
	}
	out := sanitizeMessagesForFrontend("build", msgs)
	if len(out) != 2 || out[0].ID != "a1" || out[1].ID != "a2" {
		t.Fatalf("order/count changed: %+v", out)
	}
}

func TestStripAssistantTextPreservesStructure(t *testing.T) {
	m := provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{
		provider.TextBlock{Text: "a"},
		provider.ToolCallBlock{ID: "c1", Name: "bash"},
		provider.TextBlock{Text: "b"},
	}}
	got := stripAssistantText(m)
	if len(got.Content) != 1 {
		t.Fatalf("expected only the tool call to survive, got %d blocks", len(got.Content))
	}
	if _, ok := got.Content[0].(provider.ToolCallBlock); !ok {
		t.Fatalf("tool call lost: %T", got.Content[0])
	}
	// Original must not be mutated (it is still in the WAL/agent history).
	if len(m.Content) != 3 {
		t.Fatalf("source message was mutated")
	}
}

// mark_task_as_complete is the turn closer for build AND learning.
func TestModeToolRestrictionLearningCompletes(t *testing.T) {
	if reason := modeToolRestriction("learning", "mark_task_as_complete"); reason != "" {
		t.Fatalf("learning must allow mark_task_as_complete, got %q", reason)
	}
	if reason := modeToolRestriction("build", "mark_task_as_complete"); reason != "" {
		t.Fatalf("build must allow mark_task_as_complete, got %q", reason)
	}
	if reason := modeToolRestriction("plan", "mark_task_as_complete"); reason == "" {
		t.Fatalf("plan must reject mark_task_as_complete")
	}
	if reason := modeToolRestriction("learning", "mark_plan_as_ready_to_execute"); reason == "" {
		t.Fatalf("learning must reject mark_plan_as_ready_to_execute")
	}
	// Rejection messages must not describe other modes.
	for _, reason := range []string{
		modeToolRestriction("plan", "mark_task_as_complete"),
		modeToolRestriction("talk", "read"),
		modeToolRestriction("learning", "write"),
	} {
		for _, leak := range []string{"build", "plan mode", "learning", "talk"} {
			if strings.Contains(strings.ToLower(reason), leak) {
				t.Fatalf("restriction reason %q leaks other modes (%q)", reason, leak)
			}
		}
	}
	// Learning keeps its read-only guarantee on project files.
	for _, tool := range []string{"write", "edit", "patch"} {
		if reason := modeToolRestriction("learning", tool); reason == "" {
			t.Fatalf("learning must block %s", tool)
		}
	}
}

func extractTestText(m provider.Message) string {
	var b strings.Builder
	for _, c := range m.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			b.WriteString(tb.Text)
		}
	}
	return b.String()
}

func TestModeCompletionTool(t *testing.T) {
	for mode, want := range map[string]string{
		"build": "mark_task_as_complete", "learning": "mark_task_as_complete",
		"plan": "mark_plan_as_ready_to_execute", "talk": "", "": "mark_task_as_complete",
	} {
		if got := modeCompletionTool(mode); got != want {
			t.Fatalf("%q completion tool = %q; want %q", mode, got, want)
		}
	}
}

func TestDiscardedTextMaintainsLivenessWithoutFrontendEvent(t *testing.T) {
	inbox := make(chan Envelope, 8)
	w := &turnBridge{
		env: workerEnv{inbox: inbox}, snap: workerSnapshot{gen: 7},
		live: &liveTracker{thinkingStartedAt: 1},
	}
	w.handleEvent(core.EvTextDiscarded{Characters: 42})
	heartbeats := 0
	for len(inbox) > 0 {
		switch e := (<-inbox).Payload.(type) {
		case workerHeartbeatMsg:
			heartbeats++
			if e.gen != 7 {
				t.Fatalf("heartbeat lost generation: %+v", e)
			}
		case workerLiveMsg:
			if e.live.ThinkingStartedAt != 0 {
				t.Fatal("discarded speech left the thinking timer running")
			}
		default:
			t.Fatalf("discarded text emitted a frontend event: %T", e)
		}
	}
	if heartbeats != 1 || w.live.thinkingStartedAt != 0 {
		t.Fatalf("heartbeats=%d thinking=%d", heartbeats, w.live.thinkingStartedAt)
	}
}
