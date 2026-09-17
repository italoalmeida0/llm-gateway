package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Self-update: the daemon checks a version manifest on the release mirror
// (same base as binaries: versions.json next to SHA256SUMS.txt) on start,
// on every reconnect, and every updateCheckInterval. The frontend is told
// via daemon_update events and (when autoUpdate is on) the update is
// staged + applied on restart.
//
// Version model: daemonVersion is stamped at build time via ldflags
// (-X main.daemonVersion=vX.Y.Z); dev builds report "dev" and never
// self-update (no manifest match possible).
//
// Apply model (safe by construction):
//   1. check: manifest version != running version -> available.
//   2. stage (autoUpdate only): download asset to bin/daemon-<v>/,
//      verify SHA256 against manifest (fallback SHA256SUMS.txt).
//   3. apply: user clicks Restart (or auto-restart when idle + autoUpdate)
//      -> daemon exits 42 (exitUpdateRestart) -> launcher re-resolves
//      (picks newest staged) + execs. Rollback = previous staged dir
//      stays on disk; launcher falls back when the new binary fails.

var daemonVersion = "dev"

const (
	updateCheckInterval = 10 * time.Minute
	updateManifestFile  = "versions.json"
	// exitUpdateRestart tells the launcher supervise loop to re-resolve
	// and exec (instead of exiting for good).
	exitUpdateRestart = 42
)

// versionManifest is dist/versions.json (published by the release script).
type versionManifest struct {
	Daemon   releaseAsset `json:"daemon"`
	Launcher releaseAsset `json:"launcher"`
}

type releaseAsset struct {
	Version string            `json:"version"`
	Assets  map[string]string `json:"assets"` // "linux-amd64" -> filename
	Sums    map[string]string `json:"sums"`   // filename -> sha256 hex
}

// updateState is the daemon's self-update runtime (guarded by mu).
type updateState struct {
	mu        sync.Mutex
	available string // manifest version when != running ("" = none)
	staged    string // version downloaded + verified, ready to apply
	checkedAt int64
	lastError string
	staging   bool // stageUpdate in flight (prevents double downloads)
}

func (d *DaemonServer) updateChecker() *updateState {
	d.updateMu.Lock()
	defer d.updateMu.Unlock()
	if d.update == nil {
		d.update = &updateState{}
	}
	return d.update
}

// defaultMirror is the public release mirror (override via
// INDIRECT_REPO_RAW env, same as the launcher/installer).
const defaultMirror = "https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist"

// manifestURL resolves the versions.json URL from the release mirror.
func manifestURL() string {
	base := defaultMirror
	if v := os.Getenv("INDIRECT_REPO_RAW"); v != "" {
		base = v
	}
	return strings.TrimRight(base, "/") + "/" + updateManifestFile
}

func fetchManifest() (*versionManifest, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(manifestURL())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("manifest HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var m versionManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	if m.Daemon.Version == "" {
		return nil, fmt.Errorf("manifest missing daemon version")
	}
	return &m, nil
}

// checkForUpdates fetches the manifest and records availability. Never
// fails the caller: errors are recorded and broadcast as lastError.
func (d *DaemonServer) checkForUpdates(reason string) {
	if daemonVersion == "dev" || daemonVersion == "" {
		// Dev builds never self-update, but still broadcast so the
		// frontend shows "dev build" instead of "unknown".
		d.broadcastUpdateState()
		return
	}
	m, err := fetchManifest()
	st := d.updateChecker()
	st.mu.Lock()
	st.checkedAt = time.Now().UnixMilli()
	if err != nil {
		st.lastError = err.Error()
		st.mu.Unlock()
		return
	}
	st.lastError = ""
	if m.Daemon.Version != daemonVersion && m.Daemon.Version != "" {
		st.available = m.Daemon.Version
	} else {
		st.available = ""
	}
	available, staged := st.available, st.staged
	st.mu.Unlock()
	d.broadcastUpdateState()
	// Auto-stage when enabled and something is available.
	if available != "" && available != staged && d.autoUpdateEnabled() {
		go d.stageUpdate(m)
	}
	_ = reason
}

// stageUpdate downloads + verifies the new daemon binary into
// bin/daemon-<version>/ (idempotent: skips when already staged).
func (d *DaemonServer) stageUpdate(m *versionManifest) {
	v := m.Daemon.Version
	if v == "" || v == daemonVersion {
		return
	}
	st := d.updateChecker()
	st.mu.Lock()
	if st.staging || st.staged == v {
		st.mu.Unlock()
		return
	}
	st.staging = true
	st.mu.Unlock()
	defer func() {
		st.mu.Lock()
		st.staging = false
		st.mu.Unlock()
	}()
	key := runtime.GOOS + "-" + runtime.GOARCH
	asset := m.Daemon.Assets[key]
	if asset == "" {
		d.setUpdateError(fmt.Sprintf("no asset for %s", key))
		return
	}
	dir := filepath.Join(d.dataDir, "bin", "daemon-"+v)
	local := filepath.Join(dir, asset)
	if runtime.GOOS == "windows" {
		local = filepath.Join(dir, "indirect-code.exe")
	}
	if st, err := os.Stat(local); err == nil && !st.IsDir() && st.Size() > 0 {
		d.setUpdateStaged(v)
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		d.setUpdateError(err.Error())
		return
	}
	base := manifestURL()
	base = base[:len(base)-len(updateManifestFile)]
	tmp, err := os.CreateTemp(dir, ".daemon-*")
	if err != nil {
		d.setUpdateError(err.Error())
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := fetchURL(base+asset, tmp); err != nil {
		tmp.Close()
		d.setUpdateError(err.Error())
		return
	}
	tmp.Close()
	want := m.Daemon.Sums[asset]
	if want != "" {
		if err := verifyFileSHA256(tmpName, want); err != nil {
			d.setUpdateError(err.Error())
			return
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, 0o755); err != nil {
			d.setUpdateError(err.Error())
			return
		}
	}
	if err := os.Rename(tmpName, local); err != nil {
		// Windows: rename onto an existing file fails — a concurrent
		// (or previous) stager may have won the race. If a valid binary
		// is in place, treat as staged instead of erroring.
		if st, serr := os.Stat(local); serr != nil || st.IsDir() || st.Size() == 0 {
			d.setUpdateError(err.Error())
			return
		}
	}
	d.setUpdateStaged(v)
}

func (d *DaemonServer) setUpdateError(msg string) {
	st := d.updateChecker()
	st.mu.Lock()
	st.lastError = msg
	st.mu.Unlock()
	d.broadcastUpdateState()
}

func (d *DaemonServer) setUpdateStaged(v string) {
	st := d.updateChecker()
	st.mu.Lock()
	st.staged = v
	st.lastError = ""
	st.mu.Unlock()
	d.broadcastUpdateState()
}

// broadcastUpdateState emits daemon_update to all frontend clients.
func (d *DaemonServer) broadcastUpdateState() {
	st := d.updateChecker()
	st.mu.Lock()
	msg := map[string]any{
		"type": "daemon_update", "hostId": d.config.HostID,
		"current": daemonVersion, "available": st.available,
		"staged": st.staged, "checkedAt": st.checkedAt,
		"autoUpdate": d.autoUpdateEnabled(),
	}
	if st.lastError != "" {
		msg["error"] = st.lastError
	}
	st.mu.Unlock()
	_ = d.sendWS(msg)
}

// autoUpdateEnabled reads the toggle (default true when unset).
func (d *DaemonServer) autoUpdateEnabled() bool {
	d.configMu.RLock()
	defer d.configMu.RUnlock()
	if d.config == nil {
		return true
	}
	return d.config.AutoUpdate == nil || *d.config.AutoUpdate
}

// startUpdateLoop runs the periodic check (every 10min) until stopCh.
func (d *DaemonServer) startUpdateLoop(stopCh <-chan struct{}) {
	// Immediate check on start (async, never blocks boot).
	go d.checkForUpdates("start")
	ticker := time.NewTicker(updateCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			d.checkForUpdates("interval")
		}
	}
}

// fetchURL downloads url into w (5min timeout for binaries).
func fetchURL(url string, w io.Writer) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

// verifyFileSHA256 checks path against a hex digest.
func verifyFileSHA256(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("checksum mismatch")
	}
	return nil
}

// applyStagedUpdate exits 42 so the launcher re-resolves (picks the
// staged version) and execs. Only when a staged version exists.
func (d *DaemonServer) applyStagedUpdate() bool {
	st := d.updateChecker()
	st.mu.Lock()
	ready := st.staged != "" && st.staged != daemonVersion
	st.mu.Unlock()
	if !ready {
		return false
	}
	fmt.Printf("[UPDATE] applying staged %s (restart)\n", st.staged)
	go func() {
		// Graceful: quiesce first (commits WALs), then exit 42.
		d.quiesceSessions()
		os.Exit(exitUpdateRestart)
	}()
	return true
}
