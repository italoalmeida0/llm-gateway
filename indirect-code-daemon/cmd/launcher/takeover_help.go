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

// fetchDaemonTo downloads the floating daemon asset into slotDir/bin.
// Freshness is enforced by --version self-verify after download
// (plus a cache-buster query), not by immutable versioned URLs.
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
	mirror := mirrorBase()
	if mirror == "" {
		return "", fmt.Errorf("no release mirror available (pair a gateway or set INDIRECT_REPO_RAW)")
	}
	// Single floating URL (no -v copies): cache-buster query on top.
	url := fmt.Sprintf("%s/%s?u=%s-%d", mirror, asset, version, time.Now().Unix())
	tmp, err := os.CreateTemp(binDir, ".daemon-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := fetchURL(url, tmp); err != nil {
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

// selfVerifyRuns checks a daemon binary RUNS (--version exits 0 with a
// sane version string), without pinning to any expected version. Boot
// path only: a promoted slot legitimately holds a NEWER daemon than the
// launcher (post-flip power loss). Update freshness is enforced by the
// takeover path (selfVerifyDaemon against the target version).
func selfVerifyRuns(path string) error {
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
	if !strings.Contains(string(out), "indirect-code daemon") {
		return fmt.Errorf("not an indirect-code daemon: %q", strings.TrimSpace(string(out)))
	}
	return nil
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
// shadow-connects, writes serving.json) against the inactive slot. The
// caller waits serving proof via waitServingProof(). Config is slot-local
// (canonical layout): the slot's own config.json.
func startStandby(daemonPath, slotDir, version string) (*standbyProc, error) {
	_ = version
	cmd := exec.Command(daemonPath,
		"--data-dir", slotDir, "--config", filepath.Join(slotDir, "config.json"), "--standby")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &standbyProc{cmd: cmd, dataDir: slotDir}, nil
}

// terminateParent asks the active daemon to exit gracefully (SIGTERM;
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

// servingProof mirrors the daemon's serving.json declaration.
