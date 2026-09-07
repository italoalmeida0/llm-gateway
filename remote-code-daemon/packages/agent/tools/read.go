// Package tools implements zot's built-in tools: read, write, edit, bash, glob.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

const (
	maxReadLines = 2000
	maxReadBytes = 50 * 1024
)

// LinePrefixNotice informs the AI that the leading "<number>:" prefix is for line
// reference only and not part of the file content.
const LinePrefixNotice = "[Note: The line prefix \"<number>:\" is for line identification only and is not part of the file content.]\n"

// ReadTool reads file contents from disk.
type ReadTool struct {
	CWD     string
	Sandbox *Sandbox // when jailed, confines reads to the sandbox root
}

type readArgs struct {
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	// ShowLineNumbers prefixes each line with its 1-indexed number
	// (cat -n style). Default false to save tokens; enable when the
	// caller needs to cite exact lines (e.g. before an edit).
	ShowLineNumbers bool `json:"showLineNumbers,omitempty"`
}

const readSchema = `{"type":"object","properties":{"path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"},"showLineNumbers":{"type":"boolean","description":"Prefix lines with 1-indexed numbers (cat -n). Default false."}},"required":["path"]}`

func (t *ReadTool) Name() string { return "read" }
func (t *ReadTool) Description() string {
	return "Read a file with line-range paging (offset/limit) and totalLines in Details. Images (png/jpg/gif/webp) return inline. Pass showLineNumbers:true when you need to cite exact lines. To FIND text first use search, then open hits here — never grep + read."
}
func (t *ReadTool) Schema() json.RawMessage { return json.RawMessage(readSchema) }

func (t *ReadTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a readArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if a.Path == "" {
		return core.ToolResult{}, fmt.Errorf("path is required")
	}
	path := resolvePath(t.CWD, a.Path)
	if err := t.Sandbox.CheckReadPath(path); err != nil {
		return core.ToolResult{}, err
	}
	// What the model sees in errors: relative to the sandbox root when
	// jailed, so absolute paths stay out of the context window.
	shown := t.Sandbox.DisplayPath(path, a.Path)

	info, err := os.Stat(path)
	if err != nil {
		return core.ToolResult{}, err
	}
	if info.IsDir() {
		return core.ToolResult{}, fmt.Errorf("%s is a directory", shown)
	}

	// Image handling.
	if mime := imageMIME(path); mime != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return core.ToolResult{}, err
		}
		// The extension is only a hint. Files are routinely mislabeled
		// (a .png that is actually JPEG bytes, a renamed download, an
		// editor that re-encoded on save). Anthropic and other providers
		// sniff the real bytes and reject the whole request when the
		// declared media type disagrees, which would break the session.
		// Always derive the MIME from the actual content; fall back to
		// the extension-based guess only when the bytes are unrecognized.
		if sniffed := sniffImageMIME(data); sniffed != "" {
			mime = sniffed
		}
		return core.ToolResult{
			Content: []provider.Content{provider.ImageBlock{MimeType: mime, Data: data}},
		}, nil
	}

	f, err := os.Open(path)
	if err != nil {
		return core.ToolResult{}, err
	}
	defer f.Close()

	// Read up to maxReadBytes and also line-limit.
	limited := io.LimitReader(f, int64(maxReadBytes)+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return core.ToolResult{}, err
	}
	truncBytes := len(data) > maxReadBytes
	if truncBytes {
		data = data[:maxReadBytes]
	}

	if looksBinary(data) {
		return core.ToolResult{}, fmt.Errorf("%s looks binary; refusing to read as text", a.Path)
	}

	lines := strings.Split(string(data), "\n")
	// Trim trailing empty line from final \n.
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}

	start := 0
	if a.Offset > 0 {
		start = a.Offset - 1
		if start > len(lines) {
			start = len(lines)
		}
	}
	end := len(lines)
	if a.Limit > 0 && start+a.Limit < end {
		end = start + a.Limit
	}
	selected := lines[start:end]

	truncLines := false
	if len(selected) > maxReadLines {
		selected = selected[:maxReadLines]
		truncLines = true
	}

	var rawSb strings.Builder
	var aiSb strings.Builder
	aiSb.WriteString(LinePrefixNotice)
	for i, line := range selected {
		lineNum := start + i + 1
		fmt.Fprintf(&aiSb, "%d:%s\n", lineNum, line)
		rawSb.WriteString(line)
		rawSb.WriteByte('\n')
	}
	if truncLines || truncBytes {
		aiSb.WriteString("\n")
		rawSb.WriteString("\n")
	}
	if truncLines {
		msg := fmt.Sprintf("... [truncated at %d lines]\n", maxReadLines)
		aiSb.WriteString(msg)
		rawSb.WriteString(msg)
	}
	if truncBytes {
		msg := fmt.Sprintf("... [truncated at %d bytes]\n", maxReadBytes)
		aiSb.WriteString(msg)
		rawSb.WriteString(msg)
	}
	if progress != nil {
		progress(rawSb.String())
	}

	return core.ToolResult{
		Content:   []provider.Content{provider.TextBlock{Text: aiSb.String()}},
		UIContent: rawSb.String(),
		Details: map[string]any{
			"path":              path,
			"start_line":        start + 1, // 1-indexed; TUI draws the gutter
			"lines_truncated":   truncLines,
			"bytes_truncated":   truncBytes,
			"total_lines":       len(lines),
			"totalLines":        len(lines),
			"show_line_numbers": a.ShowLineNumbers,
		},
	}, nil
}

func resolvePath(cwd, p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	return filepath.Join(cwd, p)
}

func imageMIME(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return ""
}

// sniffImageMIME inspects the leading bytes of an image file and
// returns the real media type, independent of the file's extension.
// Providers validate the declared media type against the actual bytes
// and 400 the whole request on a mismatch, so the extension can never
// be trusted. Returns "" when the format is not one zot ships images
// for, leaving the caller's extension-based guess in place.
func sniffImageMIME(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png"
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "image/jpeg"
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

// looksBinary returns true if the buffer contains a NUL byte in its first 8 KiB.
func looksBinary(b []byte) bool {
	n := len(b)
	if n > 8192 {
		n = 8192
	}
	for i := 0; i < n; i++ {
		if b[i] == 0 {
			return true
		}
	}
	return false
}
