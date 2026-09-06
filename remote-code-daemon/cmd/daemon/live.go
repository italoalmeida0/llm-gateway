package main

import (
	"time"

	"github.com/patriceckhart/zot/packages/core"
)

// A transient replay of only the current assistant response. Completed
// messages live in SessionRecord; these deltas never become mirrored data.
// Arguments are strings because streaming tool JSON can still be incomplete.
type liveBlock struct {
	Text      string `json:"text,omitempty"`
	Summary   string `json:"summary,omitempty"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"`
}

type liveAssistant struct {
	Role    string      `json:"role"`
	Content []liveBlock `json:"content"`
}

// Caller holds act.mu, including while sending the corresponding event, so
// a reconnect snapshot and subsequent deltas have one consistent ordering.
func trackLiveEvent(act *ActiveSession, event core.AgentEvent) {
	if _, ok := event.(core.EvAssistantStart); ok {
		act.thinkingStartedAt = 0
		act.live = &liveAssistant{Role: "assistant", Content: []liveBlock{}}
		return
	}
	switch e := event.(type) {
	case core.EvReasoningDelta:
		if act.thinkingStartedAt == 0 {
			act.thinkingStartedAt = time.Now().UnixMilli()
		}
	case core.EvTextDelta, core.EvToolUseStart, core.EvTurnEnd:
		act.thinkingStartedAt = 0
	case core.EvToolProgress:
		if act.toolProgress == nil {
			act.toolProgress = map[string]string{}
		}
		text := act.toolProgress[e.ID] + e.Text
		if len(text) > 64*1024 {
			text = text[len(text)-64*1024:]
		}
		act.toolProgress[e.ID] = text
	case core.EvToolResult:
		delete(act.toolProgress, e.ID)
	}
	if act.live == nil {
		return
	}
	blocks := &act.live.Content
	switch e := event.(type) {
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

func liveSessionPayload(act *ActiveSession) map[string]any {
	payload := sessionPayload(act.record)
	payload["pendingApproval"] = act.pendingApproval
	progress := map[string]string{}
	for id, text := range act.toolProgress {
		progress[id] = text
	}
	payload["toolProgress"] = progress
	payload["thinkingStartedAt"] = act.thinkingStartedAt
	if act.live == nil {
		return payload
	}
	messages := make([]any, 0, len(act.record.Messages)+1)
	for _, message := range act.record.Messages {
		messages = append(messages, message)
	}
	live := *act.live
	live.Content = append([]liveBlock(nil), act.live.Content...)
	payload["messages"] = append(messages, live)
	return payload
}
