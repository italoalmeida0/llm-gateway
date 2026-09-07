package tools

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

const (
	maxBashLines = 2000
	maxBashBytes = 50 * 1024
)

// BashTool runs a shell command in the agent's cwd.
type BashTool struct {
	CWD     string
	Sandbox *Sandbox
}

type bashArgs struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
	// Workdir overrides the run directory (jailed to CWD when sandboxed).
	Workdir string `json:"workdir,omitempty"`
	// Env adds extra environment variables (SANDBOX-safe keys only).
	Env map[string]string `json:"env,omitempty"`
	// SeparateStreams captures stdout/stderr separately instead of merged.
	SeparateStreams bool `json:"separateStreams,omitempty"`
	// Commands runs steps sequentially with stopOnError (default true).
	Commands []string `json:"commands,omitempty"`
	// StopOnError stops the sequence at the first non-zero exit (default true).
	StopOnError *bool `json:"stopOnError,omitempty"`
}

const bashSchema = `{"type":"object","properties":{"command":{"type":"string","description":"Single shell command to run."},"timeout":{"type":"integer","description":"Timeout in seconds (default 120, max 600)."},"workdir":{"type":"string","description":"Run directory (defaults to session CWD; jailed when sandboxed)."},"env":{"type":"object","additionalProperties":{"type":"string"},"description":"Extra environment variables."},"separateStreams":{"type":"boolean","description":"Capture stdout/stderr separately with [stdout]/[stderr] sections."},"commands":{"type":"array","items":{"type":"string"},"description":"Run steps sequentially in one shell session context (same dir/env)."},"stopOnError":{"type":"boolean","description":"Stop the sequence at first non-zero exit (default true)."}},"required":["command"]}`

func (t *BashTool) Name() string            { return "bash" }
func (t *BashTool) Description() string     { return shellDescription(currentShell()) }
func (t *BashTool) Schema() json.RawMessage { return json.RawMessage(bashSchema) }

func (t *BashTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a bashArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if strings.TrimSpace(a.Command) == "" {
		return core.ToolResult{}, fmt.Errorf("command is required")
	}
	// Build the step list: single command, or sequential commands[] sharing
	// dir/env (stopOnError default true).
	steps := []string{a.Command}
	if len(a.Commands) > 0 {
		if len(a.Commands) > 20 {
			return core.ToolResult{}, fmt.Errorf("bash: max 20 commands per call")
		}
		steps = a.Commands
	}
	stopOnError := true
	if a.StopOnError != nil {
		stopOnError = *a.StopOnError
	}
	for _, step := range steps {
		if strings.TrimSpace(step) == "" {
			return core.ToolResult{}, fmt.Errorf("bash: empty command in sequence")
		}
		if err := t.Sandbox.CheckCommand(step); err != nil {
			return core.ToolResult{}, err
		}
		if err := t.Sandbox.CheckBashPermission(step); err != nil {
			return core.ToolResult{}, err
		}
	}
	cwd := t.CWD
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if w := strings.TrimSpace(a.Workdir); w != "" {
		cwd = resolvePath(cwd, w)
		if err := t.Sandbox.CheckPath(cwd); err != nil {
			return core.ToolResult{}, fmt.Errorf("bash: invalid workdir: %v", err)
		}
	}

	timeout := a.Timeout
	if timeout <= 0 {
		timeout = 120
	}
	if timeout > 600 {
		timeout = 600
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	start := time.Now()
	// Join steps with && (stop) or ; (continue) so one shell carries cwd/env.
	joiner := " && "
	if !stopOnError {
		joiner = " ; "
	}
	joined := strings.Join(steps, joiner)
	cmd := newShellCmd(runCtx, joined)
	cmd.Dir = cwd
	cmd.Env = bashEnv(a.Env)
	setProcessGroup(cmd)

	// Capture with line-by-line streaming. Default merges stdout+stderr
	// (classic terminal look); separateStreams keeps them apart so failures
	// are attributable (no more guessing which stream an error came from).
	pr, pw := io.Pipe()
	var prErr *io.PipeReader
	var pwErr *io.PipeWriter
	var capturedErr *bytes.Buffer
	var doneErr chan struct{}
	if a.SeparateStreams {
		epr, epw := io.Pipe()
		prErr, pwErr = epr, epw
		capturedErr = &bytes.Buffer{}
		doneErr = make(chan struct{})
		cmd.Stdout = pw
		cmd.Stderr = epw
	} else {
		cmd.Stdout = pw
		cmd.Stderr = pw
	}

	if err := cmd.Start(); err != nil {
		return core.ToolResult{}, fmt.Errorf("start: %w", err)
	}

	// Writer to both the buffer (trimmed) and progress callback.
	captured := &bytes.Buffer{}
	done := make(chan struct{})

	// Watch for context cancellation and kill the entire process
	// group immediately. exec.CommandContext only kills the direct
	// process, but child processes (e.g. grep spawned by the shell)
	// keep the output pipe open and block cmd.Wait() indefinitely.
	go func() {
		select {
		case <-runCtx.Done():
			killProcessGroup(cmd)
			// Close the write ends so reader goroutines unblock.
			pw.Close()
			if pwErr != nil {
				pwErr.Close()
			}
		case <-done:
		}
	}()
	if a.SeparateStreams {
		go func() {
			defer close(doneErr)
			buf := make([]byte, 4096)
			for {
				n, err := prErr.Read(buf)
				if n > 0 {
					chunk := buf[:n]
					if capturedErr.Len() < maxBashBytes {
						room := maxBashBytes - capturedErr.Len()
						if n > room {
							capturedErr.Write(chunk[:room])
						} else {
							capturedErr.Write(chunk)
						}
					}
				}
				if err != nil {
					return
				}
			}
		}()
	}
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				chunk := buf[:n]
				if captured.Len() < maxBashBytes {
					room := maxBashBytes - captured.Len()
					if n > room {
						captured.Write(chunk[:room])
					} else {
						captured.Write(chunk)
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
	if a.SeparateStreams {
		pwErr.Close()
		<-doneErr
	}

	output := captured.String()
	stderrOut := ""
	if a.SeparateStreams {
		stderrOut = capturedErr.String()
	}
	truncBytes := captured.Len() >= maxBashBytes
	lines := strings.Split(output, "\n")
	truncLines := false
	if len(lines) > maxBashLines {
		lines = lines[:maxBashLines]
		truncLines = true
	}
	trimmed := strings.Join(lines, "\n")

	exitCode := 0
	if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}

	elapsed := time.Since(start)

	// Terminal-log style: echo the command on the first line with
	// a shell-prompt prefix, a blank line, the captured output, and
	// a footer showing exit code + elapsed time. Matches the look
	// a human would see if they ran the command themselves, which
	// makes the model's reasoning about it more natural too.
	var sb strings.Builder
	fmt.Fprintf(&sb, "$ %s\n", joined)
	if cwd != t.CWD && t.CWD != "" {
		if rel, err := filepath.Rel(t.CWD, cwd); err == nil {
			fmt.Fprintf(&sb, "(in %s)\n", rel)
		}
	}
	if a.SeparateStreams {
		outTrim := strings.TrimRight(trimmed, "\n")
		errTrim := strings.TrimRight(stderrOut, "\n")
		if outTrim != "" {
			sb.WriteString("\n[stdout]\n")
			sb.WriteString(outTrim + "\n")
		}
		if errTrim != "" {
			sb.WriteString("\n[stderr]\n")
			sb.WriteString(errTrim + "\n")
		}
		if outTrim == "" && errTrim == "" {
			sb.WriteString("\n(no output)\n")
		}
	} else if trimmed != "" {
		sb.WriteString("\n")
		sb.WriteString(trimmed)
		if !strings.HasSuffix(trimmed, "\n") {
			sb.WriteString("\n")
		}
	}
	if truncLines {
		fmt.Fprintf(&sb, "... [truncated at %d lines]\n", maxBashLines)
	}
	if truncBytes {
		fmt.Fprintf(&sb, "... [truncated at %d bytes]\n", maxBashBytes)
	}
	sb.WriteString("\n")
	if exitCode == 0 {
		fmt.Fprintf(&sb, "[exit 0]")
	} else {
		fmt.Fprintf(&sb, "[exit %d]", exitCode)
	}

	var fullPath string
	if truncBytes || truncLines {
		fullPath = writeFullOutput(output)
		if fullPath != "" {
			fmt.Fprintf(&sb, " (full output: %s)", fullPath)
		}
	}
	fmt.Fprintf(&sb, "  Took %s", humanDuration(elapsed))

	isErr := exitCode != 0 || ctx.Err() != nil
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: sb.String()}},
		IsError: isErr,
		Details: map[string]any{
			"exit_code":        exitCode,
			"exitCode":         exitCode,
			"stdout":           stdoutDetail(trimmed, a.SeparateStreams),
			"stderr":           stderrDetail(stderrOut, a.SeparateStreams),
			"truncated":        truncLines || truncBytes,
			"full_output_path": fullPath,
			"lines_truncated":  truncLines,
			"bytes_truncated":  truncBytes,
			"duration_ms":      elapsed.Milliseconds(),
			"workdir":          cwd,
			"steps":            len(steps),
		},
	}, nil
}

// humanDuration renders a duration in the "Took X.Ys" style used by
// the shell-log output: tenths of a second for sub-minute runs,
// whole seconds once we pass a minute. Trailing zeros dropped so
// "0.1s" instead of "0.10s".
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

// bashEnv starts from the daemon environment plus SANDBOX-safe extras
// (same key policy as the python tool).
func bashEnv(extra map[string]string) []string {
	env := os.Environ()
	for k, v := range extra {
		if !validEnvKey(k) {
			continue
		}
		env = append(env, k+"="+v)
	}
	return env
}

func stdoutDetail(trimmed string, separated bool) string {
	if !separated {
		return trimmed
	}
	return trimmed
}

func stderrDetail(stderrOut string, separated bool) string {
	if !separated {
		return ""
	}
	return stderrOut
}

func writeFullOutput(s string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := filepath.Join(os.TempDir(), "zot-bash-"+hex.EncodeToString(b)+".log")
	if err := os.WriteFile(name, []byte(s), 0o600); err != nil {
		return ""
	}
	return name
}

type shellCommand struct {
	path   string
	flag   string
	isBash bool
}

func currentShell() shellCommand {
	return resolveShell(runtime.GOOS, isExecutableFile, exec.LookPath)
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

func shellDescription(shell shellCommand) string {
	if shell.flag == "/C" {
		return "Run a Windows Command Prompt command via cmd /C. stdout+stderr merged."
	}
	if shell.isBash {
		return fmt.Sprintf("Run a Bash command via %s -c. stdout+stderr merged.", shell.path)
	}
	return "Bash is unavailable; run a POSIX sh command via /bin/sh -c. stdout+stderr merged."
}

func newShellCmd(ctx context.Context, command string) *exec.Cmd {
	shell := currentShell()
	return exec.CommandContext(ctx, shell.path, shell.flag, command)
}
