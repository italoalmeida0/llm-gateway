package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type transcriptCursor struct {
	Stream string `json:"stream"`
	Seq    uint64 `json:"seq"`
}

// Actor-owned transport state. The snapshot cursor and its live projection
// are captured together; workers never publish either independently.
type transcriptState struct {
	cursor      transcriptCursor
	activeID    string
	activeIndex int
	live        *liveAssistant
	results     []provider.ToolResultBlock
}

func (t *transcriptState) position() transcriptCursor {
	if t.cursor.Stream == "" {
		t.cursor.Stream = provider.NewMessageID()
	}
	return t.cursor
}

// Existing V2 records gain deterministic identities without a migration or
// read-side rewrite. A later normal save persists them. The index salts equal
// repeated messages; it is no longer the identity once assigned.
func ensureTranscriptIDs(rec *SessionRecord) {
	if rec == nil {
		return
	}
	for i := range rec.Messages {
		if rec.Messages[i].ID != "" {
			continue
		}
		raw, _ := json.Marshal(rec.Messages[i])
		sum := sha256.Sum256(append([]byte(fmt.Sprintf("%s:%d:", rec.ID, i)), raw...))
		rec.Messages[i].ID = "legacy_" + hex.EncodeToString(sum[:16])
	}
}

func (a *sessionActor) prepareTranscriptEvent(value any) {
	m, ok := value.(map[string]any)
	if !ok {
		return
	}
	typ, _ := m["type"].(string)
	switch typ {
	case "agent_event", "session_data", "session_content", "session_compacted", "session_truncated", "session_status":
	default:
		return
	}
	t := &a.transcript
	t.position()
	t.cursor.Seq++
	if typ == "agent_event" {
		if ev, ok := m["event"].(map[string]any); ok {
			t.track(ev, a.rec)
		}
	}
	if typ == "session_truncated" {
		t.live = nil
		t.results = nil
		t.activeID = ""
	}
	m["transcript"] = t.cursor
	if typ == "session_data" {
		if p, ok := m["session"].(map[string]any); ok {
			for k, v := range a.transcriptOverlay() {
				p[k] = v
			}
		}
	} else if typ == "session_content" || typ == "session_compacted" {
		for k, v := range a.transcriptOverlay() {
			m[k] = v
		}
	}
}

func (t *transcriptState) track(ev map[string]any, rec *SessionRecord) {
	typ, _ := ev["type"].(string)
	if typ == "assistant_start" {
		id, _ := ev["messageId"].(string)
		if id == "" {
			id = provider.NewMessageID()
		}
		t.activeID, t.activeIndex = id, len(rec.Messages)
		t.live = &liveAssistant{ID: id, Role: "assistant", TurnIndex: rec.TurnSeq, Streaming: true, Content: []liveBlock{}}
	}
	if typ == "assistant_message" || typ == "user_message" {
		id := ""
		switch msg := ev["message"].(type) {
		case provider.Message:
			id = msg.ID
		case map[string]any:
			id, _ = msg["id"].(string)
		}
		for i := len(rec.Messages) - 1; i >= 0; i-- {
			if rec.Messages[i].ID == id {
				ev["index"] = i
				break
			}
		}
		ev["messageId"] = id
	} else if t.activeID != "" {
		ev["messageId"], ev["index"] = t.activeID, t.activeIndex
	}
	if typ == "retry" {
		ev["index"] = len(rec.Messages)
		delete(ev, "messageId")
	}
	id, _ := ev["id"].(string)
	str := func(key string) string { v, _ := ev[key].(string); return v }
	if typ == "tool_result" {
		// Persistent tools commit to WAL before emitting their display event.
		// Such results already belong to the snapshot; retaining them here
		// leaks old results into later pages without their original calls.
		for i := len(rec.Messages) - 1; i >= 0; i-- {
			for _, block := range rec.Messages[i].Content {
				if result, ok := block.(provider.ToolResultBlock); ok && result.CallID == id {
					return
				}
			}
			if rec.Messages[i].ID == t.activeID {
				break
			}
		}
		r := provider.ToolResultBlock{CallID: id, Content: []provider.Content{provider.TextBlock{Text: str("content")}}, Details: ev["details"]}
		r.IsError, _ = ev["isError"].(bool)
		r.StartedAt, _ = ev["startedAt"].(int64)
		r.DurationMs, _ = ev["durationMs"].(int64)
		for i := range t.results {
			if t.results[i].CallID == id {
				t.results[i] = r
				return
			}
		}
		t.results = append(t.results, r)
	}
	if typ == "assistant_message" || typ == "retry" || typ == "turn_end" {
		t.live = nil
		return
	}
	if t.live == nil {
		return
	}
	blocks := &t.live.Content
	switch typ {
	case "text_delta":
		if len(*blocks) == 0 || (*blocks)[len(*blocks)-1].Text == "" {
			*blocks = append(*blocks, liveBlock{})
		}
		(*blocks)[len(*blocks)-1].Text += str("delta")
	case "reasoning_delta":
		for i := range *blocks {
			if (*blocks)[i].Summary != "" {
				(*blocks)[i].Summary += str("delta")
				return
			}
		}
		*blocks = append(*blocks, liveBlock{Summary: str("delta")})
	case "tool_use_start":
		*blocks = append(*blocks, liveBlock{ID: id, Name: str("name")})
	case "tool_use_args":
		for i := range *blocks {
			if (*blocks)[i].ID == id {
				(*blocks)[i].Arguments += str("delta")
				return
			}
		}
	case "tool_call":
		args, _ := ev["args"].(json.RawMessage)
		for i := range *blocks {
			if (*blocks)[i].ID == id {
				(*blocks)[i].Arguments = string(args)
				return
			}
		}
		*blocks = append(*blocks, liveBlock{ID: id, Name: str("name"), Arguments: string(args)})
	}
}

func (a *sessionActor) transcriptOverlay() map[string]any {
	t := &a.transcript
	out := map[string]any{"transcript": t.position()}
	if t.live != nil {
		cp := *t.live
		cp.Content = append([]liveBlock{}, t.live.Content...)
		out["liveMessage"] = &cp
	}
	if len(t.results) > 0 {
		// Hydration on the frontend hoists this transient tool envelope onto its
		// matching assistant. It disappears once the real tool message is in WAL.
		content := make([]provider.Content, 0, len(t.results))
		for _, r := range t.results {
			content = append(content, r)
		}
		out["pendingToolResults"] = cloneContent(content)
	}
	return out
}

func (a *sessionActor) transcriptCommitted(m provider.Message) {
	t := &a.transcript
	if t.live != nil && m.ID == t.live.ID {
		t.live = nil
	}
	for _, c := range m.Content {
		if r, ok := c.(provider.ToolResultBlock); ok {
			kept := t.results[:0]
			for _, pending := range t.results {
				if pending.CallID != r.CallID {
					kept = append(kept, pending)
				}
			}
			t.results = kept
		}
	}
}
