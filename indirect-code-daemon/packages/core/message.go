package core

import (
	"encoding/json"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// ---- content (de)serialization ----
//
// provider.Content is an interface; encoding/json drops type information.
// We persist messages by reading the raw "message" object back and
// rebuilding Content from discriminated fields.

// HydrateMessageObject rebuilds a provider.Message (with its typed
// Content blocks) from the raw JSON object of a persisted message.
func HydrateMessageObject(rawMessage []byte) (provider.Message, error) {
	var row struct {
		Role           provider.Role     `json:"role"`
		Content        []json.RawMessage `json:"content"`
		Time           time.Time         `json:"time"`
		Meta           map[string]string `json:"meta,omitempty"`
		AddedToolNames []string          `json:"added_tool_names,omitempty"`
		TurnIndex      int               `json:"turnIndex,omitempty"`
	}
	if err := json.Unmarshal(rawMessage, &row); err != nil {
		return provider.Message{}, err
	}
	msg := provider.Message{Role: row.Role, Time: row.Time, Meta: row.Meta, AddedToolNames: row.AddedToolNames, TurnIndex: row.TurnIndex}
	for _, raw := range row.Content {
		var head struct {
			Text             string `json:"text"`
			MimeType         string `json:"mime_type"`
			Data             []byte `json:"data"`
			ID               string `json:"id"`
			Name             string `json:"name"`
			CallID           string `json:"call_id"`
			ReasoningID      string `json:"reasoning_id"`
			Summary          string `json:"summary"`
			Encrypted        string `json:"encrypted_content"`
			ThoughtSignature string `json:"thought_signature"`
			// ToolCallBlock also has Arguments, ToolResultBlock has Content + IsError
		}
		if err := json.Unmarshal(raw, &head); err != nil {
			continue
		}
		// Discriminate by presence of fields.
		switch {
		case head.ReasoningID != "" || head.Summary != "" || head.Encrypted != "":
			msg.Content = append(msg.Content, provider.ReasoningBlock{
				ID:        head.ReasoningID,
				Summary:   head.Summary,
				Encrypted: head.Encrypted,
			})
		case head.Name != "" && head.ID != "":
			var tc struct {
				ID               string          `json:"id"`
				Name             string          `json:"name"`
				Arguments        json.RawMessage `json:"arguments"`
				ThoughtSignature string          `json:"thought_signature"`
				Server           bool            `json:"server"`
			}
			_ = json.Unmarshal(raw, &tc)
			msg.Content = append(msg.Content, provider.ToolCallBlock{
				ID:               tc.ID,
				Name:             tc.Name,
				Arguments:        tc.Arguments,
				ThoughtSignature: tc.ThoughtSignature,
				Server:           tc.Server,
			})
		case head.CallID != "":
			var tr struct {
				StartedAt  int64             `json:"started_at"`
				DurationMs int64             `json:"duration_ms"`
				CallID     string            `json:"call_id"`
				Content    []json.RawMessage `json:"content"`
				IsError    bool              `json:"is_error"`
				// Details is frontend-only rendering data (bash terminal
				// view, read line numbers, edit diffs). It is persisted
				// but never sent to the LLM; dropping it here would make
				// the first save after a restart strip it permanently and
				// the transcript would fall back to raw tool output.
				Details json.RawMessage `json:"details"`
			}
			_ = json.Unmarshal(raw, &tr)
			block := provider.ToolResultBlock{CallID: tr.CallID, IsError: tr.IsError, StartedAt: tr.StartedAt, DurationMs: tr.DurationMs}
			if len(tr.Details) > 0 && string(tr.Details) != "null" {
				block.Details = json.RawMessage(tr.Details)
			}
			for _, c := range tr.Content {
				var inner struct {
					Text     string `json:"text"`
					MimeType string `json:"mime_type"`
					Data     []byte `json:"data"`
				}
				_ = json.Unmarshal(c, &inner)
				if inner.MimeType != "" {
					block.Content = append(block.Content, provider.ImageBlock{MimeType: inner.MimeType, Data: inner.Data})
				} else {
					block.Content = append(block.Content, provider.TextBlock{Text: inner.Text})
				}
			}
			msg.Content = append(msg.Content, block)
		case head.MimeType != "":
			msg.Content = append(msg.Content, provider.ImageBlock{
				MimeType:         head.MimeType,
				Data:             head.Data,
				ThoughtSignature: head.ThoughtSignature,
			})
		default:
			msg.Content = append(msg.Content, provider.TextBlock{
				Text:             head.Text,
				ThoughtSignature: head.ThoughtSignature,
			})
		}
	}
	return msg, nil
}

// repairToolUseResultPairs walks a transcript and synthesises stub
// tool_result blocks for any assistant tool_use blocks that aren't
// paired with a matching result in the next message. Anthropic (and
// OpenAI via the responses API) reject any request whose transcript
// leaves a tool_use without its matching tool_result immediately
// after, with errors like:
//
//	messages.8: `tool_use` ids were found without `tool_result`
//	blocks immediately after
//
// An aborted turn (context cancelled mid-tool-loop) can leave the
// assistant tool_use row in the transcript without its result row.
// Rather than change runtime semantics (which would risk hiding a
// real bug), we scrub on read: any unmatched tool_use gets a stub
// tool_result injected as a RoleTool message so the next outbound
// request passes the provider's validity check. The stub reads
// "tool call was aborted; no result recorded." so the model can see
// what happened and decide whether to retry.
func repairToolUseResultPairs(msgs []provider.Message) []provider.Message {
	if len(msgs) == 0 {
		return msgs
	}
	out := make([]provider.Message, 0, len(msgs)+2)
	for i, m := range msgs {
		out = append(out, m)
		if m.Role != provider.RoleAssistant {
			continue
		}
		// Collect tool_use ids in this assistant message.
		var ids []string
		for _, c := range m.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok && !tc.Server {
				ids = append(ids, tc.ID)
			}
		}
		if len(ids) == 0 {
			continue
		}
		// Look at the next message (if any) and collect tool_result
		// CallIDs it covers.
		have := map[string]bool{}
		if i+1 < len(msgs) && msgs[i+1].Role == provider.RoleTool {
			for _, c := range msgs[i+1].Content {
				if tr, ok := c.(provider.ToolResultBlock); ok {
					have[tr.CallID] = true
				}
			}
		}
		// Build stubs for any missing id.
		var stubs []provider.Content
		for _, id := range ids {
			if have[id] {
				continue
			}
			stubs = append(stubs, provider.ToolResultBlock{
				CallID:  id,
				Content: []provider.Content{provider.TextBlock{Text: "tool call was aborted; no result recorded."}},
				IsError: true,
			})
		}
		if len(stubs) == 0 {
			continue
		}
		// Merge into the next tool-role message if present,
		// otherwise insert a synthetic one right after the
		// assistant message. Merging keeps the tool-role row
		// count stable; inserting handles the common case where
		// no tool message was persisted at all.
		if i+1 < len(msgs) && msgs[i+1].Role == provider.RoleTool {
			msgs[i+1].Content = append(msgs[i+1].Content, stubs...)
			// We already appended m to out; the modified next
			// message will be appended on the following iteration.
			continue
		}
		out = append(out, provider.Message{
			Role:      provider.RoleTool,
			Content:   stubs,
			Time:      m.Time,
			TurnIndex: m.TurnIndex,
		})
	}
	return out
}
