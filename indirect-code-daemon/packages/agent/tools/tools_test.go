package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func toolDisplay(t *testing.T, res core.ToolResult) string {
	t.Helper()
	d, ok := res.Details.(map[string]any)["display"].(string)
	if !ok {
		t.Fatalf("missing display in details: %#v", res.Details)
	}
	return d
}

func TestReadText(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &ReadTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "a.txt"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	// pi style: raw content, no line prefixes, no notice.
	got := res.Content[0].(provider.TextBlock).Text
	if got != "hello\nworld\n" {
		t.Fatalf("want raw content, got %q", got)
	}
	// Frontend display keeps the line-prefixed view.
	display := toolDisplay(t, res)
	if !strings.HasPrefix(display, LinePrefixNotice) || !strings.Contains(display, "1:hello") {
		t.Fatalf("display lost rendering:\n%s", display)
	}
}

func TestReadImageMimeFromContentNotExtension(t *testing.T) {
	// A file named .png whose bytes are actually JPEG. The MIME must be
	// sniffed from the content (image/jpeg), not the extension.
	dir := t.TempDir()
	p := filepath.Join(dir, "shot.png")
	var encoded bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 30), G: uint8(y * 30), B: 100, A: 255})
		}
	}
	if err := jpeg.Encode(&encoded, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, encoded.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &ReadTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "shot.png"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Content[0].(provider.TextBlock).Text; got != "Read image file [image/jpeg]" {
		t.Fatalf("text note = %q", got)
	}
	imgBlock, ok := res.Content[1].(provider.ImageBlock)
	if !ok {
		t.Fatalf("expected ImageBlock, got %T", res.Content[1])
	}
	if imgBlock.MimeType != "image/jpeg" {
		t.Fatalf("mime from extension not corrected: got %s want image/jpeg", imgBlock.MimeType)
	}
}

func TestReadLargeImageResizesAndAddsPiHints(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "large.png")
	img := image.NewRGBA(image.Rect(0, 0, 3000, 1000))
	for y := 0; y < 1000; y += 25 {
		for x := 0; x < 3000; x += 25 {
			img.Set(x, y, color.RGBA{R: uint8(x / 12), G: uint8(y / 4), B: 90, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, encoded.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := (&ReadTool{CWD: dir}).Execute(context.Background(), mustJSON(t, map[string]any{"path": "large.png"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	text := res.Content[0].(provider.TextBlock).Text
	if !strings.Contains(text, "Read image file [image/png]") || !strings.Contains(text, "original 3000x1000, displayed at 2000x667") {
		t.Fatalf("missing pi resize hint: %q", text)
	}
	block, ok := res.Content[1].(provider.ImageBlock)
	if !ok {
		t.Fatalf("expected resized ImageBlock, got %T", res.Content[1])
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(block.Data))
	if err != nil {
		t.Fatal(err)
	}
	if format != "png" || cfg.Width != 2000 || cfg.Height != 667 {
		t.Fatalf("resized image = %s %dx%d, want png 2000x667", format, cfg.Width, cfg.Height)
	}
}

func TestReadOffsetLimit(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("1\n2\n3\n4\n5\n"), 0o644)
	tool := &ReadTool{CWD: dir}
	res, _ := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "a.txt", "offset": 2, "limit": 2}), nil)
	// pi style: raw lines plus the actionable continuation notice.
	got := res.Content[0].(provider.TextBlock).Text
	wantAI := "2\n3\n\n[2 more lines in file. Use offset=4 to continue.]"
	if got != wantAI {
		t.Fatalf("want %q, got %q", wantAI, got)
	}
	// Frontend display keeps the line-prefixed view.
	if display := toolDisplay(t, res); !strings.Contains(display, "2:2\n3:3\n") {
		t.Fatalf("display lost rendering:\n%s", display)
	}
	if start, ok := res.Details.(map[string]any)["start_line"]; !ok || start != 2 {
		t.Errorf("start_line detail want 2, got %v", start)
	}
}

func TestReadTruncationNotice(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "big.txt")
	var sb strings.Builder
	for i := 1; i <= 3000; i++ {
		sb.WriteString("line\n")
	}
	os.WriteFile(p, []byte(sb.String()), 0o644)
	tool := &ReadTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "big.txt"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := res.Content[0].(provider.TextBlock).Text
	// 3000 newline-terminated lines count as 3000 (no phantom extra line);
	// head keeps 2000.
	want := "[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]"
	if !strings.HasSuffix(got, want) {
		t.Fatalf("want notice suffix %q, got tail %q", want, got[len(got)-120:])
	}
	if strings.Contains(got, LinePrefixNotice) || strings.Contains(got, "1:line") {
		t.Fatalf("AI content must not carry line prefixes: %q", got[:40])
	}
}

func TestReadOffsetBeyondEOF(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("1\n2\n"), 0o644)
	tool := &ReadTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "a.txt", "offset": 99}), nil)
	if err == nil || !strings.Contains(err.Error(), "Offset 99 is beyond end of file (2 lines total)") {
		t.Fatalf("want pi offset error, got %v", err)
	}
}

func TestReadBinaryRejected(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "b.bin")
	os.WriteFile(p, []byte{0x00, 0x01, 0x02}, 0o644)
	tool := &ReadTool{CWD: dir}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "b.bin"}), nil); err == nil {
		t.Fatal("want binary rejection")
	}
}

func TestWriteCreatesDirs(t *testing.T) {
	dir := t.TempDir()
	tool := &WriteTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "sub/a.txt", "content": "hi"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "sub", "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hi" {
		t.Fatalf("got %q", string(b))
	}
	// pi style: one-line confirmation.
	if got := res.Content[0].(provider.TextBlock).Text; got != "Successfully wrote to sub/a.txt" {
		t.Fatalf("AI content = %q", got)
	}
}

func TestWriteDescriptionOmitsBrain(t *testing.T) {
	// The session memory space is advertised through the plan/build mode
	// instructions, never through the write tool description.
	want := "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories."
	for _, tool := range []*WriteTool{{CWD: t.TempDir()}, {CWD: t.TempDir(), BrainDir: t.TempDir()}} {
		if got := tool.Description(); got != want {
			t.Fatalf("Description() = %q; want base text only", got)
		}
	}
}

type countTracker struct{ writes, reads, edits int }

func (c *countTracker) NoteRead(absPath, content string)                   { c.reads++ }
func (c *countTracker) NoteWrite(absPath string, existed bool, old string) { c.writes++ }
func (c *countTracker) NoteEditBefore(absPath, beforeContent string)       { c.edits++ }
func (c *countTracker) NoteBinaryNew(absPath string)                       { c.writes++ }

func TestWriteBrainSkipsChangeTracking(t *testing.T) {
	dir := t.TempDir()
	brain := t.TempDir()
	tracker := &countTracker{}
	tool := &WriteTool{CWD: dir, BrainDir: brain, Changes: tracker}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": filepath.Join(brain, "s.txt"), "content": "x"}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "w.txt", "content": "y"}), nil); err != nil {
		t.Fatal(err)
	}
	if tracker.writes != 1 {
		t.Fatalf("tracked writes = %d; want 1 (brain write must be skipped)", tracker.writes)
	}
}

func TestReadEditBrainSkipChangeTracking(t *testing.T) {
	dir := t.TempDir()
	brain := t.TempDir()
	brainFile := filepath.Join(brain, "notes.md")
	if err := os.WriteFile(brainFile, []byte("hello brain\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	normalFile := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(normalFile, []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tracker := &countTracker{}
	readTool := &ReadTool{CWD: dir, BrainDir: brain, Changes: tracker}
	editTool := &EditTool{CWD: dir, BrainDir: brain, Changes: tracker}
	if _, err := readTool.Execute(context.Background(), mustJSON(t, map[string]any{"path": brainFile}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := editTool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  brainFile,
		"edits": []map[string]any{{"oldText": "brain", "newText": "memory"}},
	}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := readTool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "a.txt"}), nil); err != nil {
		t.Fatal(err)
	}
	if tracker.reads != 1 || tracker.edits != 0 {
		t.Fatalf("reads=%d edits=%d; want reads=1 edits=0 (brain read/edit must be skipped)", tracker.reads, tracker.edits)
	}
}

func TestEditSingle(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("hello world\n"), 0o644)
	tool := &EditTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "world", "newText": "gopher"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "hello gopher\n" {
		t.Fatalf("got %q", string(b))
	}
	if got := res.Content[0].(provider.TextBlock).Text; got != "Successfully replaced 1 block(s) in a.txt." {
		t.Fatalf("AI content = %q", got)
	}
}

func TestEditMultiple(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("a\nb\nc\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "a.txt",
		"edits": []map[string]any{
			{"oldText": "a", "newText": "A"},
			{"oldText": "c", "newText": "C"},
		},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "A\nb\nC\n" {
		t.Fatalf("got %q", string(b))
	}
}

func TestEditGuidance(t *testing.T) {
	desc := (&EditTool{}).Description()
	for _, want := range []string{"exact text replacement", "unique, non-overlapping region of the original file", "merge them into one edit"} {
		if !strings.Contains(desc, want) {
			t.Errorf("description missing %q: %q", want, desc)
		}
	}

	var schema map[string]any
	if err := json.Unmarshal((&EditTool{}).Schema(), &schema); err != nil {
		t.Fatal(err)
	}
	properties := schema["properties"].(map[string]any)
	edits := properties["edits"].(map[string]any)
	items := edits["items"].(map[string]any)
	editProperties := items["properties"].(map[string]any)
	oldText := editProperties["oldText"].(map[string]any)
	if got, _ := oldText["description"].(string); !strings.Contains(got, "must be unique in the original file") {
		t.Fatalf("oldText schema description missing pi guidance: %q", got)
	}
	// pi schema: only path and edits, nothing else.
	if len(properties) != 2 {
		t.Fatalf("edit schema must expose only path+edits (pi parity), got %d properties", len(properties))
	}
}

func TestResolveShell(t *testing.T) {
	notFound := errors.New("not found")
	tests := []struct {
		name     string
		goos     string
		binBash  bool
		pathBash string
		pathErr  error
		want     shellCommand
	}{
		{
			name: "prefers /bin/bash",
			goos: "linux", binBash: true, pathBash: "/usr/local/bin/bash",
			want: shellCommand{path: "/bin/bash", flag: "-c", isBash: true},
		},
		{
			name: "uses bash from PATH",
			goos: "linux", pathBash: "/usr/local/bin/bash",
			want: shellCommand{path: "/usr/local/bin/bash", flag: "-c", isBash: true},
		},
		{
			name: "falls back to POSIX sh",
			goos: "linux", pathErr: notFound,
			want: shellCommand{path: "/bin/sh", flag: "-c"},
		},
		{
			name: "uses Command Prompt on Windows",
			goos: "windows", binBash: true, pathBash: "/usr/local/bin/bash",
			want: shellCommand{path: "cmd", flag: "/C"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveShell(tt.goos, func(path string) bool {
				return path == "/bin/bash" && tt.binBash
			}, func(name string) (string, error) {
				if name != "bash" {
					t.Fatalf("unexpected PATH lookup for %q", name)
				}
				return tt.pathBash, tt.pathErr
			})
			if got != tt.want {
				t.Fatalf("resolveShell() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestBashSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": "echo hi"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	// pi style: raw merged output, no prompt echo, no [exit N] footer.
	got := res.Content[0].(provider.TextBlock).Text
	if got != "hi\n" && got != "hi" {
		t.Fatalf("got %q", got)
	}
	if res.IsError {
		t.Fatal("unexpected error flag")
	}
	// Frontend display keeps the terminal-log view.
	display := toolDisplay(t, res)
	for _, want := range []string{"$ echo hi", "hi", "[exit 0]", "Took"} {
		if !strings.Contains(display, want) {
			t.Fatalf("display missing %q:\n%s", want, display)
		}
	}
}

func TestBashSyntax(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash syntax is not used on Windows")
	}
	if !currentShell().isBash {
		t.Skip("bash is unavailable")
	}
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": `items=(one two); [[ ${#items[@]} -eq 2 ]] && printf 'bash syntax works\n'`,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := res.Content[0].(provider.TextBlock).Text
	if res.IsError || !strings.Contains(got, "bash syntax works") {
		t.Fatalf("got %q", got)
	}
}

func TestBashFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	tool := &BashTool{CWD: t.TempDir()}
	res, _ := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": "false"}), nil)
	if !res.IsError {
		t.Fatal("want error")
	}
	// pi style: output + status appended, no [exit N] footer.
	got := res.Content[0].(provider.TextBlock).Text
	if !strings.Contains(got, "Command exited with code 1") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "[exit 1]") {
		t.Fatalf("AI content must not carry the footer: %q", got)
	}
	// Frontend display keeps the footer.
	if display := toolDisplay(t, res); !strings.Contains(display, "[exit 1]") {
		t.Fatalf("display lost footer:\n%s", display)
	}
}

func TestBashTailTruncation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "seq 1 3000",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := res.Content[0].(provider.TextBlock).Text
	// pi style: keep the LAST 2000 lines and point at the full output file.
	if !strings.Contains(got, "1001") || strings.Contains(got, "\n1\n") {
		t.Fatalf("tail truncation must keep the last lines:\n%s", got[:80])
	}
	if !strings.Contains(got, "[Showing lines 1001-3000 of 3000. Full output: ") {
		t.Fatalf("want pi truncation notice, got:\n%s", got[len(got)-200:])
	}
	details := res.Details.(map[string]any)
	if fp, _ := details["full_output_path"].(string); fp == "" {
		t.Fatal("full output path missing")
	}
}

func TestBashTimeoutValidation(t *testing.T) {
	tool := &BashTool{CWD: t.TempDir()}
	zero := 0.0
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": "true", "timeout": zero}), nil); err == nil ||
		!strings.Contains(err.Error(), "Invalid timeout: must be a finite number of seconds") {
		t.Fatalf("want pi timeout error, got %v", err)
	}
	huge := 3000000.0
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": "true", "timeout": huge}), nil); err == nil ||
		!strings.Contains(err.Error(), "Invalid timeout: maximum is 2147483.647 seconds") {
		t.Fatalf("want pi max-timeout error, got %v", err)
	}
}

func TestBashTimeoutExpires(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "sleep 5",
		"timeout": 0.3,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError {
		t.Fatal("timeout must be an error result")
	}
	got := res.Content[0].(provider.TextBlock).Text
	if !strings.Contains(got, "Command timed out after 0.3 seconds") {
		t.Fatalf("want pi timeout message, got %q", got)
	}
}

func TestWriteLineNumbers(t *testing.T) {
	dir := t.TempDir()
	tool := &WriteTool{CWD: dir}
	content := "alpha\nbeta\ngamma\n"
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":    "file.txt",
		"content": content,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	// pi style: one-line confirmation only.
	got := res.Content[0].(provider.TextBlock).Text
	if got != "Successfully wrote to file.txt" {
		t.Fatalf("AI content = %q", got)
	}
	// Frontend display keeps the line-prefixed echo.
	wantDisplay := LinePrefixNotice + "1:alpha\n2:beta\n3:gamma\n"
	if display := toolDisplay(t, res); display != wantDisplay {
		t.Fatalf("display = %q", display)
	}
}

func TestEditLineNumbers(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "e.txt")
	os.WriteFile(p, []byte("line1\nline2\nline3\n"), 0o644)
	tool := &EditTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "e.txt",
		"edits": []map[string]any{{"oldText": "line2", "newText": "replaced"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	// pi style: one-line confirmation only.
	if got := res.Content[0].(provider.TextBlock).Text; got != "Successfully replaced 1 block(s) in e.txt." {
		t.Fatalf("AI content = %q", got)
	}
	// Frontend display keeps the numbered diff.
	display := toolDisplay(t, res)
	if !strings.HasPrefix(display, LinePrefixNotice) {
		t.Fatalf("expected LinePrefixNotice prefix, got %q", display)
	}
	if !strings.Contains(display, "2:-line2") || !strings.Contains(display, "2:+replaced") {
		t.Fatalf("expected 2:-line2 and 2:+replaced in display, got %q", display)
	}
}

func TestDumpToolsSchema(t *testing.T) {
	allTools := []core.Tool{
		&BashTool{},
		&EditTool{},
		&FetchURLTool{},
		&GlobTool{},
		&InspectTool{},
		&PythonTool{},
		&QuestionTool{},
		&ReadTool{},
		&SearchTool{},
		&SearchWebTool{},
		&TodoTool{},
		&WriteTool{},
	}

	sort.Slice(allTools, func(i, j int) bool {
		return allTools[i].Name() < allTools[j].Name()
	})

	type funcDef struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	}
	type oaiTool struct {
		Type     string  `json:"type"`
		Function funcDef `json:"function"`
	}
	type toolsPayload struct {
		Tools []oaiTool `json:"tools"`
	}

	var payload toolsPayload
	for _, tool := range allTools {
		payload.Tools = append(payload.Tools, oaiTool{
			Type: "function",
			Function: funcDef{
				Name:        tool.Name(),
				Description: tool.Description(),
				Parameters:  tool.Schema(),
			},
		})
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal tools schema: %v", err)
	}

	t.Logf("\n=== TOOLS SCHEMA JSON ===\n%s\n=== END TOOLS SCHEMA JSON ===", string(data))
}

func TestResolveTimeoutMsSeconds(t *testing.T) {
	// The timeout arg is documented in seconds; the resolved duration must
	// match. (Regression: the multiplier used time.Millisecond, so every
	// timeout fired 1000x too early.)
	for _, tc := range []struct {
		in   float64
		want time.Duration
	}{
		{2, 2 * time.Second},
		{0.5, 500 * time.Millisecond},
		{0.3, 300 * time.Millisecond},
		{120, 2 * time.Minute},
	} {
		got, err := resolveTimeoutMs(&tc.in)
		if err != nil {
			t.Fatalf("timeout %v: unexpected error: %v", tc.in, err)
		}
		if *got != tc.want {
			t.Errorf("timeout %v: got %v, want %v", tc.in, *got, tc.want)
		}
	}
	if got, err := resolveTimeoutMs(nil); err != nil || got != nil {
		t.Errorf("nil timeout: got %v, %v; want nil, nil", got, err)
	}
}

func TestReadPaginationTerminates(t *testing.T) {
	// Regression: the trailing newline used to count as a phantom line, so
	// the last suggested offset returned an empty page and the model looped.
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("1\n2\n3\n4\n5\n"), 0o644)
	tool := &ReadTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "a.txt", "offset": 4, "limit": 2,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	// Lines 4-5 are the whole tail: no continuation notice.
	if got := res.Content[0].(provider.TextBlock).Text; got != "4\n5\n" {
		t.Fatalf("tail page must be complete without notice, got %q", got)
	}
	// One past the end errors instead of returning an empty page.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "a.txt", "offset": 6,
	}), nil); err == nil {
		t.Fatal("offset past EOF must error, not return an empty page")
	}
}

func TestReadNegativeLimit(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("1\n2\n"), 0o644)
	tool := &ReadTool{CWD: dir}
	// A negative limit used to return an empty body WITH a continuation
	// notice pointing back at offset=1 (pagination loop). Now it errors.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "a.txt", "limit": -3,
	}), nil); err == nil || !strings.Contains(err.Error(), "limit must be a positive number of lines") {
		t.Fatalf("want limit validation error, got %v", err)
	}
}

func TestReadLongLineDeliversHead(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "huge.txt")
	os.WriteFile(p, []byte(strings.Repeat("z", 60000)+"\nsecond\n"), 0o644)
	tool := &ReadTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "huge.txt"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := res.Content[0].(provider.TextBlock).Text
	// The model gets content (head of the line), not just a "use bash" note.
	if !strings.HasPrefix(got, strings.Repeat("z", 100)) {
		t.Fatalf("long line head not delivered, got %q...", got[:80])
	}
	if !strings.Contains(got, "[Line 1 is 58.6KB; showing the first 50.0KB.") {
		t.Fatalf("missing partial-line notice, got tail %q", got[len(got)-160:])
	}
}

func TestBashTimeoutIsSeconds(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	// End-to-end regression: `sleep 1` with timeout 30 must succeed. Before
	// the seconds fix, 30 was interpreted as 30ms and this timed out.
	tool := &BashTool{CWD: t.TempDir()}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"command": "sleep 1",
		"timeout": 30,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("sleep 1 with timeout 30 must succeed, got: %q",
			res.Content[0].(provider.TextBlock).Text)
	}
}
