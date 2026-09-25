package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// liveBlock is a transient replay of only the current assistant response.
// Completed messages live in SessionRecord; these deltas never become
// mirrored data. Arguments are strings because streaming tool JSON can
// still be incomplete.
type liveBlock struct {
	Text      string `json:"text,omitempty"`
	Summary   string `json:"summary,omitempty"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

type liveAssistant struct {
	TurnIndex int         `json:"turnIndex"`
	Streaming bool        `json:"streaming"`
	Role      string      `json:"role"`
	Content   []liveBlock `json:"content"`
}

// liveTracker accumulates the in-progress assistant response on the WORKER
// side (no actor involvement). The actor keeps the latest snapshot for
// reconnect payloads.
type liveTracker struct {
	live              *liveAssistant
	toolStarts        map[string]int64
	toolProgress      map[string]string
	thinkingStartedAt int64
	turnSeq           int
	dirty             bool // overlay changed since last snapshot (V2-004)
}

// liveSnapshot is the compact client-restore overlay for a streaming turn
// (V2-004): enough to rebuild the live UI after a reconnect without
// replaying deltas. Transient — never persisted.
type liveSnapshot struct {
	ToolStarts        map[string]int64  `json:"toolStarts,omitempty"`
	ToolProgress      map[string]string `json:"toolProgress,omitempty"`
	ThinkingStartedAt int64             `json:"thinkingStartedAt,omitempty"`
}

// snapshot copies the overlay when it changed since the last call.
func (t *liveTracker) snapshot() *liveSnapshot {
	if !t.dirty {
		return nil
	}
	t.dirty = false
	s := &liveSnapshot{ThinkingStartedAt: t.thinkingStartedAt}
	if len(t.toolStarts) > 0 {
		s.ToolStarts = make(map[string]int64, len(t.toolStarts))
		for k, v := range t.toolStarts {
			s.ToolStarts[k] = v
		}
	}
	if len(t.toolProgress) > 0 {
		s.ToolProgress = make(map[string]string, len(t.toolProgress))
		for k, v := range t.toolProgress {
			s.ToolProgress[k] = v
		}
	}
	return s
}

func (t *liveTracker) track(event core.AgentEvent) {
	if _, ok := event.(core.EvAssistantStart); ok {
		t.thinkingStartedAt = 0
		t.dirty = true
		t.live = &liveAssistant{Role: "assistant", TurnIndex: t.turnSeq, Streaming: true, Content: []liveBlock{}}
		return
	}
	switch e := event.(type) {
	case core.EvToolExecutionStart:
		t.thinkingStartedAt = 0
		if t.toolStarts == nil {
			t.toolStarts = map[string]int64{}
		}
		t.toolStarts[e.ID] = e.StartedAt
		t.dirty = true
	case core.EvReasoningDelta:
		if t.thinkingStartedAt == 0 {
			t.thinkingStartedAt = time.Now().UnixMilli()
			t.dirty = true
		}
	case core.EvTextDelta, core.EvToolUseStart, core.EvToolCall, core.EvAssistantMessage, core.EvTurnEnd, core.EvRetry:
		if t.thinkingStartedAt != 0 {
			t.thinkingStartedAt = 0
			t.dirty = true
		}
	case core.EvToolProgress:
		if t.toolProgress == nil {
			t.toolProgress = map[string]string{}
		}
		text := t.toolProgress[e.ID] + e.Text
		if len(text) > 64*1024 {
			text = text[len(text)-64*1024:]
		}
		t.toolProgress[e.ID] = text
		t.dirty = true
	case core.EvToolResult:
		delete(t.toolProgress, e.ID)
		delete(t.toolStarts, e.ID)
		t.dirty = true
	}
	if t.live == nil {
		return
	}
	blocks := &t.live.Content
	switch e := event.(type) {
	case core.EvTurnEnd, core.EvRetry:
		t.live = nil
	case core.EvTextDelta:
		if len(*blocks) == 0 || (*blocks)[len(*blocks)-1].Text == "" {
			*blocks = append(*blocks, liveBlock{})
		}
		(*blocks)[len(*blocks)-1].Text += e.Delta
	case core.EvReasoningDelta:
		for i := range *blocks {
			if (*blocks)[i].Summary != "" {
				(*blocks)[i].Summary += e.Delta
				return
			}
		}
		*blocks = append(*blocks, liveBlock{Summary: e.Delta})
	case core.EvToolUseStart:
		*blocks = append(*blocks, liveBlock{ID: e.ID, Name: e.Name})
	case core.EvToolUseArgs:
		for i := range *blocks {
			if (*blocks)[i].ID == e.ID {
				(*blocks)[i].Arguments += e.Delta
				return
			}
		}
	case core.EvToolCall:
		for i := range *blocks {
			if (*blocks)[i].ID == e.ID {
				(*blocks)[i].Arguments = string(e.Args)
				return
			}
		}
	}
}

// sanitizeMessagesForFrontend strips daemon-internal content (tool result
// line-prefix notices) and resolves legacy user_text meta. Same behavior
// as v1; pure function, no actor state.
func sanitizeMessagesForFrontend(msgs []provider.Message, attachments ...[]AttachmentRef) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}
	out := make([]provider.Message, len(msgs))
	for i, m := range msgs {
		if _, modern := m.Meta["user_text"]; m.Role == provider.RoleUser && !modern && len(attachments) > 0 {
			if ids := messageAttachmentIDs(m, attachments[0]); len(ids) > 0 {
				meta := attachmentMessageMeta(messageUserText(m), ids, attachments[0])
				for k, v := range m.Meta {
					meta[k] = v
				}
				m.Meta = meta
			}
		}
		if text, ok := m.Meta["user_text"]; m.Role == provider.RoleUser && ok {
			m.Content = []provider.Content{provider.TextBlock{Text: text}}
		}
		if m.Role != provider.RoleTool {
			out[i] = m
			continue
		}
		newBlocks := make([]provider.Content, len(m.Content))
		for j, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok {
				newBlocks[j] = c
				continue
			}
			innerContent := make([]provider.Content, len(tr.Content))
			for k, inner := range tr.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					cleaned := strings.ReplaceAll(tb.Text, tools.LinePrefixNotice, "")
					innerContent[k] = provider.TextBlock{
						Text:             cleaned,
						ThoughtSignature: tb.ThoughtSignature,
					}
				} else {
					innerContent[k] = inner
				}
			}
			tr.Content = innerContent
			newBlocks[j] = tr
		}
		mCopy := m
		mCopy.Content = newBlocks
		out[i] = mCopy
	}
	return out
}

// sessionPayload serializes a full record for the web client.
func sessionPayload(rec *SessionRecord) map[string]any {
	return map[string]any{
		"id": rec.ID, "cwd": rec.CWD, "title": rec.Title, "model": rec.Model, "status": rec.Status,
		"pinned": rec.Pinned, "usage": rec.Usage, "context": rec.Context, "options": normalizedOptions(rec.Options),
		"turn": rec.Turn, "todos": rec.Todos, "todosOpen": rec.TodosOpen,
		"workspace": inspectWorkspace(rec.CWD),
		"createdAt": rec.CreatedAt, "updatedAt": rec.UpdatedAt, "messages": sanitizeMessagesForFrontend(rec.Messages, rec.Attachments),
		"attachments":  rec.Attachments,
		"queue":        queuePayload(rec.Queue),
		"compaction":   rec.Compaction,
		"turnSeq":      rec.TurnSeq,
		"fileBalloons": fileBalloonPayloads(rec.FileBalloons),
	}
}

// pagedHistoryBlock swaps a full payload's transcript for the tail history
// block plus the get_history cursor. Every session_data event goes through
// here so no path ships a full transcript.
func pagedHistoryBlock(p map[string]any, rec *SessionRecord) map[string]any {
	block := sliceHistoryBlock(rec.Messages, rec.FileBalloons, 0)
	p["messages"] = sanitizeMessagesForFrontend(block.Messages, rec.Attachments)
	p["fileBalloons"] = fileBalloonPayloads(block.Balloons)
	p["history"] = map[string]any{
		"oldestTurn": block.OldestTurn,
		"newestTurn": block.NewestTurn,
		"hasOlder":   block.HasOlder,
		"totalTurns": block.TotalTurns,
		"firstIndex": block.FirstIndex,
	}
	return p
}

// sessionPayloadPaged is the gradual-loading shape.
func sessionPayloadPaged(rec *SessionRecord, beforeTurn int) map[string]any {
	if beforeTurn > 0 {
		p := sessionPayload(rec)
		block := sliceHistoryBlock(rec.Messages, rec.FileBalloons, beforeTurn)
		p["messages"] = sanitizeMessagesForFrontend(block.Messages, rec.Attachments)
		p["fileBalloons"] = fileBalloonPayloads(block.Balloons)
		p["history"] = map[string]any{
			"oldestTurn": block.OldestTurn,
			"newestTurn": block.NewestTurn,
			"hasOlder":   block.HasOlder,
			"totalTurns": block.TotalTurns,
			"firstIndex": block.FirstIndex,
		}
		return p
	}
	return pagedHistoryBlock(sessionPayload(rec), rec)
}

// messageAttachment is the wire shape for attachment references in message meta.
type messageAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

func attachmentMessageMeta(text string, ids []string, attachments []AttachmentRef) map[string]string {
	refs := []messageAttachment{}
	for _, id := range ids {
		for _, a := range attachments {
			if a.ID == id {
				refs = append(refs, messageAttachment{a.ID, a.Name, a.Mime, a.Size})
				break
			}
		}
	}
	data, _ := json.Marshal(refs)
	return map[string]string{"user_text": text, "attachments": string(data)}
}

func messageUserText(msg provider.Message) string {
	if text, ok := msg.Meta["user_text"]; ok {
		return text
	}
	parts := []string{}
	for _, c := range msg.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			parts = append(parts, tb.Text)
		}
	}
	text := core.StripLeadingSystemPrompt(strings.Join(parts, "\n"))
	for _, marker := range []string{"\n\n[Attached file:", "\n\n[Attached image:", "\n\n[Attached binary file:"} {
		if i := strings.Index(text, marker); i >= 0 {
			text = text[:i]
		}
	}
	return text
}

func messageAttachmentIDs(msg provider.Message, attachments []AttachmentRef) []string {
	if raw, ok := msg.Meta["attachments"]; ok {
		var refs []messageAttachment
		if json.Unmarshal([]byte(raw), &refs) == nil {
			ids := []string{}
			for _, ref := range refs {
				ids = append(ids, ref.ID)
			}
			return ids
		}
	}
	ids := []string{}
	for _, a := range attachments {
		matched := false
		for _, c := range msg.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				if a.Path != "" && strings.Contains(b.Text, a.Path) {
					matched = true
				}
				for _, marker := range []string{"[Attached file: " + a.Name + "]", "[Attached file: " + a.Name + " (", "[Attached binary file: " + a.Name + " ("} {
					if strings.Contains(b.Text, marker) {
						matched = true
					}
				}
			case provider.ImageBlock:
				if data, err := os.ReadFile(a.Path); err == nil && bytes.Equal(data, b.Data) {
					matched = true
				}
			}
		}
		if matched {
			ids = append(ids, a.ID)
		}
	}
	return ids
}
