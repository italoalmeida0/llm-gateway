// Package tools implements the built-in tools: read, write, edit, bash, glob.
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

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// LinePrefixNotice is frontend-only. It is never included in the AI-visible
// read/write/edit content.
const LinePrefixNotice = "[Note: The line prefix \"<number>:\" is for line identification only and is not part of the file content.]\n"

type ReadTool struct {
	CWD     string
	Sandbox *Sandbox
	Changes ChangeTracker
}

type readArgs struct {
	Path   string `json:"path"`
	Offset int    `json:"offset,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

const readSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to read (relative or absolute)"},"offset":{"type":"integer","description":"Line number to start reading from (1-indexed)"},"limit":{"type":"integer","description":"Maximum number of lines to read"}},"required":["path"]}`

func (t *ReadTool) Name() string { return "read" }
func (t *ReadTool) Description() string {
	return "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete."
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
	shown := t.Sandbox.DisplayPath(path, a.Path)

	info, err := os.Stat(path)
	if err != nil {
		return core.ToolResult{}, err
	}
	if info.IsDir() {
		return core.ToolResult{}, fmt.Errorf("%s is a directory", shown)
	}

	// Image detection is based on magic bytes, not the file extension. Image
	// files deliberately bypass the text input cap because they are resized
	// before being put in the provider request.
	if mime := detectImageMIME(path); mime != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return core.ToolResult{}, err
		}
		if sniffed := sniffImageMIME(data); sniffed != "" {
			mime = sniffed
		}
		processed, processErr := processImage(data, mime)
		if processErr != nil {
			return core.ToolResult{Content: []provider.Content{
				provider.TextBlock{Text: fmt.Sprintf("Read image file [%s]\n%s", mime, processErr)},
			}}, nil
		}
		text := fmt.Sprintf("Read image file [%s]", processed.mimeType)
		if len(processed.hints) > 0 {
			text += "\n" + strings.Join(processed.hints, "\n")
		}
		return core.ToolResult{Content: []provider.Content{
			provider.TextBlock{Text: text},
			provider.ImageBlock{MimeType: processed.mimeType, Data: processed.data},
		}}, nil
	}

	// A media file is not currently representable by provider.Content in this
	// daemon (the provider contract has ImageBlock but no video/audio block).
	// Do not apply the text cap to it or pretend its bytes are source text.
	// Return a concise model-readable error instead of loading a huge binary.
	if media := mediaMIME(path); media != "" {
		return core.ToolResult{}, fmt.Errorf("%s is a %s media file; inline video/audio reading is not supported", a.Path, media)
	}

	data, err := readWholeFile(path)
	if err != nil {
		return core.ToolResult{}, err
	}
	if looksBinary(data) {
		return core.ToolResult{}, fmt.Errorf("%s looks binary; refusing to read as text", a.Path)
	}
	// Change tracking: first sighting of this path in the turn snapshots
	// the full content (not the offset/limit window).
	if t.Changes != nil {
		t.Changes.NoteRead(path, string(data))
	}

	textContent := string(data)
	allLines := strings.Split(textContent, "\n")
	totalFileLines := len(allLines)

	startLine := 0
	if a.Offset > 0 {
		startLine = a.Offset - 1
	}
	startLineDisplay := startLine + 1
	if startLine >= len(allLines) {
		return core.ToolResult{}, fmt.Errorf("Offset %d is beyond end of file (%d lines total)", a.Offset, totalFileLines)
	}

	var selectedContent string
	userLimitedLines := 0
	userLimited := false
	if a.Limit != 0 {
		endLine := startLine + a.Limit
		if endLine > len(allLines) {
			endLine = len(allLines)
		}
		if endLine < startLine {
			endLine = startLine
		}
		selectedContent = strings.Join(allLines[startLine:endLine], "\n")
		userLimitedLines = endLine - startLine
		userLimited = true
	} else {
		selectedContent = strings.Join(allLines[startLine:], "\n")
	}

	truncation := truncateHead(selectedContent, defaultMaxLines, defaultMaxBytes)
	var outputText string
	switch {
	case truncation.firstLineExceeds:
		firstLineSize := formatSize(len(allLines[startLine]))
		outputText = fmt.Sprintf("[Line %d is %s, exceeds %s limit. Use bash: sed -n '%dp' %s | head -c %d]",
			startLineDisplay, firstLineSize, formatSize(defaultMaxBytes), startLineDisplay, a.Path, defaultMaxBytes)
	case truncation.truncated:
		endLineDisplay := startLineDisplay + truncation.outputLines - 1
		nextOffset := endLineDisplay + 1
		outputText = truncation.content
		if truncation.truncatedBy == "lines" {
			outputText += fmt.Sprintf("\n\n[Showing lines %d-%d of %d. Use offset=%d to continue.]",
				startLineDisplay, endLineDisplay, totalFileLines, nextOffset)
		} else {
			outputText += fmt.Sprintf("\n\n[Showing lines %d-%d of %d (%s limit). Use offset=%d to continue.]",
				startLineDisplay, endLineDisplay, totalFileLines, formatSize(defaultMaxBytes), nextOffset)
		}
	case userLimited && startLine+userLimitedLines < len(allLines):
		remaining := len(allLines) - (startLine + userLimitedLines)
		nextOffset := startLine + userLimitedLines + 1
		outputText = fmt.Sprintf("%s\n\n[%d more lines in file. Use offset=%d to continue.]",
			truncation.content, remaining, nextOffset)
	default:
		outputText = truncation.content
	}

	display := t.renderDisplay(allLines, startLine, &truncation, userLimited, userLimitedLines)
	if progress != nil {
		progress(display)
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: outputText}},
		Details: map[string]any{
			"display":         display,
			"path":            path,
			"start_line":      startLine + 1,
			"lines_truncated": truncation.truncated && truncation.truncatedBy == "lines",
			"bytes_truncated": truncation.truncated && truncation.truncatedBy == "bytes",
			"total_lines":     totalFileLines,
			"totalLines":      totalFileLines,
		},
	}, nil
}

func (t *ReadTool) renderDisplay(allLines []string, startLine int, tr *truncationResult, userLimited bool, userLimitedLines int) string {
	end := len(allLines)
	if userLimited && startLine+userLimitedLines < end {
		end = startLine + userLimitedLines
	}
	selected := allLines[startLine:end]
	truncLines := tr.truncated && tr.truncatedBy == "lines"
	truncBytes := tr.truncated && tr.truncatedBy == "bytes"
	if truncLines && len(selected) > tr.outputLines {
		selected = selected[:tr.outputLines]
	}

	var sb strings.Builder
	sb.WriteString(LinePrefixNotice)
	for i, line := range selected {
		fmt.Fprintf(&sb, "%d:%s\n", startLine+i+1, line)
	}
	if truncLines || truncBytes {
		sb.WriteString("\n")
	}
	if truncLines {
		fmt.Fprintf(&sb, "... [truncated at %d lines]\n", defaultMaxLines)
	}
	if truncBytes {
		fmt.Fprintf(&sb, "... [truncated at %d bytes]\n", defaultMaxBytes)
	}
	return sb.String()
}

// The 100MB cap applies only to text input. The model still receives pi's
// 2000-line/50KB output window after this read succeeds.
const maxReadFileBytes = 100 << 20

func readWholeFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxReadFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxReadFileBytes {
		return nil, fmt.Errorf("file is larger than 100MB; use bash to inspect it in chunks")
	}
	return data, nil
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

// detectImageMIME reads enough bytes to identify image signatures. It never
// uses an extension fallback, so a mislabeled file cannot poison the provider
// request with the wrong MIME.
func detectImageMIME(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	prefix := make([]byte, 512)
	n, _ := f.Read(prefix)
	return sniffImageMIME(prefix[:n])
}

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
	case len(data) >= 2 && data[0] == 'B' && data[1] == 'M':
		return "image/bmp"
	}
	return ""
}

// mediaMIME identifies common audio/video files by extension. They are kept
// separate from images because provider.Content currently has no media block.
func mediaMIME(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv", ".flv":
		return "video/" + strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	case ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac":
		return "audio/" + strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	}
	return ""
}

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
