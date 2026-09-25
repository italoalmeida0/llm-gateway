package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectDir(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "b.go"), []byte("package x\n"), 0o644)
	tool := &InspectTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": ".",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "a.txt") || !strings.Contains(got, "3 lines") {
		t.Fatalf("expected file + line count, got:\n%s", got)
	}
	if !strings.Contains(got, "sub/") {
		t.Fatalf("expected subdir, got:\n%s", got)
	}
}

func TestInspectNestedFiltersAndUnicodeGitStatus(t *testing.T) {
	dir := t.TempDir()
	if _, err := runGit(dir, "init"); err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"src/deep", "src/generated/nested"} {
		if err := os.MkdirAll(filepath.Join(dir, filepath.FromSlash(sub)), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(sub), "ação arquivo.ts"), []byte("text"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Stage files so porcelain reports individual Unicode paths, not a directory.
	if _, err := runGit(dir, "add", "."); err != nil {
		t.Fatal(err)
	}
	tool := &InspectTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"depth": 5, "include": []string{"src/**/*.ts"}, "exclude": []string{"src/generated/**"},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "(1 entries)") || !strings.Contains(got, "[A] ação arquivo.ts") || strings.Contains(got, "generated") {
		t.Fatalf("filters or raw Git filenames lost: %s", got)
	}
}

func TestInspectSingleFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte("a\nb\n"), 0o644)
	tool := &InspectTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"path": "f.txt",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "2 lines") {
		t.Fatalf("expected line count, got %q", got)
	}
}

func TestInspectHiddenAndDepth(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".hidden"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(dir, "a", "b"), 0o755)
	os.WriteFile(filepath.Join(dir, "a", "b", "deep.txt"), []byte("x"), 0o644)
	tool := &InspectTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, _ := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "."}), nil)
	if got := toolResultText(t, res); strings.Contains(got, ".hidden") {
		t.Fatalf("hidden should be excluded by default, got:\n%s", got)
	}
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "showHidden": true}), nil)
	if got := toolResultText(t, res); !strings.Contains(got, ".hidden") {
		t.Fatalf("hidden should show with flag, got:\n%s", got)
	}
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "depth": 1}), nil)
	if got := toolResultText(t, res); strings.Contains(got, "deep.txt") {
		t.Fatalf("depth 1 should hide deep.txt, got:\n%s", got)
	}
}

func TestInspectMtimeDirSizeType(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "UPPER.TXT"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "b.go"), []byte("0123456789"), 0o644)
	tool := &InspectTool{CWD: dir, Sandbox: NewSandbox(dir)}

	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": "."}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	// mtime on files and aggregated size on dirs.
	if !strings.Contains(got, "a.txt (8B, 2 lines, ") {
		t.Fatalf("expected mtime on file row, got:\n%s", got)
	}
	if !strings.Contains(got, "sub/ (10B, ") {
		t.Fatalf("expected aggregated dir size, got:\n%s", got)
	}
	// type=f hides dirs, type=d hides files.
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "type": "f"}), nil)
	if got := toolResultText(t, res); strings.Contains(got, "sub/") {
		t.Fatalf("type=f must hide dirs, got:\n%s", got)
	}
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "type": "d"}), nil)
	if got := toolResultText(t, res); strings.Contains(got, "a.txt") {
		t.Fatalf("type=d must hide files, got:\n%s", got)
	}
	// caseInsensitive include matches UPPER.TXT with lowercase pattern.
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "include": []string{"*.txt"}}), nil)
	if got := toolResultText(t, res); strings.Contains(got, "UPPER.TXT") {
		t.Fatalf("sensitive include should miss UPPER.TXT, got:\n%s", got)
	}
	res, _ = tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "include": []string{"*.txt"}, "caseInsensitive": true}), nil)
	if got := toolResultText(t, res); !strings.Contains(got, "UPPER.TXT") {
		t.Fatalf("insensitive include should find UPPER.TXT, got:\n%s", got)
	}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"path": ".", "type": "x"}), nil); err == nil {
		t.Fatal("expected error for invalid type")
	}
}
