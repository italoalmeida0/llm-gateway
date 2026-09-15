package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// BashTool runs a shell command in the agent's cwd: {command} with merged
// stdout+stderr and tail truncation (keep the LAST 2000 lines / 50KB) with
// the full output saved to a temp file. There is deliberately NO timeout
// parameter: short commands return normally, and a command still running
// after AutoBackgroundAfter detaches into a background job (see Slow) —
// the result is delivered when the process finishes.
type BashTool struct {
	CWD     string
	Sandbox *Sandbox
	// Slow detaches long-running commands into a background job. Nil =
	// legacy behavior (block until the command ends).
	Slow SlowHook
}

type bashArgs struct {
	Command string `json:"command"`
}

const bashSchema = `{"type":"object","properties":{"command":{"type":"string","description":"Shell command to execute"}},"required":["command"]}`

func (t *BashTool) Name() string { return "bash" }
func (t *BashTool) Description() string {
	return "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. There is no timeout: if the command still runs after 10 seconds it automatically moves to the background (its output streams to a .log file, you are notified, and its result is delivered when it finishes — wait with the sleep tool, stop it with bg_cancel)."
}
func (t *BashTool) Schema() json.RawMessage { return json.RawMessage(bashSchema) }

func (t *BashTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a bashArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if strings.TrimSpace(a.Command) == "" {
		return core.ToolResult{}, fmt.Errorf("command is required")
	}
	if err := t.Sandbox.CheckCommand(a.Command); err != nil {
		return core.ToolResult{}, err
	}
	if err := t.Sandbox.CheckBashPermission(a.Command); err != nil {
		return core.ToolResult{}, err
	}
	cwd := t.CWD
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	start := time.Now()
	// The process lifetime must NOT ride the turn context: once the command
	// detaches into a background job, the turn ending must not kill it —
	// only an explicit stop does. The process hangs off its own context;
	// the watcher below bridges turn cancellation (pre-detach) and
	// bg_cancel (post-detach) onto it. There is deliberately NO defer
	// runCancel(): Execute returns the placeholder while the command is
	// still running, and cancelling here would kill every detached job
	// the moment the tool call returns. The context is released by
	// runCancel in the watcher/cancel paths once the process is done.
	runCtx, runCancel := context.WithCancel(context.Background())
	cmd := newShellCmd(runCtx, a.Command)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	setProcessGroup(cmd)

	// Merged stdout+stderr through one pipe, like pi.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		runCancel()
		return core.ToolResult{}, fmt.Errorf("start: %w", err)
	}

	output := newOutputAccumulator(defaultMaxLines, defaultMaxBytes)
	// Head buffer for the frontend's terminal-log display.
	var head bytes.Buffer
	done := make(chan struct{})
	// detached flips once the command outlives AutoBackgroundAfter: from
	// then on the turn-context watcher stands down (the background job owns
	// the process lifetime; only an explicit stop kills it).
	detached := make(chan struct{})
	// streamSink forwards post-detach output chunks to the background job
	// (live frontend row + .log file). Set before close(detached), so the
	// pump below reads it race-free (channel close is the happens-before).
	var streamSink func(string)

	// Watch for context cancellation and kill the entire process
	// group immediately. exec.CommandContext only kills the direct
	// process, but child processes (e.g. grep spawned by the shell)
	// keep the output pipe open and block cmd.Wait() indefinitely.
	go func() {
		select {
		case <-ctx.Done():
			select {
			case <-detached:
				// Background job: the turn ending must not kill it.
				<-done
			default:
				runCancel()
				killProcessGroup(cmd)
				pw.Close()
			}
		case <-runCtx.Done():
			// bg_cancel post-detach (or stop path): kill the group.
			select {
			case <-detached:
				<-done
			default:
				killProcessGroup(cmd)
				pw.Close()
			}
		case <-done:
		case <-detached:
			<-done
		}
	}()
	emit := func(chunk []byte) {
		select {
		case <-detached:
			if streamSink != nil {
				streamSink(string(chunk))
			}
		default:
			if progress != nil {
				progress(string(chunk))
			}
		}
	}
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				output.append(chunk)
				if head.Len() < defaultMaxBytes {
					room := defaultMaxBytes - head.Len()
					if n > room {
						head.Write(chunk[:room])
					} else {
						head.Write(chunk)
					}
				}
				emit(chunk)
			}
			if err != nil {
				return
			}
		}
	}()

	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	// Fast path: the command finished before the auto-background threshold.
	finishSync := func(waitErr error) (core.ToolResult, error) {
		runErr := runCtx.Err()
		runCancel()
		return finishBashCommand(a, cwd, start, output, &head, waitErr, ctx.Err(), runErr, progress)
	}
	select {
	case waitErr := <-waitCh:
		pw.Close()
		<-done
		return finishSync(waitErr)
	case <-ctx.Done():
		// Turn cancelled before the threshold: keep legacy behavior (the
		// watcher above kills the process group; Wait reports the kill).
		waitErr := <-waitCh
		pw.Close()
		<-done
		return finishSync(waitErr)
	case <-time.After(AutoBackgroundAfter):
	}
	if t.Slow == nil {
		// No background host (tests, offline use): keep blocking.
		waitErr := <-waitCh
		pw.Close()
		<-done
		return finishSync(waitErr)
	}
	// From here the job owns the process lifetime.
	jobID, logPath, stream, deliver := t.Slow("bash", a.Command, func() {
		runCancel()
		killProcessGroup(cmd)
		pw.Close()
	})
	if logPath != "" {
		output.redirectToFile(logPath)
	}
	streamSink = stream
	close(detached)
	go func() {
		waitErr := <-waitCh
		pw.Close()
		<-done
		runErr := runCtx.Err()
		runCancel()
		res, err := finishBashCommand(a, cwd, start, output, &head, waitErr, nil, runErr, nil)
		text := ""
		isErr := err != nil
		if err != nil {
			text = err.Error()
		} else {
			for _, c := range res.Content {
				if tb, ok := c.(provider.TextBlock); ok {
					text = tb.Text
				}
			}
			isErr = res.IsError
		}
		// Stamp the delivery so the frontend knows this terminal result
		// belongs to a detached background job (it renders the row as a
		// background run, not a plain synchronous result).
		if det, ok := res.Details.(map[string]any); ok {
			det["background_job_id"] = jobID
			det["log_path"] = logPath
			det["detached"] = true
		}
		deliver(text, isErr)
	}()
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: bashBackgroundNotice(jobID, logPath, a.Command)}},
		Details: map[string]any{"background_job_id": jobID, "log_path": logPath},
	}, nil
}

// bashBackgroundNotice is the placeholder the model sees when a command
// detaches: where the output goes (absolute .log path in the session's
// brain scratch space), how to force-stop it (bg_cancel) and that the
// daemon wakes the turn with a completion notice when the process ends.
func bashBackgroundNotice(jobID, logPath, cmd string) string {
	var b strings.Builder
	b.WriteString("Command moved to background (still running).\n")
	if logPath != "" {
		fmt.Fprintf(&b, "All output (stdout+stderr) is being appended to: %s\n", logPath)
		b.WriteString("You can follow it with your read tool — but there is no need to poll: you are woken automatically when the command finishes, and the .log file is kept.\n")
	} else {
		b.WriteString("Output is captured in memory and delivered when the command finishes.\n")
	}
	fmt.Fprintf(&b, "To force-stop it early, call bg_cancel with job_id %q (task: %s).\n", jobID, ClipLabel(cmd))
	b.WriteString("You are woken automatically when the task finishes — its completion notice is delivered to you then (read the .log file for the output).\n")
	b.WriteString("While waiting, use your sleep tool (e.g. seconds: 120) — it ends early the moment this task finishes. Never wait with a terminal 'sleep N' command: that would itself detach into another background task and just add noise.")
	return b.String()
}

func finishBashCommand(a bashArgs, cwd string, start time.Time, output *outputAccumulator, head *bytes.Buffer, waitErr error, ctxErr, runCtxErr error, progress func(string)) (core.ToolResult, error) {
	_ = progress
	exitCode := 0
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	elapsed := time.Since(start)

	snapshot := output.snapshot(true)
	output.closeTempFile()

	// pi's formatOutput: tail-truncated content plus an actionable notice
	// pointing at the temp file with the complete output.
	outputText := snapshot.content
	if outputText == "" {
		outputText = "(no output)"
	}
	if snapshot.truncated {
		startLine := snapshot.totalLines - snapshot.outputLines + 1
		endLine := snapshot.totalLines
		switch {
		case snapshot.lastLinePartial:
			outputText += fmt.Sprintf("\n\n[Showing last %s of line %d (line is %s). Full output: %s]",
				formatSize(snapshot.outputBytes), endLine, formatSize(output.getLastLineBytes()), snapshot.fullOutputPath)
		case snapshot.truncatedBy == "lines":
			outputText += fmt.Sprintf("\n\n[Showing lines %d-%d of %d. Full output: %s]",
				startLine, endLine, snapshot.totalLines, snapshot.fullOutputPath)
		default:
			outputText += fmt.Sprintf("\n\n[Showing lines %d-%d of %d (%s limit). Full output: %s]",
				startLine, endLine, snapshot.totalLines, formatSize(defaultMaxBytes), snapshot.fullOutputPath)
		}
	}

	appendStatus := func(text, status string) string {
		if text != "" {
			return text + "\n\n" + status
		}
		return status
	}

	isErr := false
	// Abort (turn cancelled pre-detach) and stop (bg_cancel / process
	// killed) mirror pi's error messages. There is no timeout: a detached
	// job that ends after any amount of time reports its real output.
	switch {
	case ctxErr != nil:
		isErr = true
		outputText = appendStatus(outputText, "Command aborted")
	case runCtxErr != nil:
		isErr = true
		outputText = appendStatus(outputText, "Command stopped")
	case exitCode != 0:
		isErr = true
		outputText = appendStatus(outputText, fmt.Sprintf("Command exited with code %d", exitCode))
	}

	// Frontend-only rendering: the terminal-log view ($ command,
	// output, [exit N] Took Xs) shown by the UI transcript.
	display := renderBashDisplay(a.Command, head.String(), exitCode, elapsed, snapshot.fullOutputPath)

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: outputText}},
		IsError: isErr,
		Details: map[string]any{
			"display":          display,
			"exitCode":         exitCode,
			"stdout":           head.String(),
			"stderr":           "",
			"truncated":        snapshot.truncated,
			"full_output_path": snapshot.fullOutputPath,
			"lines_truncated":  snapshot.truncated && snapshot.truncatedBy == "lines",
			"bytes_truncated":  snapshot.truncated && snapshot.truncatedBy == "bytes",
			"duration_ms":      elapsed.Milliseconds(),
			"workdir":          cwd,
			"steps":            1,
		},
	}, nil
}

// renderBashDisplay builds the terminal-log presentation for the UI:
// shell-prompt echo of the command, the captured output (head-truncated like
// before), and a footer with exit code and elapsed time.
func renderBashDisplay(command, captured string, exitCode int, elapsed time.Duration, fullPath string) string {
	lines := strings.Split(captured, "\n")
	truncLines := false
	if len(lines) > defaultMaxLines {
		lines = lines[:defaultMaxLines]
		truncLines = true
	}
	truncBytes := len(captured) >= defaultMaxBytes
	trimmed := strings.Join(lines, "\n")

	var sb strings.Builder
	fmt.Fprintf(&sb, "$ %s\n", command)
	if trimmed != "" {
		sb.WriteString("\n")
		sb.WriteString(trimmed)
		if !strings.HasSuffix(trimmed, "\n") {
			sb.WriteString("\n")
		}
	}
	if truncLines {
		fmt.Fprintf(&sb, "... [truncated at %d lines]\n", defaultMaxLines)
	}
	if truncBytes {
		fmt.Fprintf(&sb, "... [truncated at %d bytes]\n", defaultMaxBytes)
	}
	sb.WriteString("\n")
	fmt.Fprintf(&sb, "[exit %d]", exitCode)
	if fullPath != "" {
		fmt.Fprintf(&sb, " (full output: %s)", fullPath)
	}
	fmt.Fprintf(&sb, "  Took %s", humanDuration(elapsed))
	return sb.String()
}

// humanDuration renders a duration in the "Took Xh Ym Zs" style used by
// the shell-log display. Zero parts are omitted ("7s", "50m 10s",
// "2h 20m 2s"); sub-minute keeps one decimal for precision.
func humanDuration(d time.Duration) string {
	switch {
	case d < time.Millisecond:
		return "0.0s"
	case d < time.Minute:
		s := d.Seconds()
		return fmt.Sprintf("%.1fs", s)
	case d < time.Hour:
		m := int(d.Minutes())
		s := int(d.Seconds()) - m*60
		if s > 0 {
			return fmt.Sprintf("%dm %ds", m, s)
		}
		return fmt.Sprintf("%dm", m)
	default:
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		s := int(d.Seconds()) - h*3600 - m*60
		parts := fmt.Sprintf("%dh", h)
		if m > 0 {
			parts += fmt.Sprintf(" %dm", m)
		}
		if s > 0 {
			parts += fmt.Sprintf(" %ds", s)
		}
		return parts
	}
}

// ---------------------------------------------------------------------------
// outputAccumulator: port of pi's OutputAccumulator
// ---------------------------------------------------------------------------

// outputAccumulator keeps a bounded rolling tail in memory plus the running
// line/byte counters, and streams the complete output to a temp file once the
// truncation thresholds are exceeded (so "Full output: <path>" really is full).
type outputAccumulator struct {
	// mu guards every field below: the pump goroutine appends while the
	// tool goroutine may redirect/snapshot/close at detach and finish.
	mu       sync.Mutex
	maxLines int
	maxBytes int

	totalBytes    int
	totalLines    int // complete lines seen
	lastLineBytes int // bytes of the current (still open) line

	chunks   [][]byte // retained until the temp file opens
	tail     []byte   // rolling tail (last tailCap bytes)
	tailCap  int
	tempPath string
	tempFile *os.File
}

func newOutputAccumulator(maxLines, maxBytes int) *outputAccumulator {
	return &outputAccumulator{maxLines: maxLines, maxBytes: maxBytes, tailCap: 2 * maxBytes}
}

func (a *outputAccumulator) append(data []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.totalBytes += len(data)
	for _, b := range data {
		if b == '\n' {
			a.totalLines++
			a.lastLineBytes = 0
		} else {
			a.lastLineBytes++
		}
	}

	a.tail = append(a.tail, data...)
	if len(a.tail) > a.tailCap {
		copy(a.tail, a.tail[len(a.tail)-a.tailCap:])
		a.tail = a.tail[:a.tailCap]
	}

	if a.tempFile != nil {
		_, _ = a.tempFile.Write(data)
		return
	}
	if a.totalBytes > a.maxBytes || a.totalLines > a.maxLines {
		a.openTempFile()
		for _, c := range a.chunks {
			_, _ = a.tempFile.Write(c)
		}
		a.chunks = nil
		_, _ = a.tempFile.Write(data)
		return
	}
	a.chunks = append(a.chunks, append([]byte(nil), data...))
}

func (a *outputAccumulator) openTempFile() {
	f, err := os.CreateTemp("", "lgrc-bash-*.log")
	if err != nil {
		return
	}
	a.tempFile = f
	a.tempPath = f.Name()
}

// redirectToFile moves the accumulator's persistence from the anonymous
// temp file to the job's .log file (append mode) — called when the command
// detaches into a background job. Everything already captured is flushed
// first so the file starts with the command's earlier output; from then
// on every chunk lands in BOTH the in-memory tail (live terminal view)
// and the file (durable record the model can read).
func (a *outputAccumulator) redirectToFile(path string) {
	if path == "" {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	// Flush what the in-memory accumulator holds (chunks or tail) so the
	// log reflects the output produced before the detach.
	if a.tempFile != nil {
		_ = a.tempFile.Close()
		a.tempFile = nil
		a.tempPath = ""
	}
	if len(a.chunks) > 0 {
		_, _ = f.Write(bytes.Join(a.chunks, nil))
		a.chunks = nil
	} else if len(a.tail) > 0 {
		_, _ = f.Write(a.tail)
	}
	a.tempFile = f
	a.tempPath = path
}

// getLastLineBytes mirrors pi's getLastLineBytes: byte length of the last
// (possibly still open) line.
func (a *outputAccumulator) getLastLineBytes() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.lastLineBytes
}

type outputSnapshot struct {
	content         string
	truncated       bool
	truncatedBy     string
	totalLines      int
	totalBytes      int
	outputLines     int
	outputBytes     int
	lastLinePartial bool
	fullOutputPath  string
}

// snapshot mirrors pi's snapshot({persistIfTruncated}): tail-truncate the
// rolling tail, then overlay the true running totals.
func (a *outputAccumulator) snapshot(persistIfTruncated bool) outputSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	tailText := string(a.tail)
	tr := truncateTail(tailText, a.maxLines, a.maxBytes)
	truncated := a.totalLines > a.maxLines || a.totalBytes > a.maxBytes
	truncatedBy := ""
	if truncated {
		truncatedBy = tr.truncatedBy
		if truncatedBy == "" {
			if a.totalBytes > a.maxBytes {
				truncatedBy = "bytes"
			} else {
				truncatedBy = "lines"
			}
		}
	}
	if persistIfTruncated && truncated && a.tempFile == nil {
		// Thresholds were crossed without append seeing it (cannot happen in
		// practice, but keep the guarantee): open the file with what we have.
		a.openTempFile()
		for _, c := range a.chunks {
			_, _ = a.tempFile.Write(c)
		}
		a.chunks = nil
		_, _ = a.tempFile.Write(a.tail)
	}
	return outputSnapshot{
		content:         tr.content,
		truncated:       truncated,
		truncatedBy:     truncatedBy,
		totalLines:      a.totalLines,
		totalBytes:      a.totalBytes,
		outputLines:     tr.outputLines,
		outputBytes:     tr.outputBytes,
		lastLinePartial: tr.lastLinePartial,
		fullOutputPath:  a.tempPath,
	}
}

func (a *outputAccumulator) closeTempFile() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.tempFile != nil {
		_ = a.tempFile.Close()
		a.tempFile = nil
	}
}

type shellCommand struct {
	path   string
	flag   string
	isBash bool
}

func currentShell() shellCommand {
	return resolveShell(runtime.GOOS, isExecutableFile, exec.LookPath)
}

// ShellDescription reports the shell used to run commands (e.g.
// "/bin/bash -c", "cmd /C"). Surfaced in the system prompt so the model
// writes compatible commands on the first try.
func ShellDescription() string {
	s := currentShell()
	return s.path + " " + s.flag
}

func resolveShell(goos string, executable func(string) bool, lookPath func(string) (string, error)) shellCommand {
	if goos == "windows" {
		return shellCommand{path: "cmd", flag: "/C"}
	}
	if executable("/bin/bash") {
		return shellCommand{path: "/bin/bash", flag: "-c", isBash: true}
	}
	if path, err := lookPath("bash"); err == nil {
		return shellCommand{path: path, flag: "-c", isBash: true}
	}
	return shellCommand{path: "/bin/sh", flag: "-c"}
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	shell := currentShell()
	return exec.CommandContext(ctx, shell.path, shell.flag, command)
}
