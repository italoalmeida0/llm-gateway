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
	"strconv"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// BashTool runs a shell command in the agent's cwd, mirroring pi's bash tool:
// {command, timeout?} with no default timeout, merged stdout+stderr, and
// tail truncation (keep the LAST 2000 lines / 50KB) with the full output
// saved to a temp file. Runs synchronously in the turn — no background mode.
type BashTool struct {
	CWD     string
	Sandbox *Sandbox
}

type bashArgs struct {
	Command string `json:"command"`
	// Timeout is optional and has no default (pi semantics). nil = no timeout.
	Timeout *float64 `json:"timeout,omitempty"`
}

const bashSchema = `{"type":"object","properties":{"command":{"type":"string","description":"Shell command to execute"},"timeout":{"type":"number","description":"Timeout in seconds (optional, no default timeout)"}},"required":["command"]}`

const (
	maxTimeoutMs      = 2147483647
	maxTimeoutSeconds = 2147483.647
)

func (t *BashTool) Name() string { return "bash" }
func (t *BashTool) Description() string {
	// Mirrors pi's bash tool description.
	return "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds."
}
func (t *BashTool) Schema() json.RawMessage { return json.RawMessage(bashSchema) }

// resolveTimeoutMs mirrors pi's resolveTimeoutMs.
func resolveTimeoutMs(timeout *float64) (*time.Duration, error) {
	if timeout == nil {
		return nil, nil
	}
	v := *timeout
	// JSON numbers are always finite in Go; guard the degenerate cases anyway.
	if v <= 0 || v != v || v > 1e308 {
		return nil, fmt.Errorf("Invalid timeout: must be a finite number of seconds")
	}
	if v*1000 > maxTimeoutMs {
		return nil, fmt.Errorf("Invalid timeout: maximum is %s seconds", strconv.FormatFloat(maxTimeoutSeconds, 'f', -1, 64))
	}
	timeoutDur := time.Duration(v * float64(time.Second))
	return &timeoutDur, nil
}

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
	timeoutMs, err := resolveTimeoutMs(a.Timeout)
	if err != nil {
		return core.ToolResult{}, err
	}

	cwd := t.CWD
	if cwd == "" {
		cwd, _ = os.Getwd()
	}

	runCtx := ctx
	var cancel context.CancelFunc
	if timeoutMs != nil {
		runCtx, cancel = context.WithTimeout(ctx, *timeoutMs)
		defer cancel()
	}

	start := time.Now()
	cmd := newShellCmd(runCtx, a.Command)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	setProcessGroup(cmd)

	// Merged stdout+stderr through one pipe, like pi.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		return core.ToolResult{}, fmt.Errorf("start: %w", err)
	}

	output := newOutputAccumulator(defaultMaxLines, defaultMaxBytes)
	// Head buffer for the frontend's terminal-log display.
	var head bytes.Buffer
	done := make(chan struct{})

	// Watch for context cancellation and kill the entire process
	// group immediately. exec.CommandContext only kills the direct
	// process, but child processes (e.g. grep spawned by the shell)
	// keep the output pipe open and block cmd.Wait() indefinitely.
	go func() {
		select {
		case <-runCtx.Done():
			killProcessGroup(cmd)
			pw.Close()
		case <-done:
		}
	}()
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
				if progress != nil {
					progress(string(chunk))
				}
			}
			if err != nil {
				return
			}
		}
	}()

	waitErr := cmd.Wait()
	pw.Close()
	<-done

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
	// Timeout and abort mirror pi's error messages.
	switch {
	case ctx.Err() != nil:
		isErr = true
		outputText = appendStatus(outputText, "Command aborted")
	case runCtx.Err() != nil && timeoutMs != nil:
		isErr = true
		outputText = appendStatus(outputText, fmt.Sprintf("Command timed out after %s seconds",
			strconv.FormatFloat(*a.Timeout, 'f', -1, 64)))
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

// humanDuration renders a duration in the "Took X.Ys" style used by
// the shell-log display.
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
		return fmt.Sprintf("%dm%ds", m, s)
	default:
		h := int(d.Hours())
		m := int(d.Minutes()) - h*60
		return fmt.Sprintf("%dh%dm", h, m)
	}
}

// ---------------------------------------------------------------------------
// outputAccumulator: port of pi's OutputAccumulator
// ---------------------------------------------------------------------------

// outputAccumulator keeps a bounded rolling tail in memory plus the running
// line/byte counters, and streams the complete output to a temp file once the
// truncation thresholds are exceeded (so "Full output: <path>" really is full).
type outputAccumulator struct {
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

// getLastLineBytes mirrors pi's getLastLineBytes: byte length of the last
// (possibly still open) line.
func (a *outputAccumulator) getLastLineBytes() int {
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
