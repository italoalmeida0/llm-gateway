package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSearchAlwaysRegex(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.ts")
	os.WriteFile(p, []byte("const foo1 = 1;\nconst bar = 2;\n"), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	// Regex metacharacters work with no flag: pattern is always a regex.
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": `foo\d`,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "a.ts:1:") {
		t.Fatalf("expected regex hit with no flag, got:\n%s", got)
	}
	// A plain string is also a valid regex and matches literally.
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "const bar",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "a.ts:2:") {
		t.Fatalf("expected literal hit, got:\n%s", got)
	}
}

func TestSearchCountCapRetainsRows(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("hit hit\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	tool := &SearchTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"pattern": "hit", "count": true, "maxResults": 2}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "6 matches in 3 files") || !strings.Contains(got, "a.txt: 2 matches") || !strings.Contains(got, "b.txt: 2 matches") || strings.Contains(got, "c.txt:") {
		t.Fatalf("capped count discarded rows: %s", got)
	}
}

func TestSearchNestedGlobUnicodeAndFileLimit(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src", "deep", "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "src", "deep", "nested", "ação.ts")
	if err := os.WriteFile(path, []byte("hit"+strings.Repeat("x", 296)+"🚀\n"), 0600); err != nil {
		t.Fatal(err)
	}
	tool := &SearchTool{CWD: dir}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"pattern": "hit", "include": []string{"src/**/*.ts"}}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "src/deep/nested/ação.ts") || !utf8.ValidString(got) {
		t.Fatalf("glob/Unicode failure: %s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{"pattern": "hit", "path": path, "maxFileBytes": 10}), nil)
	if err != nil || !strings.Contains(toolResultText(t, res), "no matches") {
		t.Fatal("explicit file bypasses size limit")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tool.Execute(ctx, mustJSON(t, map[string]any{"pattern": "hit", "path": path}), nil); err != context.Canceled {
		t.Fatalf("cancelled search returned %v", err)
	}
}

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
		"pattern": "foo\\d", "include": []string{"*.ts"},
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
		"pattern": "([",
	}), nil); err == nil {
		t.Fatal("expected invalid regex error")
	}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{}), nil); err == nil {
		t.Fatal("expected missing pattern error")
	}
}

func TestSearchOnlyMatching(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("foo one foo two\nnothing\nfoo three foo four\n"), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "foo", "onlyMatching": true,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	// 4 matches (one entry per match, not per line).
	if !strings.HasPrefix(got, "4 matches") {
		t.Fatalf("expected 4 matches header, got:\n%s", got)
	}
	if !strings.Contains(got, "a.txt:1:1: foo") || !strings.Contains(got, "a.txt:1:9: foo") {
		t.Fatalf("expected per-match cols, got:\n%s", got)
	}
}

func TestSearchCount(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("foo foo\nfoo\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("nothing\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("foo\n"), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "foo", "count": true,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "4 matches in 2 files") {
		t.Fatalf("expected aggregate header, got:\n%s", got)
	}
	if !strings.Contains(got, "a.txt: 3 matches") || !strings.Contains(got, "c.txt: 1 match") {
		t.Fatalf("expected per-file counts, got:\n%s", got)
	}
	if strings.Contains(got, "b.txt") {
		t.Fatalf("b.txt has no match and must be absent, got:\n%s", got)
	}
}

func TestSearchFilesOnly(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("foo\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("nothing\n"), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "foo", "filesOnly": true,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "1 file") || !strings.Contains(got, "a.txt") {
		t.Fatalf("expected files-only listing, got:\n%s", got)
	}
	if strings.Contains(got, "b.txt") || strings.Contains(got, ":1:") {
		t.Fatalf("no line/col expected in filesOnly, got:\n%s", got)
	}
}

func TestSearchWideContext(t *testing.T) {
	dir := t.TempDir()
	var sb strings.Builder
	for i := 0; i < 15; i++ {
		sb.WriteString("filler line\n")
	}
	sb.WriteString("TARGET here\n")
	for i := 0; i < 15; i++ {
		sb.WriteString("filler line\n")
	}
	os.WriteFile(filepath.Join(dir, "f.txt"), []byte(sb.String()), 0o644)
	tool := &SearchTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"pattern": "TARGET", "contextLines": 10,
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	// 10 lines of context each side: lines 6..26 around line 16.
	if !strings.Contains(got, "6:filler") || !strings.Contains(got, "26:filler") {
		t.Fatalf("wide context missing, got:\n%s", got)
	}
}
