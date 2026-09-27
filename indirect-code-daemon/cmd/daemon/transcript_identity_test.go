package main

import (
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestTranscriptIDsSurviveReloadAndIndexReuse(t *testing.T) {
	rec := &SessionRecord{ID: "s", Messages: []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "same"}}}, {Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "same"}}}}}
	ensureTranscriptIDs(rec)
	if rec.Messages[0].ID == rec.Messages[1].ID {
		t.Fatal("equal text collapsed separate messages")
	}
	raw, _ := json.Marshal(rec.Messages[0])
	restored, err := core.HydrateMessageObject(raw)
	if err != nil || restored.ID != rec.Messages[0].ID {
		t.Fatal("identity lost on reload")
	}
	before := restored.ID
	rec.Messages = []provider.Message{{ID: provider.NewMessageID(), Role: provider.RoleUser}}
	ensureTranscriptIDs(rec)
	if rec.Messages[0].ID == before {
		t.Fatal("replacement reused positional identity")
	}
}

func TestTranscriptSnapshotIncludesExactlyItsStreamPrefix(t *testing.T) {
	a := reviewActor(t)
	a.rec.Messages = nil
	a.rec.TurnSeq = 1
	emit := func(event map[string]any) map[string]any {
		envelope := map[string]any{"type": "agent_event", "event": event}
		a.emit(envelope)
		return envelope
	}
	start := emit(map[string]any{"type": "assistant_start", "messageId": "a"})
	c := start["transcript"].(transcriptCursor)
	if c.Seq != 1 || c.Stream == "" {
		t.Fatal("missing stream cursor")
	}
	emit(map[string]any{"type": "text_delta", "delta": "before"})
	snap := a.clientOverlay()
	live := snap["liveMessage"].(*liveAssistant)
	emit(map[string]any{"type": "text_delta", "delta": "after"})
	if live.ID != "a" || live.Content[0].Text != "before" {
		t.Fatal("snapshot alias changed after later event")
	}
	if snap["transcript"].(transcriptCursor).Seq != 2 {
		t.Fatal("snapshot prefix differs from content")
	}
	emit(map[string]any{"type": "tool_use_start", "id": "tool", "name": "bash"})
	emit(map[string]any{"type": "tool_use_args", "id": "tool", "delta": "{"})
	emit(map[string]any{"type": "tool_call", "id": "tool", "name": "bash", "args": json.RawMessage(`{"command":"echo done"}`)})
	live = a.clientOverlay()["liveMessage"].(*liveAssistant)
	if live.Content[len(live.Content)-1].Arguments != `{"command":"echo done"}` {
		t.Fatal("snapshot kept partial arguments after the completed tool call")
	}
	msg := provider.Message{ID: "a", Role: provider.RoleAssistant, Content: []provider.Content{provider.ToolCallBlock{ID: "tool", Name: "bash"}}}
	a.rec.Messages = append(a.rec.Messages, msg)
	a.transcriptCommitted(msg)
	final := map[string]any{"type": "assistant_message", "message": msg}
	emit(final)
	if final["index"] != 0 || final["messageId"] != "a" {
		t.Fatal("commit changed message identity")
	}
	emit(map[string]any{"type": "tool_result", "id": "tool", "content": "done"})
	if len(a.clientOverlay()["pendingToolResults"].([]provider.Content)) != 1 {
		t.Fatal("reconnect lost an uncommitted tool result")
	}
	a.transcriptCommitted(provider.Message{Role: provider.RoleTool, Content: []provider.Content{provider.ToolResultBlock{CallID: "tool"}}})
	if a.clientOverlay()["pendingToolResults"] != nil {
		t.Fatal("committed tool result duplicated in overlay")
	}
	b := reviewActor(t)
	if b.clientOverlay()["transcript"].(transcriptCursor).Stream == c.Stream {
		t.Fatal("actor replacement reused a stream")
	}
}

func TestTranscriptRetryBeforeNewStreamKeepsCommittedAssistant(t *testing.T) {
	a := reviewActor(t)
	a.rec.Messages = []provider.Message{{ID: "committed", Role: provider.RoleAssistant}}
	a.transcript.activeID = "committed"
	a.transcript.activeIndex = 0
	event := map[string]any{"type": "retry"}
	a.emit(map[string]any{"type": "agent_event", "event": event})
	if event["index"] != 1 || event["messageId"] != nil {
		t.Fatal("retry targeted an already committed response")
	}
}
