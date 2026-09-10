package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// WriteTool writes content to a file, creating parent directories.
type WriteTool struct {
	CWD     string
	Sandbox *Sandbox
	Changes ChangeTracker
	// BrainDir is the absolute path of the per-session private workspace.
	// Access-only: the sandbox allowlists it and scratch writes skip
	// change tracking. It is advertised through the mode instructions,
	// never through this tool's description.
	BrainDir string
}

// isBrainPath reports whether an absolute path lives in the scratch space.
func (t *WriteTool) isBrainPath(abs string) bool {
	if t.BrainDir == "" {
		return false
	}
	target, err := canonicalOrParent(abs)
	if err != nil {
		return false
	}
	brain, err := canonicalOrParent(t.BrainDir)
	if err != nil {
		return false
	}
	return isUnder(brain, target)
}

type writeArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

const writeSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to write (relative or absolute)"},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"]}`

func (t *WriteTool) Name() string { return "write" }
func (t *WriteTool) Description() string {
	// Mirrors pi's write tool description.
	return "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
}
func (t *WriteTool) Schema() json.RawMessage { return json.RawMessage(writeSchema) }

func (t *WriteTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a writeArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if a.Path == "" {
		return core.ToolResult{}, fmt.Errorf("path is required")
	}
	path := resolvePath(t.CWD, a.Path)
	if err := t.Sandbox.CheckWritePath(path); err != nil {
		return core.ToolResult{}, err
	}

	// Change tracking (first sighting only): if the file existed, snapshot
	// its old content; if not, mark it as new without storing content
	// (the final content is read at end of turn). Scratch-space writes
	// are never tracked: they are not user-facing changes.
	if t.Changes != nil && !t.isBrainPath(path) {
		if old, err := os.ReadFile(path); err == nil {
			if looksBinary(old) {
				t.Changes.NoteBinaryNew(path)
			} else if capped, tooLarge := cappedSnapshot(old); tooLarge {
				t.Changes.NoteBinaryNew(path)
			} else {
				t.Changes.NoteWrite(path, true, capped)
			}
		} else if os.IsNotExist(err) {
			t.Changes.NoteWrite(path, false, "")
		}
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return core.ToolResult{}, err
	}
	if err := os.WriteFile(path, []byte(a.Content), 0o644); err != nil {
		return core.ToolResult{}, err
	}

	// Frontend-only rendering: the line-prefixed echo of the written
	// content, kept identical so the UI transcript looks unchanged.
	lines := strings.Split(a.Content, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" && strings.HasSuffix(a.Content, "\n") {
		lines = lines[:n-1]
	}
	var sb strings.Builder
	sb.WriteString(LinePrefixNotice)
	for i, line := range lines {
		fmt.Fprintf(&sb, "%d:%s\n", i+1, line)
	}
	display := sb.String()

	totalLines := strings.Count(a.Content, "\n")
	if len(a.Content) > 0 && !strings.HasSuffix(a.Content, "\n") {
		totalLines++ // count the last unterminated line
	}
	return core.ToolResult{
		// Mirrors pi: a one-line confirmation; the model already knows
		// what it wrote and does not need the content echoed back.
		Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Successfully wrote to %s", a.Path)}},
		Details: map[string]any{
			"display":     display,
			"path":        path,
			"bytes":       len(a.Content),
			"total_lines": totalLines,
			"start_line":  1,
		},
	}, nil
}
