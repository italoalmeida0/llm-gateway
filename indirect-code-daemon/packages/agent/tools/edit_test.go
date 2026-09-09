package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func editDisplay(t *testing.T, res core.ToolResult) string {
	t.Helper()
	d, ok := res.Details.(map[string]any)["display"].(string)
	if !ok {
		t.Fatalf("missing display in details: %#v", res.Details)
	}
	return d
}

// TestEditPreviewReturnsDiffWithoutWriting: Preview validates and diffs
// without writing; the AI-visible content is pi's one-line confirmation.
func TestEditPreviewReturnsDiffWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(p, []byte("hello world\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &EditTool{CWD: dir}
	args := mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "world", "newText": "gopher"}},
	})
	preview, err := tool.Preview(context.Background(), args)
	if err != nil {
		t.Fatal(err)
	}
	if got := preview.Content[0].(provider.TextBlock).Text; got != "Successfully replaced 1 block(s) in a.txt." {
		t.Fatalf("preview AI content = %q", got)
	}
	display := editDisplay(t, preview)
	for _, want := range []string{"APPLIED.", "-hello world", "+hello gopher"} {
		if !strings.Contains(display, want) {
			t.Fatalf("preview display missing %q:\n%s", want, display)
		}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hello world\n" {
		t.Fatalf("preview modified file: %q", b)
	}

	result, err := tool.Execute(context.Background(), args, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := editDisplay(t, result); got != display {
		t.Fatalf("executed display differs from preview:\npreview:\n%s\nresult:\n%s", display, got)
	}
}

func TestEditMultipleAgainstOriginal(t *testing.T) {
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

func TestEditAmbiguous(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("x\nx\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "x", "newText": "y"}},
	}), nil)
	if err == nil {
		t.Fatal("want ambiguous error")
	}
	want := "Found 2 occurrences of the text in a.txt. The text must be unique."
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("want pi duplicate error, got %q", err)
	}
}

func TestEditNotFoundPiError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "destination.txt")
	os.WriteFile(p, []byte("destination content\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "destination.txt",
		"edits": []map[string]any{{"oldText": "content from another file", "newText": "replacement"}},
	}), nil)
	if err == nil {
		t.Fatal("want oldText not found error")
	}
	want := "Could not find the exact text in destination.txt. The old text must match exactly including all whitespace and newlines."
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("want pi not-found error, got %q", err)
	}
}

func TestEditOverlapPiError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("alpha beta gamma\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "a.txt",
		"edits": []map[string]any{
			{"oldText": "alpha beta", "newText": "one"},
			{"oldText": "beta gamma", "newText": "two"},
		},
	}), nil)
	if err == nil {
		t.Fatal("want overlap error")
	}
	want := "edits[0] and edits[1] overlap in a.txt. Merge them into one edit or target disjoint regions."
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("want pi overlap error, got %q", err)
	}
}

func TestEditNoChangePiError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("same\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "same", "newText": "same"}},
	}), nil)
	if err == nil {
		t.Fatal("want no-change error")
	}
	want := "No changes made to a.txt. The replacement produced identical content."
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("want pi no-change error, got %q", err)
	}
}

func TestEditEmptyOldTextPiError(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("x\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "", "newText": "y"}},
	}), nil)
	if err == nil {
		t.Fatal("want empty oldText error")
	}
	if !strings.Contains(err.Error(), "oldText must not be empty in a.txt.") {
		t.Fatalf("want pi empty-oldText error, got %q", err)
	}
}

func TestEditFuzzyMatchTrailingWhitespace(t *testing.T) {
	// The model's oldText omits the trailing whitespace the file has.
	// pi's fuzzy match (per-line trailing-whitespace trim) must recover.
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte("func main() {\n\tfmt.Println(\"hi\")   \n}\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "f.txt",
		"edits": []map[string]any{{"oldText": "\tfmt.Println(\"hi\")", "newText": "\tfmt.Println(\"bye\")"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "func main() {\n\tfmt.Println(\"bye\")   \n}\n" {
		t.Fatalf("fuzzy match must preserve the file's trailing whitespace: %q", string(b))
	}
}

func TestEditFuzzyMatchSmartQuotes(t *testing.T) {
	// The model sends ASCII quotes; the file has smart quotes.
	dir := t.TempDir()
	p := filepath.Join(dir, "q.txt")
	os.WriteFile(p, []byte("msg := \"hello\"\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "q.txt",
		"edits": []map[string]any{{"oldText": "msg := \"hello\"", "newText": "msg := \"bye\""}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "msg := \"bye\"\n" {
		t.Fatalf("got %q", string(b))
	}
}

func TestEditPreservesCRLF(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	os.WriteFile(p, []byte("hello\r\nworld\r\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "a.txt",
		"edits": []map[string]any{{"oldText": "world", "newText": "gopher"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "hello\r\ngopher\r\n" {
		t.Fatalf("got %q", string(b))
	}
}

func TestEditPreservesBOM(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "bom.txt")
	os.WriteFile(p, []byte("\xEF\xBB\xBFhello\n"), 0o644)
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "bom.txt",
		"edits": []map[string]any{{"oldText": "hello", "newText": "world"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "\xEF\xBB\xBFworld\n" {
		t.Fatalf("BOM must be preserved: %q", string(b))
	}
}

func TestEditPrepareArgumentsNormalizations(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "n.txt")
	os.WriteFile(p, []byte("hello world\n"), 0o644)
	tool := &EditTool{CWD: dir}

	// edits sent as a JSON string (degenerate model input).
	os.WriteFile(p, []byte("hello world\n"), 0o644)
	editsJSON := `[{"oldText":"world","newText":"gopher"}]`
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "n.txt",
		"edits": editsJSON,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "hello gopher\n" {
		t.Fatalf("string-encoded edits failed: %q", string(b))
	}

	// edits sent as a single object instead of a one-element array.
	os.WriteFile(p, []byte("hello world\n"), 0o644)
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "n.txt",
		"edits": map[string]any{"oldText": "world", "newText": "gopher"},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p); string(b) != "hello gopher\n" {
		t.Fatalf("single-object edits failed: %q", string(b))
	}

	// Empty edits must fail with pi's validation message.
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "n.txt",
		"edits": []map[string]any{},
	}), nil)
	if err == nil || !strings.Contains(err.Error(), "Edit tool input is invalid. edits must contain at least one replacement.") {
		t.Fatalf("want pi validation error, got %v", err)
	}
}

func TestEditMissingFilePiError(t *testing.T) {
	dir := t.TempDir()
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path":  "nope.txt",
		"edits": []map[string]any{{"oldText": "a", "newText": "b"}},
	}), nil)
	if err == nil {
		t.Fatal("want missing file error")
	}
	if !strings.Contains(err.Error(), "Could not edit file: nope.txt.") {
		t.Fatalf("want pi access error, got %q", err)
	}
}
