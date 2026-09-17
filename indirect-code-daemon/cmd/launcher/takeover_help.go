package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// standbyProc is a daemon started in standby (no WS) for health checks.
type standbyProc struct {
	cmd     *exec.Cmd
	dataDir string
}

// fetchDaemonTo downloads the daemon asset for version into slotDir/bin.
func fetchDaemonTo(slotDir, version string) (string, error) {
	asset := "indirect-code-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	binDir := filepath.Join(slotDir, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return "", err
	}
	local := filepath.Join(binDir, asset)
	if runtime.GOOS == "windows" {
		local = filepath.Join(binDir, "indirect-code.exe")
	}
	// Manifest URL: same mirror the daemon uses (env override supported).
	base := releaseBase()
	_ = base
	mirror := os.Getenv("INDIRECT_REPO_RAW")
	if mirror == "" {
		mirror = defaultReleaseBase
	}
	mirror = strings.TrimRight(mirror, "/")
	tmp, err := os.CreateTemp(binDir, ".daemon-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := fetchURL(mirror+"/"+asset, tmp); err != nil {
		tmp.Close()
		return "", fmt.Errorf("download %s: %w", asset, err)
	}
	tmp.Close()
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, 0o755); err != nil {
			return "", err
		}
	}
	if err := os.Rename(tmpName, local); err != nil {
		return "", err
	}
	return local, nil
}

// selfVerifyDaemon runs `daemon --version` and checks the version string.
func selfVerifyDaemon(path, want string) error {
	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		defer close(done)
		cmd := exec.Command(path, "--version")
		out, runErr = cmd.CombinedOutput()
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		return fmt.Errorf("daemon --version timed out")
	}
	if runErr != nil {
		return fmt.Errorf("daemon --version failed: %v (%s)", runErr, strings.TrimSpace(string(out)))
	}
	if !strings.Contains(string(out), want) {
		return fmt.Errorf("daemon version mismatch: want %q, got %q", want, strings.TrimSpace(string(out)))
	}
	return nil
}

// startStandby launches the new daemon with --standby (loads storage,
// binds nothing, connects no WS) against the inactive slot.
func startStandby(daemonPath, slotDir, version string) (*standbyProc, error) {
	_ = version
	shared := sharedRootFor(slotDir)
	cmd := exec.Command(daemonPath,
		"--data-dir", slotDir, "--config", shared+"/config.json", "--standby")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &standbyProc{cmd: cmd, dataDir: slotDir}, nil
}

// healthCheckStandby waits for the standby daemon's readiness probe:
// it writes standby-ready.json in its data dir when storage loads OK.
// Death is detected via Wait (ProcessState stays nil until Wait returns
// — polling it alone would hang the full timeout on a dead standby).
func healthCheckStandby(s *standbyProc, slotDir string) error {
	ready := filepath.Join(slotDir, "standby-ready.json")
	exited := make(chan error, 1)
	go func() { exited <- s.cmd.Wait() }()
	deadline := time.Now().Add(2 * time.Minute)
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return fmt.Errorf("standby exited early: %v", err)
		case <-ticker.C:
			if _, err := os.Stat(ready); err == nil {
				return nil
			}
		}
	}
	return fmt.Errorf("standby not ready in time")
}

// sharedRootFor resolves the shared root from a slot dir
// (<root>/slots/slot-x -> <root>).
func sharedRootFor(slotDir string) string {
	parent := filepath.Dir(slotDir)
	if filepath.Base(parent) == "slots" {
		return filepath.Dir(parent)
	}
	return slotDir
}

// terminateParent asks the old daemon to exit gracefully (SIGTERM;
// it disconnects WS + exits on its own terms).
func terminateParent(pid string) error {
	n, err := parsePid(pid)
	if err != nil {
		return err
	}
	return terminatePid(n)
}

// runVersionCmd runs `bin --version` and returns combined output.
func runVersionCmd(path string) ([]byte, error) {
	return exec.Command(path, "--version").CombinedOutput()
}

// newOSExecCmd is unused-compat (kept for fetch.go reference).
func newOSExecCmd(path, arg string) *exec.Cmd {
	return exec.Command(path, arg)
}

// osExecCmd aliases exec.Cmd for fetch.go.
type osExecCmd = exec.Cmd
