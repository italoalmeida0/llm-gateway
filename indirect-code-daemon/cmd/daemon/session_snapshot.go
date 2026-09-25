package main

import (
	"encoding/json"
	"maps"
	"slices"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Strings and value blocks are immutable; copy only mutable containers at
// the ownership boundary. This avoids serializing the entire transcript.
func cloneMessages(messages []provider.Message) []provider.Message {
	out := slices.Clone(messages)
	for i := range out {
		out[i].Meta = maps.Clone(out[i].Meta)
		out[i].AddedToolNames = slices.Clone(out[i].AddedToolNames)
		out[i].Content = cloneContent(out[i].Content)
	}
	return out
}

func cloneContent(content []provider.Content) []provider.Content {
	out := slices.Clone(content)
	for i, block := range out {
		switch b := block.(type) {
		case provider.ImageBlock:
			b.Data = slices.Clone(b.Data)
			out[i] = b
		case provider.ToolCallBlock:
			b.Arguments = slices.Clone(b.Arguments)
			out[i] = b
		case provider.ToolResultBlock:
			b.Content = cloneContent(b.Content)
			b.Details = cloneJSON(b.Details)
			out[i] = b
		}
	}
	return out
}

// Small JSON metadata (compaction/file changes/context) has no interface
// content blocks. The codec preserves its declared types and nested slices.
func cloneJSON[T any](value T) T {
	data, err := json.Marshal(value)
	if err != nil {
		panic("non-serializable session metadata: " + err.Error())
	}
	var out T
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

func cloneRecord(rec *SessionRecord) *SessionRecord {
	cp := *rec
	cp.Messages = nil
	out := cloneJSON(cp)
	out.Messages = cloneMessages(rec.Messages)
	return &out
}
