package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

// WriteTool writes content to a file, creating parent directories.
type WriteTool struct {
	CWD     string
	Sandbox *Sandbox
}

type writeArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

const writeSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to write (absolute or relative to working directory)."},"content":{"type":"string","description":"Full content to write to the file."}},"required":["path","content"]}`

func (t *WriteTool) Name() string { return "write" }
func (t *WriteTool) Description() string {
	return "Write a file. Creates parent dirs. Overwrites. For NEW files or full rewrites only — to change part of an existing file use edit, never rewrite the whole file by hand."
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

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return core.ToolResult{}, err
	}
	if err := os.WriteFile(path, []byte(a.Content), 0o644); err != nil {
		return core.ToolResult{}, err
	}

	lines := strings.Split(a.Content, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" && strings.HasSuffix(a.Content, "\n") {
		lines = lines[:len(lines)-1]
	}
	var aiSb strings.Builder
	aiSb.WriteString(LinePrefixNotice)
	for i, line := range lines {
		fmt.Fprintf(&aiSb, "%d:%s\n", i+1, line)
	}

	totalLines := strings.Count(a.Content, "\n")
	if len(a.Content) > 0 && !strings.HasSuffix(a.Content, "\n") {
		totalLines++ // count the last unterminated line
	}
	return core.ToolResult{
		Content:   []provider.Content{provider.TextBlock{Text: aiSb.String()}},
		UIContent: a.Content,
		Details: map[string]any{
			"path":        path,
			"bytes":       len(a.Content),
			"total_lines": totalLines,
			"start_line":  1,
		},
	}, nil
}
