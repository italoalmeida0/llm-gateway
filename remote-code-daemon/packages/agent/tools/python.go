package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

// Python detection is resolved once per process and cached. The tool is only
// advertised when a binary was actually found (see PythonAvailable); sessions
// started on machines without Python never see the tool in the registry.
var (
	pythonOnce sync.Once
	pythonBin  string
	pythonErr  error
)

// findPythonBin locates a usable Python 3 interpreter, preferring python3
// over the bare python name (which may still be Python 2 on some systems).
// Each candidate is probed with `--version`; only candidates whose version
// output starts with "Python 3." are accepted.
func findPythonBin() (string, error) {
	candidates := []string{"python3", "python"}
	var tried []string
	for _, name := range candidates {
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		tried = append(tried, path)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		out, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
		cancel()
		if err != nil {
			continue
		}
		ver := strings.TrimSpace(string(out))
		// Some builds print to stderr ("Python 3.x.y"); CombinedOutput covers both.
		if strings.HasPrefix(ver, "Python 3.") {
			return path, nil
		}
	}
	if len(tried) == 0 {
		return "", fmt.Errorf("no python3 or python binary found in PATH")
	}
	return "", fmt.Errorf("no Python 3 interpreter found (tried: %s)", strings.Join(tried, ", "))
}

// PythonAvailable reports whether this machine can run the python tool.
// Result is cached after the first probe.
func PythonAvailable() (string, error) {
	pythonOnce.Do(func() {
		pythonBin, pythonErr = findPythonBin()
	})
	return pythonBin, pythonErr
}

type PythonArgs struct {
	// Code runs the snippet as `python3 -c <code>`. Mutually exclusive with Script.
	Code string `json:"code,omitempty"`
	// Script runs a workspace-relative .py file: `python3 <script> <args...>`.
	Script string `json:"script,omitempty"`
	// Args are appended after the script path (script mode only).
	Args []string `json:"args,omitempty"`
	// Stdin is piped to the process (both modes).
	Stdin string `json:"stdin,omitempty"`
	// TimeoutSec caps execution (default 30, max 120).
	TimeoutSec int `json:"timeoutSec,omitempty"`
	// Env adds extra environment variables (SANDBOX-safe keys only).
	Env map[string]string `json:"env,omitempty"`
	// Workdir overrides the run directory (jailed to CWD when sandboxed).
	Workdir string `json:"workdir,omitempty"`
}

// PythonTool executes Python 3 code or scripts. Like BashTool it is a
// command-execution tool: the frontend renders it as a terminal card, it
// participates in approval review, and the sandbox permission prompt covers
// it. Disabled entirely when no Python 3 binary exists on the host.
type PythonTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *PythonTool) Name() string { return "python" }

func (t *PythonTool) Description() string {
	return "Run Python 3 code (`code`) or a workspace script (`script` + `args`), with optional `stdin`, `timeoutSec` (default 30, max 120), `env` and `workdir`. " +
		"Use for data analysis, quick calculations, file transforms, or running project scripts. " +
		"Stdout/stderr are captured separately; a non-zero exit is reported with the exit code. " +
		"Only available when a Python 3 interpreter exists on this machine."
}

const pythonSchema = `{"type":"object","properties":{"code":{"type":"string","description":"Python snippet to run as python3 -c <code>. Mutually exclusive with script."},"script":{"type":"string","description":"Workspace-relative path to a .py file to run."},"args":{"type":"array","items":{"type":"string"},"description":"Arguments appended after the script path."},"stdin":{"type":"string","description":"Text piped to the process stdin."},"timeoutSec":{"type":"number","description":"Execution timeout in seconds (default 30, max 120)."},"env":{"type":"object","additionalProperties":{"type":"string"},"description":"Extra environment variables."},"workdir":{"type":"string","description":"Run directory (defaults to session CWD; jailed when sandboxed)."}}}`

func (t *PythonTool) Schema() json.RawMessage { return json.RawMessage(pythonSchema) }

func (t *PythonTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	bin, err := PythonAvailable()
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("python tool unavailable: %v", err)
	}
	var a PythonArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, err
	}
	code := strings.TrimSpace(a.Code)
	script := strings.TrimSpace(a.Script)
	if code == "" && script == "" {
		return core.ToolResult{}, fmt.Errorf("python: provide `code` or `script`")
	}
	if code != "" && script != "" {
		return core.ToolResult{}, fmt.Errorf("python: `code` and `script` are mutually exclusive")
	}

	timeout := a.TimeoutSec
	if timeout <= 0 {
		timeout = 30
	}
	if timeout > 120 {
		timeout = 120
	}

	// Resolve the working directory: session CWD by default, jailed when locked.
	dir := t.CWD
	if w := strings.TrimSpace(a.Workdir); w != "" {
		dir = resolvePath(t.CWD, w)
		if err := t.Sandbox.CheckPath(dir); err != nil {
			return core.ToolResult{}, fmt.Errorf("python: invalid workdir: %v", err)
		}
	}

	var argv []string
	label := ""
	if code != "" {
		if err := t.Sandbox.CheckCommand("python3 -c " + quoteForLog(code)); err != nil {
			return core.ToolResult{}, err
		}
		if err := t.Sandbox.CheckBashPermission("python3 -c " + code); err != nil {
			return core.ToolResult{}, err
		}
		argv = []string{bin, "-c", code}
		label = summarizeCode(code)
	} else {
		abs := resolvePath(t.CWD, script)
		if err := t.Sandbox.CheckPath(abs); err != nil {
			return core.ToolResult{}, fmt.Errorf("python: invalid script path: %v", err)
		}
		if !strings.HasSuffix(strings.ToLower(abs), ".py") {
			return core.ToolResult{}, fmt.Errorf("python: script must be a .py file")
		}
		if st, err := os.Stat(abs); err != nil || st.IsDir() {
			return core.ToolResult{}, fmt.Errorf("python: script not found: %s", script)
		}
		// Reuse the shell permission model: executing a file is at least as
		// sensitive as running its contents through bash.
		if err := t.Sandbox.CheckCommand("python3 " + script + " " + strings.Join(a.Args, " ")); err != nil {
			return core.ToolResult{}, err
		}
		if err := t.Sandbox.CheckBashPermission("python3 " + script); err != nil {
			return core.ToolResult{}, err
		}
		argv = append([]string{bin, abs}, a.Args...)
		if rel, err := filepath.Rel(t.CWD, abs); err == nil {
			label = rel
		} else {
			label = script
		}
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(timeoutCtx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = pythonEnv(a.Env)
	if a.Stdin != "" {
		cmd.Stdin = strings.NewReader(a.Stdin)
	}
	var stdout, stderr bytes.Buffer
	// Cap captured output at ~256KB per stream; the model gets the head,
	// the full text stays in the session transcript via the journal.
	cmd.Stdout = &cappedWriter{W: &stdout, Max: 256 * 1024}
	cmd.Stderr = &cappedWriter{W: &stderr, Max: 256 * 1024}

	start := time.Now()
	runErr := cmd.Run()
	duration := time.Since(start)
	_ = label

	out := strings.TrimRight(stdout.String(), "\n")
	errOut := strings.TrimRight(stderr.String(), "\n")
	var b strings.Builder
	if out != "" {
		b.WriteString(out)
	}
	if errOut != "" {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		if out != "" {
			b.WriteString("[stderr]\n")
		}
		b.WriteString(errOut)
	}
	text := b.String()
	if text == "" {
		text = "(no output)"
	}
	if timeoutCtx.Err() == context.DeadlineExceeded {
		text += fmt.Sprintf("\n[exit timeout after %ds]", timeout)
	} else if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			text += fmt.Sprintf("\n[exit %d]", exitErr.ExitCode())
		} else {
			text += fmt.Sprintf("\n[error: %v]", runErr)
		}
	} else {
		text += "\n[exit 0]"
	}
	text += fmt.Sprintf("  Took %s", humanDuration(duration))

	// The daemon streams tool_progress events from these results the same
	// way it does for bash (see progress plumbing in cmd/daemon/main.go).
	_ = progress
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: text}},
	}, nil
}

// quoteForLog truncates long snippets before they reach permission logs.
func quoteForLog(code string) string {
	const max = 200
	c := strings.ReplaceAll(code, "\n", " ")
	c = strings.Join(strings.Fields(c), " ")
	if len(c) > max {
		return c[:max] + "…"
	}
	return c
}

// summarizeCode picks a one-line label for frontend summaries.
func summarizeCode(code string) string {
	for _, line := range strings.Split(code, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		return quoteForLog(line)
	}
	return "snippet"
}

// pythonEnv builds a hardened environment: system PATH/HOME/LANG plus
// PYTHONDONTWRITEBYTECODE=1 (never litter __pycache__ in the workspace),
// PYTHONUNBUFFERED=1 (streaming-friendly), and user extras after validation.
func pythonEnv(extra map[string]string) []string {
	keep := []string{"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"}
	env := []string{"PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1"}
	for _, k := range keep {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	for k, v := range extra {
		if !validEnvKey(k) {
			continue
		}
		env = append(env, k+"="+v)
	}
	return env
}

func validEnvKey(k string) bool {
	if k == "" || len(k) > 64 {
		return false
	}
	if strings.HasPrefix(k, "PYTHON") && k != "PYTHONPATH" && k != "PYTHONIOENCODING" {
		// Block PYTHONHOME/PYTHONSAFEPATH-style escapes; allow the two benign ones.
		return false
	}
	for _, r := range k {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}

// cappedWriter bounds captured output so a runaway print loop cannot blow up
// the transcript or the model context.
type cappedWriter struct {
	W   *bytes.Buffer
	Max int
}

func (c *cappedWriter) Write(p []byte) (int, error) {
	remaining := c.Max - c.W.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	return c.W.Write(p)
}
