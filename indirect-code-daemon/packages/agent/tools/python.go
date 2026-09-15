package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
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
	// Env adds extra environment variables (SANDBOX-safe keys only).
	Env map[string]string `json:"env,omitempty"`
	// Workdir overrides the run directory (jailed to CWD when sandboxed).
	Workdir string `json:"workdir,omitempty"`
}

// PythonTool executes Python 3 code or scripts. Like BashTool it is a
// command-execution tool: the frontend renders it as a terminal card, it
// participates in approval review, and the sandbox permission prompt covers
// it. Disabled entirely when no Python 3 binary exists on the host. There
// is deliberately NO timeout parameter: like bash, a run still going after
// AutoBackgroundAfter detaches into a background job.
type PythonTool struct {
	CWD     string
	Sandbox *Sandbox
	// Slow detaches long-running executions into a background job. Nil =
	// legacy behavior (block until the script ends).
	Slow SlowHook
}

func (t *PythonTool) Name() string { return "python" }

func (t *PythonTool) Description() string {
	return "Run Python 3 code (`code`) or a workspace script (`script` + `args`), with optional `stdin`, `env` and `workdir`. " +
		"Use for data analysis, quick calculations, file transforms, or running project scripts. " +
		"Stdout/stderr are captured separately; a non-zero exit is reported with the exit code. " +
		"There is no timeout: if the execution still runs after 10 seconds it automatically moves to the background (its output streams to a .log file, you are notified, and its result is delivered when it finishes — wait with the sleep tool, stop it with bg_cancel). " +
		"Only available when a Python 3 interpreter exists on this machine."
}

const pythonSchema = `{"type":"object","properties":{"code":{"type":"string","description":"Python snippet to run as python3 -c <code>. Mutually exclusive with script."},"script":{"type":"string","description":"Workspace-relative path to a .py file to run."},"args":{"type":"array","items":{"type":"string"},"description":"Arguments appended after the script path."},"stdin":{"type":"string","description":"Text piped to the process stdin."},"env":{"type":"object","additionalProperties":{"type":"string"},"description":"Extra environment variables."},"workdir":{"type":"string","description":"Run directory (defaults to session CWD; jailed when sandboxed)."}}}`

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
		// The background job label is the raw code: the daemon keeps
		// the first 300 chars (+ …), the frontend strips newlines and
		// highlights it like the Ran command label.
		label = code
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
		// Script mode: the label is the invocation (script + args).
		label = strings.TrimSpace(script + " " + strings.Join(a.Args, " "))
		if rel, err := filepath.Rel(t.CWD, abs); err == nil {
			label = strings.TrimSpace(rel + " " + strings.Join(a.Args, " "))
		}
	}

	// Detach the process lifetime from the turn: once the execution
	// outlives AutoBackgroundAfter it becomes a background job and the
	// turn ending must not kill it — only an explicit stop does. The
	// process binds to bgCtx, which is owned by the job after the detach
	// (bg_cancel); there is deliberately NO defer bgCancel(): Execute
	// returns the placeholder long before the script ends, and cancelling
	// here would kill every detached run the moment the tool call returns.
	bgCtx, bgCancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(bgCtx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = pythonEnv(a.Env)
	if a.Stdin != "" {
		cmd.Stdin = strings.NewReader(a.Stdin)
	}
	var stdout, stderr bytes.Buffer
	// Cap captured output at ~256KB per stream; the model gets the head,
	// the full text stays in the session transcript via the journal.
	// A fan-out sits in front of every sink: at detach time the job .log
	// file and the live stream forwarder are attached WITHOUT touching
	// exec's wiring (which captures cmd.Stdout once at Start — reassigning
	// it later would silently keep writing to the old buffers only).
	outFan, errFan := &fanOutWriter{}, &fanOutWriter{}
	outFan.Add(&cappedWriter{W: &stdout, Max: 256 * 1024})
	errFan.Add(&cappedWriter{W: &stderr, Max: 256 * 1024})
	cmd.Stdout = outFan
	cmd.Stderr = errFan

	start := time.Now()
	type pyOutcome struct {
		runErr error
	}
	doneCh := make(chan pyOutcome, 1)
	go func() {
		doneCh <- pyOutcome{runErr: cmd.Run()}
	}()
	select {
	case out := <-doneCh:
		bgCancel()
		return finishPythonCommand(out.runErr, stdout, stderr, start, progress)
	case <-ctx.Done():
		// Turn cancelled before the threshold: kill and keep legacy shape.
		bgCancel()
		out := <-doneCh
		return finishPythonCommand(out.runErr, stdout, stderr, start, progress)
	case <-time.After(AutoBackgroundAfter):
	}
	if t.Slow == nil {
		out := <-doneCh
		bgCancel()
		return finishPythonCommand(out.runErr, stdout, stderr, start, progress)
	}
	// The daemon hands us the job's .log file (in the session's brain
	// scratch space): from now on ALL output appends into it AND streams
	// live to the frontend row, so the model can also tail the file with
	// its own tools and the full output survives the delivery. The
	// in-memory buffers keep feeding the final result.
	jobID, logPath, stream, deliver := t.Slow("python", label, bgCancel)
	var logFile *os.File
	if logPath != "" {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			// Flush under the fan-out lock: the process copy goroutine
			// may be writing into these buffers right now.
			outFan.WithLock(func() {
				if stdout.Len() > 0 {
					_, _ = f.Write(stdout.Bytes())
				}
			})
			errFan.WithLock(func() {
				if stderr.Len() > 0 {
					_, _ = f.Write(stderr.Bytes())
				}
			})
			outFan.Add(f)
			errFan.Add(f)
			logFile = f
		}
	}
	if stream != nil {
		outFan.Add(streamFuncWriter{fn: stream})
		errFan.Add(streamFuncWriter{fn: stream})
	}
	go func() {
		out := <-doneCh
		if logFile != nil {
			_ = logFile.Close()
		}
		res, _ := finishPythonCommand(out.runErr, stdout, stderr, start, nil)
		text := ""
		for _, c := range res.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				text = tb.Text
			}
		}
		// Stamp the delivery so the frontend knows this result belongs to
		// a detached background job.
		if det, ok := res.Details.(map[string]any); ok {
			det["background_job_id"] = jobID
			det["log_path"] = logPath
			det["detached"] = true
		}
		deliver(text, res.IsError)
	}()
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: pythonBackgroundNotice(jobID, logPath, label)}},
		Details: map[string]any{"background_job_id": jobID, "log_path": logPath},
	}, nil
}

// pythonBackgroundNotice mirrors bashBackgroundNotice for detached python
// executions: where the output goes, how to force-stop it (bg_cancel) and
// the automatic wake-up with a completion notice when the script ends.
func pythonBackgroundNotice(jobID, logPath, label string) string {
	var b strings.Builder
	b.WriteString("Execution moved to background (still running).\n")
	if logPath != "" {
		fmt.Fprintf(&b, "All output (stdout+stderr) is being appended to: %s\n", logPath)
		b.WriteString("You can follow it with your read tool — but there is no need to poll: you are woken automatically when the execution finishes, and the .log file is kept.\n")
	} else {
		b.WriteString("Output is captured in memory and delivered when the execution finishes.\n")
	}
	fmt.Fprintf(&b, "To force-stop it early, call bg_cancel with job_id %q (task: %s).\n", jobID, ClipLabel(label))
	b.WriteString("You are woken automatically when the task finishes — its completion notice is delivered to you then (read the .log file for the output).\n")
	b.WriteString("While waiting, use your sleep tool (e.g. seconds: 120) — it ends early the moment this task finishes. Never wait with a terminal 'sleep N' command: that would itself detach into another background task and just add noise.")
	return b.String()
}

// fanOutWriter tees every write to a fixed set of sinks. Sinks can be
// added later (under lock): the job .log file and the live stream
// forwarder attach at detach time, while the process keeps writing into
// the same writer exec captured at Start.
type fanOutWriter struct {
	mu sync.Mutex
	ws []io.Writer
}

func (f *fanOutWriter) Add(w io.Writer) {
	if w == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ws = append(f.ws, w)
}

func (f *fanOutWriter) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, w := range f.ws {
		_, _ = w.Write(p)
	}
	return len(p), nil
}

// WithLock runs fn while no write is in flight (serializes against the
// process copy goroutine).
func (f *fanOutWriter) WithLock(fn func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn()
}

// streamFuncWriter forwards writes to a stream function (live output).
type streamFuncWriter struct {
	fn func(string)
}

func (s streamFuncWriter) Write(p []byte) (int, error) {
	if s.fn != nil && len(p) > 0 {
		s.fn(string(p))
	}
	return len(p), nil
}

func finishPythonCommand(runErr error, stdout, stderr bytes.Buffer, start time.Time, progress func(string)) (core.ToolResult, error) {
	_ = progress
	duration := time.Since(start)

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
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			text += fmt.Sprintf("\n[exit %d]", exitErr.ExitCode())
		} else {
			text += fmt.Sprintf("\n[error: %v]", runErr)
		}
	} else {
		text += "\n[exit 0]"
	}
	text += fmt.Sprintf("  Took %s", humanDuration(duration))

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
