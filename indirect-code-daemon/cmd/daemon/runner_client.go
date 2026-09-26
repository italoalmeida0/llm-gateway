package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Parent-side runner plumbing (docs/runner-plan.md): self-copy the
// multi-call binary into runners/, spawn the runner role with a full
// exec spec, and expose the tool-visible handle. No binary verification
// (decided D3: open source — verification is theater and slows the hot
// path): copy if missing, run it.

// runnerSourceOverride lets tests point at a REAL built multi-call
// binary: the go test binary does not carry the --runner role.
var runnerSourceOverride = ""

// ensureRunnerBinary returns the runner binary path, self-copying the
// running executable into runners/ on first use (decided D3: no
// verification — copy if missing, run it).
func ensureRunnerBinary(root string) (string, error) {
	path := runner.BinaryPath(root, daemonVersion)
	if st, err := os.Stat(path); err == nil && !st.IsDir() && st.Size() > 0 {
		return path, nil
	}
	exe := runnerSourceOverride
	if exe == "" {
		var err error
		if exe, err = os.Executable(); err != nil {
			return "", err
		}
	}
	if err := os.MkdirAll(runner.RunnersDir(root), 0o700); err != nil {
		return "", err
	}
	// Publish ATOMICALLY (V2R-009): copy to a unique temp in the same dir,
	// fsync, then rename. A concurrent first command or an interrupted copy
	// can never observe a partial file as "ready" (the stat check above
	// accepts any nonempty file).
	tmp, err := os.CreateTemp(runner.RunnersDir(root), ".stage-runner-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	tmp.Close()
	if err := copyFileContents(exe, tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("stage runner: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("publish runner: %w", err)
	}
	return path, nil
}

// runnerStarter builds the tools.Starter the daemon injects: every
// command (bash AND python) runs through the crash-only runner.
func runnerStarter(root, sessionID, brainDir string) tools.Starter {
	return func(ctx context.Context, spec tools.ExecSpec) (*tools.Proc, error) {
		return startRunner(root, sessionID, brainDir, spec)
	}
}

// startRunner spawns the runner role for one command and returns the
// tool-visible handle. The identity exists from THIS moment (state file
// + out naming), before any Slow() registration.
func startRunner(root, sessionID, brainDir string, spec tools.ExecSpec) (*tools.Proc, error) {
	bin, err := ensureRunnerBinary(root)
	if err != nil {
		return nil, err
	}
	jobID := randomID8()
	startedAt := time.Now().UnixMilli()
	outPath := filepath.Join(runner.OutDir(root), runner.OutName(sessionID, jobID, startedAt))
	brainPath := filepath.Join(brainDir, fmt.Sprintf("bg_%s__%s.log", sanitizeID(spec.Kind), sanitizeID(jobID)))

	rs := runner.Spec{
		JobID: jobID, SessionID: sessionID, Kind: spec.Kind, Label: spec.Command,
		Path: spec.Argv[0], Args: spec.Argv[1:], Env: spec.Env, CWD: spec.CWD,
		Stdin: spec.Stdin,
		Root: root, RunnerVersion: daemonVersion,
		OutPath: outPath, BrainPath: brainPath,
	}
	raw, err := json.Marshal(rs)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o700); err != nil {
		return nil, err
	}
	cmd := exec.Command(bin, "--runner")
	cmd.Stdin = bytes.NewReader(raw)
	setChildPgid(cmd)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start runner: %w", err)
	}
	exited := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = cmd.Wait() // reaped ONCE (cmd.Wait is not re-callable)
		close(exited)
	}()
	proc := &tools.Proc{
		PID:      cmd.Process.Pid,
		JobID:    jobID,
		LogPath:  outPath,
		BrainLog: brainPath,
		Exited:   exited,
		Wait: func() error {
			<-exited
			return waitErr
		},
		Stop: func() {
			stopRunner(root, jobID, cmd.Process.Pid)
		},
		Pump:    tools.TailLog(outPath),
		Cleanup: func(bool) {},
		Disposition: func(jid, disp string) {
			_ = runner.WriteDisposition(root, jid, disp)
		},
	}
	return proc, nil
}

// Both newly launched and adopted jobs use the same cancellation fallback.
// Reaping runs outside the supervisor mailbox; the runner records completion
// only after its own reaper has finished.
func stopRunner(root, jobID string, pid int) {
	_ = killRunnerIPC(root, jobID)
	_ = terminatePid(pid)
	go reapCommandFromState(root, jobID)
}

// killRunnerIPC is the fast-path cancellation over the runner socket
// (best-effort: the process signal is the guarantee).
func killRunnerIPC(root, jobID string) error {
	st, err := runner.ReadState(runner.StatePath(root, jobID))
	if err != nil || st.Transport.Port == 0 {
		return fmt.Errorf("no transport")
	}
	return runner.DialKill(st, "stop", 2*time.Second)
}

// sanitizeID keeps ids filename-safe (mirrors the runner's rule).
func sanitizeID(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch r {
		case '/', '\\', ':':
			out = append(out, '_')
		default:
			out = append(out, r)
		}
	}
	return string(out)
}

// pidString is the shared pid formatting for state files.
func pidString(pid int) string { return strconv.Itoa(pid) }
