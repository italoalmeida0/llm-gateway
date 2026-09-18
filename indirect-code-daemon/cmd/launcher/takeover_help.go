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
	mirror := os.Getenv("INDIRECT_REPO_RAW")
	if mirror == "" {
		mirror = defaultReleaseBase
	}
	mirror = strings.TrimRight(mirror, "/")
	// Dual publish: versioned URL first (immutable — a CDN can never serve
	// stale bytes for a URL that never existed), floating fallback (may be
	// stale; --version self-verify decides). Cache-buster query on top.
	verAsset := asset
	if runtime.GOOS == "windows" {
		verAsset = "indirect-code-" + runtime.GOOS + "-" + runtime.GOARCH + "-v" + version + ".exe"
	} else {
		verAsset = asset + "-v" + version
	}
	candidates := []string{
		fmt.Sprintf("%s/%s?u=%s-%d", mirror, verAsset, version, time.Now().Unix()),
		fmt.Sprintf("%s/%s?u=%s-%d", mirror, asset, version, time.Now().Unix()),
	}
	var dlErr error
	var saw404Versioned bool
	tmp, err := os.CreateTemp(binDir, ".daemon-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	for i, u := range candidates {
		tmp.Seek(0, 0)
		tmp.Truncate(0)
		if err := fetchURL(u, tmp); err != nil {
			// First candidate (versioned URL) 404 = release still
			// propagating on the mirror (manifest text propagates before
			// big blobs). Signal distinctly so the daemon backs off with
			// "retry later" instead of a generic failure.
			if i == 0 && isNotFound(err) {
				saw404Versioned = true
			}
			dlErr = fmt.Errorf("download %s: %w", asset, err)
			continue
		}
		dlErr = nil
		break
	}
	if dlErr != nil {
		tmp.Close()
		if saw404Versioned {
			return "", errReleasePropagating
		}
		return "", dlErr
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

// errReleasePropagating signals versioned-asset 404: the release manifest
// is live but blobs haven't propagated. Retry later, don't mismatch-backoff.
var errReleasePropagating = fmt.Errorf("release propagating on mirror (versioned asset 404), retry in a few minutes")

// isNotFound detects HTTP 404 in fetch errors.
func isNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "HTTP 404")
}
