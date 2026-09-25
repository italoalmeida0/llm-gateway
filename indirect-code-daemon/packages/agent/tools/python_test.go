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

func TestPythonAvailableFindsInterpreter(t *testing.T) {
	bin, err := PythonAvailable()
	if err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	if bin == "" {
		t.Fatal("expected non-empty binary path")
	}
	// Cached second call returns the same result.
	bin2, err2 := PythonAvailable()
	if err2 != nil || bin2 != bin {
		t.Fatalf("cached call mismatch: %q / %v", bin2, err2)
	}
}

func TestPythonCodeExecution(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "print('hello ' + 'world')",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "hello world") {
		t.Fatalf("expected output, got %q", got)
	}
	if !strings.Contains(got, "[exit 0]") {
		t.Fatalf("expected exit marker, got %q", got)
	}
}

func TestPythonStdinAndExitCode(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code":  "import sys; print('got:' + sys.stdin.read().strip())",
		"stdin": "ping",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "got:ping") {
		t.Fatalf("stdin not piped, got %q", got)
	}

	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "import sys; sys.exit(3)",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "[exit 3]") {
		t.Fatalf("expected exit 3 marker, got %q", got)
	}
}

func TestPythonScriptMode(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "hello.py")
	if err := os.WriteFile(script, []byte("import sys; print('args:' + ','.join(sys.argv[1:]))\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"script": "hello.py",
		"args":   []string{"a", "b"},
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "args:a,b") {
		t.Fatalf("expected script args, got %q", got)
	}
}

func TestPythonValidation(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	for name, args := range map[string]any{
		"empty":   map[string]any{},
		"both":    map[string]any{"code": "x", "script": "y.py"},
		"missing": map[string]any{"script": "nope.py"},
		"notpy":   map[string]any{"script": "notes.txt"},
	} {
		if _, err := tool.Execute(context.Background(), mustJSON(t, args), nil); err == nil {
			t.Fatalf("%s: expected validation error", name)
		}
	}
}

func TestPythonSandboxJail(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	sb := NewSandbox(dir)
	sb.Lock()
	tool := &PythonTool{CWD: dir, Sandbox: sb}
	// Script outside the jail must be rejected.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"script": "../escape.py",
	}), nil); err == nil {
		t.Fatal("expected jail rejection for ../escape.py")
	}
	// Workdir outside the jail must be rejected.
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code":    "print(1)",
		"workdir": "..",
	}), nil); err == nil {
		t.Fatal("expected jail rejection for workdir ..")
	}
}

// There is deliberately no timeout parameter: a run that would previously
// have been cut off now runs to completion (or detaches, with a hook).
func TestPythonNoTimeout(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	dir := t.TempDir()
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "import time; time.sleep(1); print('done')",
	}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "done") || !strings.Contains(got, "[exit 0]") {
		t.Fatalf("expected normal completion, got %q", got)
	}
}

func toolResultText(t *testing.T, res core.ToolResult) string {
	t.Helper()
	if len(res.Content) == 0 {
		t.Fatal("expected content in tool result")
	}
	tb, ok := res.Content[0].(provider.TextBlock)
	if !ok {
		t.Fatalf("expected TextBlock, got %T", res.Content[0])
	}
	return tb.Text
}

func TestPythonUnicodeIO(t *testing.T) {
	if _, err := PythonAvailable(); err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal(err)
		}
		t.Skip(err)
	}
	dir := filepath.Join(t.TempDir(), "workspace ação")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// Force a non-UTF-8 host locale on Unix too. Windows stdio uses its
	// legacy code page when redirected unless explicitly configured.
	t.Setenv("LANG", "C")
	t.Setenv("LC_ALL", "C")
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	code := "import sys, pathlib\ns = sys.stdin.read()\np = pathlib.Path('ação.txt')\np.write_text(s)\nprint(p.read_text())\nprint(s, file=sys.stderr)\nassert sys.flags.utf8_mode == 1\n"
	for _, scriptMode := range []bool{false, true} {
		args := map[string]any{"code": code, "stdin": "ação 日本語 🚀"}
		if scriptMode {
			if err := os.WriteFile(filepath.Join(dir, "ação.py"), []byte(code), 0600); err != nil {
				t.Fatal(err)
			}
			delete(args, "code")
			args["script"] = "ação.py"
		}
		res, err := tool.Execute(context.Background(), mustJSON(t, args), nil)
		if err != nil {
			t.Fatal(err)
		}
		got := toolResultText(t, res)
		if strings.Count(got, "ação 日本語 🚀") != 2 || !strings.Contains(got, "[exit 0]") {
			t.Fatalf("Unicode stdin/file/stdout/stderr roundtrip: %s", got)
		}
	}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{
		"code": "import sys; print(sys.stdout.encoding)", "env": map[string]string{"PYTHONIOENCODING": "ascii"},
	}), nil)
	if err != nil || !strings.Contains(toolResultText(t, res), "ascii") {
		t.Fatal("explicit encoding override lost")
	}
}
