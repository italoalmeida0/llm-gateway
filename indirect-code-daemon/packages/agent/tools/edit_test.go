package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditDryRunThenApply(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte("hello world\nsecond line\n"), 0o644)
	tool := &EditTool{CWD: dir, Sandbox: NewSandbox(dir)}

	// Dry run previews without writing (dryRun: true).
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"dryRun": true,
		"edits":  []map[string]any{{"file": "f.txt", "old": "world", "new": "there"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "DRY RUN") || !strings.Contains(got, "-hello world") || !strings.Contains(got, "+hello there") {
		t.Fatalf("expected dry-run diff, got:\n%s", got)
	}
	if data, _ := os.ReadFile(p); string(data) != "hello world\nsecond line\n" {
		t.Fatal("dry run must not write")
	}

	// Default dryRun is false: apply writes directly.
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"edits": []map[string]any{{"file": "f.txt", "old": "world", "new": "there"}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "APPLIED") {
		t.Fatalf("expected APPLIED, got:\n%s", got)
	}
	if data, _ := os.ReadFile(p); string(data) != "hello there\nsecond line\n" {
		t.Fatalf("file not edited: %q", data)
	}
}

func TestEditRegexReplaceAll(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte("a1 b2 a3\n"), 0o644)
	tool := &EditTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"dryRun": false,
		"edits":  []map[string]any{{"file": "f.txt", "old": "[a-z]\\d", "new": "X", "regex": true, "replaceAll": true}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "3 match") {
		t.Fatalf("expected 3 matches, got:\n%s", got)
	}
	if data, _ := os.ReadFile(p); string(data) != "X X X\n" {
		t.Fatalf("regex replaceAll failed: %q", data)
	}
}

func TestEditAnchorAndErrors(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "f.txt")
	os.WriteFile(p, []byte("line1\nline2\n"), 0o644)
	tool := &EditTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"dryRun": false,
		"edits":  []map[string]any{{"file": "f.txt", "old": "line1", "new": "inserted", "anchor": true}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = res
	if data, _ := os.ReadFile(p); string(data) != "line1\ninserted\nline2\n" {
		t.Fatalf("anchor insert failed: %q", data)
	}
	// Missing old errors cleanly.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"edits": []map[string]any{{"file": "f.txt", "old": "nope", "new": "x"}},
	}), nil); err == nil {
		t.Fatal("expected not-found error")
	}
}

func TestEditLineReplacement(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "code.txt")
	os.WriteFile(p, []byte("alpha\nbeta\ngamma\n"), 0o644)
	tool := &EditTool{CWD: dir, Sandbox: NewSandbox(dir)}

	// Replace line 2 with newContent
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"edits": []map[string]any{{
			"file":       "code.txt",
			"line":       2,
			"newContent": "BETA_MODIFIED",
		}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "2:-beta") || !strings.Contains(got, "2:+BETA_MODIFIED") {
		t.Fatalf("expected line 2 diff, got:\n%s", got)
	}
	data, _ := os.ReadFile(p)
	if string(data) != "alpha\nBETA_MODIFIED\ngamma\n" {
		t.Fatalf("unexpected content after line edit: %q", string(data))
	}

	// Range replace: lines 1 to 2
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "code.txt",
		"edits": []map[string]any{{
			"line":       1,
			"endLine":    2,
			"newContent": "FIRST_LINE",
		}},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(p)
	if string(data) != "FIRST_LINE\ngamma\n" {
		t.Fatalf("unexpected content after range edit: %q", string(data))
	}

	// Line out of range errors cleanly
	_, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "code.txt",
		"line": 99,
		"newContent": "foo",
	}), nil)
	if err == nil {
		t.Fatal("expected out of range error")
	}
}

