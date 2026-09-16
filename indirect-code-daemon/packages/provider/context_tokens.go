package provider

import (
	"encoding/base64"
	"encoding/json"

	"github.com/italoalmeida0/btdby4"
)

// ContextTokens counts a provider-neutral request (system + tools +
// messages) as an Anthropic Messages payload with btdby4, the daemon's
// single ruler for context occupancy. Provider-reported usage numbers
// are metrics only (cost display, session stats) and never drive
// compaction, pruning, or budgeting decisions.
//
// The payload mirrors buildRequest's Anthropic serialization
// (buildAnthUserContent / buildAnthToolResultContent / assistant
// tool_use + redacted_thinking replay) so the count matches what
// actually rides the wire, including images, tool I/O, and replayed
// encrypted thinking. Returns the Total (content + small generic
// safety margin), which keeps proactive compaction conservative.
func ContextTokens(system string, tools []Tool, messages []Message) int {
	req := btdby4.AnthropicRequest{}
	if system != "" {
		req.System = system
	}
	for _, m := range messages {
		role, content := anthropicCountMessage(m)
		if content == nil {
			continue
		}
		req.Messages = append(req.Messages, btdby4.AnthropicMessage{Role: role, Content: content})
	}
	activated := activatedToolNames(messages)
	for _, t := range tools {
		if t.Deferred && !activated[t.Name] {
			continue
		}
		schema := t.Schema
		if len(schema) == 0 || !json.Valid(schema) {
			schema = json.RawMessage(`{"type":"object"}`)
		}
		var schemaAny any
		if err := json.Unmarshal(schema, &schemaAny); err != nil {
			schemaAny = map[string]any{"type": "object"}
		}
		req.Tools = append(req.Tools, btdby4.AnthropicTool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: schemaAny,
		})
	}
	bd, err := btdby4.CountAnthropicRequest(req, btdby4.Options{})
	if err != nil {
		return 0
	}
	return bd.Total
}

// ContextTokensByMessage counts like ContextTokens but also returns the
// per-message breakdown (same order as messages, skipping messages that
// serialize to nothing). Used to locate cut points without recounting.
func ContextTokensByMessage(system string, tools []Tool, messages []Message) (int, []int) {
	total := ContextTokens(system, tools, messages)
	per := make([]int, 0, len(messages))
	for _, m := range messages {
		role, content := anthropicCountMessage(m)
		if content == nil {
			continue
		}
		bb, err := btdby4.CountAnthropicMessage(btdby4.AnthropicMessage{Role: role, Content: content}, btdby4.Options{})
		if err != nil {
			per = append(per, 0)
			continue
		}
		per = append(per, bb.Tokens)
	}
	return total, per
}

// anthropicCountMessage serializes one provider-neutral message the same
// way buildRequest does for the Anthropic wire. Returns nil content for
// messages that serialize to nothing (blank text, server-only tool
// calls, transcript-only reasoning summaries).
func anthropicCountMessage(msg Message) (string, any) {
	switch msg.Role {
	case RoleUser:
		blocks := anthropicCountUserContent(msg.Content)
		if len(blocks) == 0 {
			return "", nil
		}
		return "user", blocks
	case RoleAssistant:
		var blocks []any
		var text string
		flush := func() {
			if text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
				text = ""
			}
		}
		for _, b := range msg.Content {
			switch v := b.(type) {
			case TextBlock:
				if v.Text == "" {
					continue
				}
				if text != "" {
					text += "\n"
				}
				text += v.Text
			case ToolCallBlock:
				if v.Server {
					continue
				}
				flush()
				args := v.Arguments
				if len(args) == 0 || !json.Valid(args) {
					args = json.RawMessage("{}")
				}
				var inputAny any
				if err := json.Unmarshal(args, &inputAny); err != nil {
					inputAny = map[string]any{}
				}
				blocks = append(blocks, map[string]any{
					"type": "tool_use", "id": v.ID, "name": v.Name, "input": inputAny,
				})
				if v.ThoughtSignature != "" {
					// btdby4 auto-detects encrypted thinking payloads
					// anywhere in the payload (see doc.go).
					blocks = append(blocks, map[string]any{
						"type": "redacted_thinking", "data": v.ThoughtSignature,
					})
				}
			case ReasoningBlock:
				// Same rule as the wire: replayed encrypted blobs count,
				// bare summaries are transcript-only.
				if v.Encrypted != "" {
					flush()
					blocks = append(blocks, map[string]any{
						"type": "redacted_thinking", "data": v.Encrypted,
					})
				}
				if v.Summary != "" {
					if text != "" {
						text += "\n"
					}
					text += v.Summary
				}
			}
		}
		flush()
		if len(blocks) == 0 {
			return "", nil
		}
		return "assistant", blocks
	case RoleTool:
		var blocks []any
		for _, b := range msg.Content {
			if tr, ok := b.(ToolResultBlock); ok {
				content := anthropicCountToolResultContent(tr.Content)
				block := map[string]any{"type": "tool_result", "tool_use_id": tr.CallID}
				if s, ok := content.(string); ok {
					block["content"] = s
				} else {
					block["content"] = content
				}
				if tr.IsError {
					block["is_error"] = true
				}
				blocks = append(blocks, block)
			}
		}
		if len(blocks) == 0 {
			return "", nil
		}
		return "user", blocks
	default:
		return "", nil
	}
}

func anthropicCountUserContent(blocks []Content) []any {
	var out []any
	for _, b := range blocks {
		switch v := b.(type) {
		case TextBlock:
			out = append(out, map[string]any{"type": "text", "text": v.Text})
		case ImageBlock:
			out = append(out, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type": "base64", "media_type": v.MimeType,
					"data": base64.StdEncoding.EncodeToString(v.Data),
				},
			})
		}
		// btdby4 auto-detects encrypted thinking payloads anywhere in
		// the payload (see doc.go): feed signatures as redacted_thinking.
		if tb, ok := b.(TextBlock); ok && tb.ThoughtSignature != "" {
			out = append(out, map[string]any{
				"type": "redacted_thinking", "data": tb.ThoughtSignature,
			})
		}
		if ib, ok := b.(ImageBlock); ok && ib.ThoughtSignature != "" {
			out = append(out, map[string]any{
				"type": "redacted_thinking", "data": ib.ThoughtSignature,
			})
		}
	}
	return out
}

func anthropicCountToolResultContent(blocks []Content) any {
	var out []any
	for _, b := range blocks {
		switch v := b.(type) {
		case TextBlock:
			out = append(out, map[string]any{"type": "text", "text": v.Text})
		case ImageBlock:
			out = append(out, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type": "base64", "media_type": v.MimeType,
					"data": base64.StdEncoding.EncodeToString(v.Data),
				},
			})
		}
	}
	if len(out) == 0 {
		return ""
	}
	if len(out) == 1 {
		if tm, ok := out[0].(map[string]any); ok && tm["type"] == "text" {
			if s, ok := tm["text"].(string); ok {
				return s
			}
		}
	}
	return out
}
