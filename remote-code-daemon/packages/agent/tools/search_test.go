package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSearchLiteral(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.ts", "import { foo } from \"./foo\";\nconst x = 1;\n")
	write("sub/b.ts", "nothing here\nfoo bar\n")
	write("skip.min.js", "foo foo foo\n")
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "foo",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "a.ts:1:") || !strings.Contains(got, "b.ts:2:") {
		t.Fatalf("expected both hits, got:\n%s", got)
	}
	if !strings.HasPrefix(got, "3 matches") {
		t.Fatalf("expected 3 matches header, got:\n%s", got)
	}
}

func TestSearchRegexIncludeExclude(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.ts"), []byte("const foo1 = 1;\nconst bar = 2;\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.js"), []byte("const foo2 = 1;\n"), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "foo\\d", "isRegex": true, "include": []string{"*.ts"},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "a.ts") || strings.Contains(got, "b.js") {
		t.Fatalf("include filter failed, got:\n%s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "const", "exclude": []string{"*.ts"},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "b.js") || strings.Contains(got, "a.ts") {
		t.Fatalf("exclude filter failed, got:\n%s", got)
	}
}

func TestSearchContextAndCap(t *testing.T) {
	dir := t.TempDir()
	var sb strings.Builder
	for i := 0; i < 10; i++ {
		sb.WriteString("filler line\n")
	}
	sb.WriteString("TARGET here\n")
	for i := 0; i < 10; i++ {
		sb.WriteString("filler line\n")
	}
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte(sb.String()), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "TARGET", "contextLines": 1,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "f.txt:11:1: TARGET here") || !strings.Contains(got, "10:filler") {
		t.Fatalf("context lines missing, got:\n%s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "filler", "maxResults": 3,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.HasPrefix(got, "3 matches (capped at 3") {
		t.Fatalf("expected cap notice, got:\n%s", got)
	}
}

func TestSearchBadRegex(t *testing.T) {
	dir := t.TempDir()
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "([", "isRegex": true,
	}), nil); err == nil {
		t.Fatal("expected invalid regex error")
	}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{}), nil); err == nil {
		t.Fatal("expected missing pattern error")
	}
}
