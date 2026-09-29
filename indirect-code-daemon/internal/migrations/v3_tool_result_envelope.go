package migrations

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// v3 wraps legacy tool_result bodies in the pseudo-XML envelope. Starting
// with the envelope format, every tool result the model sees is:
//
//	<tool_result type="ok" exit="0">pure tool output</tool_result>
//	<tool_result type="error">system error message</tool_result>
//
// where the body is ONLY tool content and system metadata lives in
// attributes. Transcripts written before that change carry the old mixed
// text (output + "[Showing lines …]" notes + status lines). This migration
// rewrites every persisted tool_result so historical turns read in the same
// shape as new ones:
//
//   - text bodies that do not already start with "<tool_result" are wrapped
//     as <tool_result type="ok|error">body</tool_result> (is_error picks the
//     type); nothing is dropped or reworded, so the old notes stay visible
//     inside the body.
//   - already-wrapped bodies (idempotent re-runs) are left untouched.
//
// Only sessions/sess_*.jsonl turn lines are touched; meta lines, balloon and
// usage are copied through byte-for-byte. Files are rewritten atomically.
//
// Idempotent: re-running finds no unwrapped bodies and rewrites nothing.

func init() {
	register(Migration{Version: 3, Name: "wrap legacy tool results in envelope", Apply: applyV3, Verify: verifyV3})
}

func applyV3(slotDir string) error {
	sessions := filepath.Join(slotDir, "sessions")
	entries, err := os.ReadDir(sessions)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		p := filepath.Join(sessions, e.Name())
		if err := wrapSessionToolResults(p); err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
	}
	return nil
}

// wrapSessionToolResults rewrites one session JSONL, enveloping tool_result
// text bodies in turn lines. Returns nil (no rewrite) when nothing changed.
func wrapSessionToolResults(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := bytes.Split(raw, []byte("\n"))
	changed := false
	out := make([][]byte, 0, len(lines))
	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			out = append(out, line)
			continue
		}
		var probe struct {
			Kind     string            `json:"kind"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(trimmed, &probe); err != nil || probe.Kind != "turn" {
			out = append(out, line)
			continue
		}
		rewrote := false
		for i, m := range probe.Messages {
			nm, ok := wrapMessageToolResults(m)
			if ok {
				probe.Messages[i] = nm
				rewrote = true
			}
		}
		if !rewrote {
			out = append(out, line)
			continue
		}
		// Re-marshal the turn line with the same envelope: keep unknown
		// fields by re-encoding the whole line object.
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(trimmed, &obj); err != nil {
			out = append(out, line)
			continue
		}
		msgs, err := json.Marshal(probe.Messages)
		if err != nil {
			out = append(out, line)
			continue
		}
		obj["messages"] = msgs
		nl, err := json.Marshal(obj)
		if err != nil {
			out = append(out, line)
			continue
		}
		out = append(out, nl)
		changed = true
	}
	if !changed {
		return nil
	}
	data := bytes.Join(out, []byte("\n"))
	tmp := path + ".v3tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// wrapMessageToolResults envelops every tool_result text body in one
// message. ok is false when nothing changed.
func wrapMessageToolResults(raw json.RawMessage) (json.RawMessage, bool) {
	var msg struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || len(msg.Content) == 0 {
		return nil, false
	}
	changed := false
	for i, c := range msg.Content {
		var head struct {
			CallID  string `json:"call_id"`
			IsError bool   `json:"is_error"`
		}
		if err := json.Unmarshal(c, &head); err != nil || head.CallID == "" {
			continue
		}
		var block struct {
			Content []json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(c, &block); err != nil {
			continue
		}
		blockChanged := false
		for j, inner := range block.Content {
			var t struct {
				Text     string `json:"text"`
				MimeType string `json:"mime_type"`
			}
			if err := json.Unmarshal(inner, &t); err != nil || t.MimeType != "" {
				continue
			}
			if strings.HasPrefix(t.Text, "<tool_result") {
				continue // already enveloped
			}
			typ := "ok"
			if head.IsError {
				typ = "error"
			}
			wrapped := core.ToolEnvelope(typ, nil, t.Text)
			nb, err := json.Marshal(map[string]any{"text": wrapped})
			if err != nil {
				continue
			}
			block.Content[j] = nb
			blockChanged = true
		}
		if !blockChanged {
			continue
		}
		// Re-encode the block keeping unknown fields.
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(c, &obj); err != nil {
			continue
		}
		nc, err := json.Marshal(block.Content)
		if err != nil {
			continue
		}
		obj["content"] = nc
		nb, err := json.Marshal(obj)
		if err != nil {
			continue
		}
		msg.Content[i] = nb
		changed = true
	}
	if !changed {
		return nil, false
	}
	// Preserve the message's other fields (id/role/time/meta/...).
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, false
	}
	obj["content"] = mustRaw(msg.Content)
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, false
	}
	return out, true
}

func mustRaw(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func verifyV3(slotDir string) error {
	sessions := filepath.Join(slotDir, "sessions")
	entries, err := os.ReadDir(sessions)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(sessions, e.Name()))
		if err != nil {
			return err
		}
		for _, line := range bytes.Split(raw, []byte("\n")) {
			var probe struct {
				Kind     string            `json:"kind"`
				Messages []json.RawMessage `json:"messages"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(line), &probe); err != nil || probe.Kind != "turn" {
				continue
			}
			for _, m := range probe.Messages {
				if hasUnwrappedToolResult(m) {
					return fmt.Errorf("%s: unwrapped tool_result body remains", e.Name())
				}
			}
		}
	}
	return nil
}

func hasUnwrappedToolResult(raw json.RawMessage) bool {
	var msg struct {
		Content []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return false
	}
	for _, c := range msg.Content {
		var head struct {
			CallID string `json:"call_id"`
		}
		if err := json.Unmarshal(c, &head); err != nil || head.CallID == "" {
			continue
		}
		var block struct {
			Content []json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(c, &block); err != nil {
			continue
		}
		for _, inner := range block.Content {
			var t struct {
				Text     string `json:"text"`
				MimeType string `json:"mime_type"`
			}
			if err := json.Unmarshal(inner, &t); err != nil || t.MimeType != "" {
				continue
			}
			if t.Text != "" && !strings.HasPrefix(t.Text, "<tool_result") {
				return true
			}
		}
	}
	return false
}
