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
