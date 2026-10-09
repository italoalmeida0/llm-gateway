package migrations

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// v4 renames the model-facing tool vocabulary inside persisted transcripts.
// The daemon speaks exactly ONE vocabulary: there are no legacy aliases and
// no fallbacks at runtime, so every historical turn must be rewritten here:
//
//	tool names
//	  mark_task_as_complete        -> finish_entire_request
//	  mark_plan_as_ready_to_execute -> finish_entire_request
//	  sleep                        -> bg_await
//
//	arguments (tool call blocks, "arguments" object)
//	  comprehensive_summary -> final_message_to_user
//	  notes/summary         -> final_message_to_user   (completion tools only)
//	  seconds               -> max_wait_seconds        (sleep only)
//	  waitingFor            -> waiting_for             (sleep only)
//	  summary               -> reason                  (sleep only)
//
//	plus the snake_case argument renames introduced in the same change
//	  oldText/newText/caseSensitive/caseInsensitive/contextLines/filesOnly/
//	  onlyMatching/maxResults/maxFileBytes/respectGitignore/timeoutSec/
//	  maxChars/showHidden/gitStatus/maxEntries/workdir
//
//	and AddedToolNames lists ("added_tool_names") on every message, which
//	feed skill activation.
//
// Meta lines, balloon lines and unknown fields are preserved byte-for-byte
// (turn lines are re-encoded from their decoded object so every other line
// stays untouched). Files are rewritten atomically via tmp + rename.
//
// Idempotent: a second run finds no legacy name/argument and rewrites
// nothing. Already-finished turns carry no WAL, and running-turn WALs are
// drained by the daemon before the chain runs, so no *.wal.jsonl file is
// rewritten.

func init() {
	register(Migration{Version: 4, Name: "rename tool vocabulary in transcripts", Apply: applyV4, Verify: verifyV4})
}

// v4ToolRenames maps every legacy tool name to its current name.
var v4ToolRenames = map[string]string{
	"mark_task_as_complete":         "finish_entire_request",
	"mark_plan_as_ready_to_execute": "finish_entire_request",
	"sleep":                         "bg_await",
}

// v4ArgRenames maps every legacy argument key to its current snake_case key.
// Context-sensitive entries (summary, seconds) are dispatched in renameArgs.
var v4ArgRenames = map[string]string{
	"comprehensive_summary": "final_message_to_user",
	"notes":                 "final_message_to_user",
	"summary":               "reason",
	"seconds":               "max_wait_seconds",
	"waitingFor":            "waiting_for",
	"oldText":               "old_text",
	"newText":               "new_text",
	"caseSensitive":         "case_sensitive",
	"caseInsensitive":       "case_insensitive",
	"contextLines":          "context_lines",
	"filesOnly":             "files_only",
	"onlyMatching":          "only_matching",
	"maxResults":            "max_results",
	"maxFileBytes":          "max_file_bytes",
	"respectGitignore":      "respect_gitignore",
	"timeoutSec":            "timeout_sec",
	"maxChars":              "max_chars",
	"showHidden":            "show_hidden",
	"gitStatus":             "git_status",
	"maxEntries":            "max_entries",
	"workdir":               "work_dir",
}

// completionTools are the tool names whose legacy summary arguments collapse
// into final_message_to_user. "summary" only renames for these tools: the
// summary tool keeps its own "summary" argument.
var completionTools = map[string]bool{
	"finish_entire_request": true,
	"mark_task_as_complete": true,
}

func applyV4(slotDir string) error {
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
		if err := renameSessionToolVocabulary(filepath.Join(sessions, e.Name())); err != nil {
			return fmt.Errorf("%s: %w", e.Name(), err)
		}
	}
	return nil
}

// renameSessionToolVocabulary rewrites one session JSONL in place. Returns
// nil (no rewrite) when nothing changed.
func renameSessionToolVocabulary(path string) error {
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
			nm, ok := renameMessageToolVocabulary(m)
			if ok {
				probe.Messages[i] = nm
				rewrote = true
			}
		}
		if !rewrote {
			out = append(out, line)
			continue
		}
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
	tmp := path + ".v4tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// renameMessageToolVocabulary rewrites tool call names, their arguments and
// the AddedToolNames list of one message. ok is false when nothing changed.
func renameMessageToolVocabulary(raw json.RawMessage) (json.RawMessage, bool) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, false
	}
	changed := false

	if namesRaw, ok := obj["added_tool_names"]; ok {
		if nn, ok := renameToolNameList(namesRaw); ok {
			obj["added_tool_names"] = nn
			changed = true
		}
	}

	if contentRaw, ok := obj["content"]; ok {
		var blocks []json.RawMessage
		if err := json.Unmarshal(contentRaw, &blocks); err == nil {
			blocksChanged := false
			for i, b := range blocks {
				nb, ok := renameCallBlock(b)
				if ok {
					blocks[i] = nb
					blocksChanged = true
				}
			}
			if blocksChanged {
				if encoded, err := json.Marshal(blocks); err == nil {
					obj["content"] = encoded
					changed = true
				}
			}
		}
	}

	if !changed {
		return nil, false
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return nil, false
	}
	return out, true
}

// renameCallBlock renames one tool call block ({id,name,arguments}). ok is
// false when nothing changed.
func renameCallBlock(raw json.RawMessage) (json.RawMessage, bool) {
	var block map[string]json.RawMessage
	if err := json.Unmarshal(raw, &block); err != nil {
		return nil, false
	}
	nameRaw, ok := block["name"]
	if !ok {
		return nil, false
	}
	var name string
	if err := json.Unmarshal(nameRaw, &name); err != nil {
		return nil, false
	}
	newName, renamed := v4ToolRenames[name]
	changed := false
	if renamed {
		if encoded, err := json.Marshal(newName); err == nil {
			block["name"] = encoded
			name = newName
			changed = true
		}
	}
	if argsRaw, ok := block["arguments"]; ok {
		if na, ok := renameArgs(name, argsRaw); ok {
			block["arguments"] = na
			changed = true
		}
	}
	if !changed {
		return nil, false
	}
	out, err := json.Marshal(block)
	if err != nil {
		return nil, false
	}
	return out, true
}

// renameArgs renames legacy argument keys of one call. Renames that would
// collide with an existing non-empty current argument are dropped, so a
// message can never lose a value. ok is false when nothing changed.
func renameArgs(toolName string, raw json.RawMessage) (json.RawMessage, bool) {
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil || len(args) == 0 {
		return nil, false
	}
	isCompletion := completionTools[toolName]
	changed := false
	for legacy, current := range v4ArgRenames {
		value, ok := args[legacy]
		if !ok {
			continue
		}
		// Context-sensitive renames: "summary" only becomes `reason` for
		// bg_await (the completion tools collapse it into
		// final_message_to_user, and the summary tool keeps its own key),
		// and "seconds" only becomes max_wait_seconds for bg_await.
		switch legacy {
		case "summary":
			if !isCompletion && toolName != "bg_await" {
				continue
			}
			if isCompletion {
				current = "final_message_to_user"
			} else {
				current = "reason"
			}
		case "seconds":
			if toolName != "bg_await" {
				continue
			}
		}
		if existing, ok := args[current]; ok && !isEmptyJSON(existing) {
			delete(args, legacy)
			changed = true
			continue
		}
		delete(args, legacy)
		args[current] = value
		changed = true
	}
	if !changed {
		return nil, false
	}
	out, err := json.Marshal(args)
	if err != nil {
		return nil, false
	}
	return out, true
}

// isEmptyJSON reports whether a persisted argument value carries nothing
// (absent, null, "", empty array/object).
func isEmptyJSON(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "", "null", `""`, "[]", "{}":
		return true
	}
	return false
}

// renameToolNameList rewrites a persisted AddedToolNames list. ok is false
// when nothing changed.
func renameToolNameList(raw json.RawMessage) (json.RawMessage, bool) {
	var names []string
	if err := json.Unmarshal(raw, &names); err != nil {
		return nil, false
	}
	changed := false
	seen := map[string]bool{}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if renamed, ok := v4ToolRenames[n]; ok {
			n = renamed
			changed = true
		}
		if seen[n] {
			changed = true
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	if !changed {
		return nil, false
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		return nil, false
	}
	return encoded, true
}

func verifyV4(slotDir string) error {
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
				if legacy := findLegacyVocabulary(m); legacy != "" {
					return fmt.Errorf("%s: %s remains", e.Name(), legacy)
				}
			}
		}
	}
	return nil
}

// findLegacyVocabulary returns a human description of the first legacy tool
// name or argument key left in one message, or "" when the message is clean.
func findLegacyVocabulary(raw json.RawMessage) string {
	var obj struct {
		AddedToolNames []string          `json:"added_tool_names"`
		Content        []json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ""
	}
	for _, n := range obj.AddedToolNames {
		if _, ok := v4ToolRenames[n]; ok {
			return fmt.Sprintf("tool name %q", n)
		}
	}
	for _, c := range obj.Content {
		var block struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(c, &block); err != nil || block.Name == "" {
			continue
		}
		name := block.Name
		if _, ok := v4ToolRenames[name]; ok {
			return fmt.Sprintf("tool name %q", name)
		}
		if len(block.Arguments) == 0 {
			continue
		}
		var args map[string]json.RawMessage
		if err := json.Unmarshal(block.Arguments, &args); err != nil {
			continue
		}
		for key := range args {
			if _, ok := v4ArgRenames[key]; !ok {
				continue
			}
			if key == "summary" && !completionTools[name] && name != "bg_await" {
				continue
			}
			if key == "seconds" && name != "bg_await" {
				continue
			}
			return fmt.Sprintf("argument %q of %s", key, name)
		}
	}
	return ""
}
