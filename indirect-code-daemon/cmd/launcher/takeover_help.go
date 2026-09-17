package main

import (
	"encoding/json"
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

// sharedRootFor resolves the shared root from a slot dir
// (<root>/slots/slot-x -> <root>).
func sharedRootFor(slotDir string) string {
	parent := filepath.Dir(slotDir)
	if filepath.Base(parent) == "slots" {
		return filepath.Dir(parent)
	}
	return slotDir
}

// startStandby launches the new daemon with --standby (loads storage,
// shadow-connects, writes serving.json) against the inactive slot. The
// caller waits serving proof via waitServingProof().
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

// servingProof mirrors the daemon's serving.json declaration.
type servingProof struct {
	Version     string `json:"version"`
	Pid         int    `json:"pid"`
	ConnectedAt int64  `json:"connectedAt"`
	Sessions    int    `json:"sessions"`
}

// waitServingProof waits for slotDir/serving.json with matching version
// AND a live pid. Stale files (crash leftovers) fail the pid check and
// are ignored — readers must always verify liveness, never trust bytes.
func waitServingProof(slotDir, expectVersion string, timeout time.Duration) error {
	path := filepath.Join(slotDir, "serving.json")
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(path); err == nil {
			var p servingProof
			if jerr := json.Unmarshal(raw, &p); jerr == nil && p.Version == expectVersion && p.Pid > 0 {
				if pidAlive(fmt.Sprint(p.Pid)) {
					return nil
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("no serving proof for %s in time", expectVersion)
}
