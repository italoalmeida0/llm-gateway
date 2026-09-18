package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Self-update, daemon side: the daemon CHECKS a version manifest on the
// release mirror (versions.json next to SHA256SUMS.txt) on start, on every
// reconnect, and every updateCheckInterval, and broadcasts availability via
// daemon_update. It never downloads anything itself.
//
// Download + verify + restart live in the LAUNCHER (takeover protocol):
// the daemon freezes late, the new launcher prepares the inactive slot,
// and promote happens through standby. See handoff.go (daemon side) and
// cmd/launcher/takeover.go (launcher side).
//
// Version model: daemonVersion is stamped at build time via ldflags
// (-X main.daemonVersion=vX.Y.Z); dev builds report "dev" and never
// update (no manifest match possible).

var daemonVersion = "dev"

const (
	updateCheckInterval = 10 * time.Minute
	updateManifestFile  = "versions.json"
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
	checkedAt int64
	lastError string
	// handoffBusy guards concurrent beginHandoff calls.
	handoffBusy bool
	// verifyMismatch remembers the last self-verify failure (want vs got
	// version + timestamp): the frontend shows "mirror stale, retry later"
	// instead of a generic failure, and beginHandoff backs off 30min for
	// the same target version (retrying stale bytes is pointless).
	mismatchWant string
	mismatchGot  string
	mismatchAt   int64
	// Handoff freeze (late pause): when frozen, the daemon rejects new
	// turns and mutations but KEEPS the WS connected. Set only after the
	// new launcher is downloaded + self-verified (never pause for a
	// download that may fail). Unfreeze on any failure before handoff.
	frozen      bool
	freezeStage string // current stage label for the frontend loading screen
}

func (d *DaemonServer) updateChecker() *updateState {
	d.updateMu.Lock()
	defer d.updateMu.Unlock()
	if d.update == nil {
		d.update = &updateState{}
	}
	return d.update
}

// No GitHub fallback: releases come from the paired gateway
// (/r/versions.json, authenticated) or INDIRECT_REPO_RAW override.
// A daemon without gateway has no update source by design.

// manifestURL resolves the versions.json URL from the explicit override
// only (no GitHub fallback by design). Daemon update checks go through
// fetchManifestWithConfig (gateway-first); this is the last-resort path.
func manifestURL() string {
	if v := os.Getenv("INDIRECT_REPO_RAW"); v != "" {
		return strings.TrimRight(v, "/") + "/" + updateManifestFile
	}
	return ""
}

func fetchManifest() (*versionManifest, error) {
	return fetchManifestWithConfig(nil)
}

// fetchManifestWithConfig tries the gateway first (instant, no CDN cache),
// then the public mirror. d may be nil (launcher-side callers pass explicit
// gateway URL + token via fetchManifestGateway).
func fetchManifestWithConfig(d *DaemonServer) (*versionManifest, error) {
	if d != nil {
		if m, err := fetchManifestGateway(d); err == nil {
			return m, nil
		} else {
			fmt.Printf("[UPDATE] gateway manifest failed (%v), trying mirror\n", err)
		}
	}
	return fetchManifestMirror()
}

// fetchManifestGateway pulls versions.json from the connected gateway
// (same host/token the daemon already uses for WS).
func fetchManifestGateway(d *DaemonServer) (*versionManifest, error) {
	d.configMu.RLock()
	gw, token := d.config.GatewayURL, d.config.DaemonToken
	d.configMu.RUnlock()
	if gw == "" || token == "" {
		return nil, fmt.Errorf("no gateway configured")
	}
	u, err := url.Parse(gw)
	if err != nil {
		return nil, err
	}
	scheme := "http"
	if u.Scheme == "https" {
		scheme = "https"
	}
	endpoint := fmt.Sprintf("%s://%s/api/indirect-code/versions", scheme, u.Host)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("gateway versions HTTP %d", resp.StatusCode)
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
		return nil, fmt.Errorf("gateway manifest missing daemon version")
	}
	return &m, nil
}

func fetchManifestMirror() (*versionManifest, error) {
	u := manifestURL()
	if u == "" {
		return nil, fmt.Errorf("no update source (pair a gateway or set INDIRECT_REPO_RAW)")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(u)
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
	m, err := fetchManifestWithConfig(d)
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
	st.mu.Unlock()
	d.broadcastUpdateState()
	_ = m
	_ = reason
}
func (d *DaemonServer) setUpdateError(msg string) {
	st := d.updateChecker()
	st.mu.Lock()
	st.lastError = msg
	st.mu.Unlock()
	d.broadcastUpdateState()
}

// setFrozen flips the handoff freeze and broadcasts the stage.
func (d *DaemonServer) setFrozen(frozen bool, stage string) {
	st := d.updateChecker()
	st.mu.Lock()
	st.frozen = frozen
	if stage != "" {
		st.freezeStage = stage
	}
	st.mu.Unlock()
	d.broadcastUpdateState()
}

// isFrozen reports the handoff freeze (dispatchers reject mutations).
func (d *DaemonServer) isFrozen() bool {
	st := d.updateChecker()
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.frozen
}

// announceUpdateDone broadcasts update_done once when a handoff marker
// exists (written by takeover on promote), then removes it. Called on
// every (re)connect so the frontend learns even if WS was down at boot.
func (d *DaemonServer) announceUpdateDone() {
	marker := ""
	// Marker lives next to the slot's handoff file (dataDir-adjacent).
	for _, cand := range []string{
		filepath.Join(d.dataDir, "handoff.json"),
		filepath.Join(filepath.Dir(d.dataDir), "handoff.json"),
	} {
		if raw, err := os.ReadFile(cand); err == nil && strings.TrimSpace(string(raw)) == "promoted" {
			marker = cand
			break
		}
	}
	if marker == "" {
		return
	}
	_ = os.Remove(marker)
	_ = d.sendWS(map[string]any{
		"type": "update_done", "hostId": d.config.HostID, "version": daemonVersion,
	})
}

// broadcastUpdateState emits daemon_update to all frontend clients.
func (d *DaemonServer) broadcastUpdateState() {
	st := d.updateChecker()
	st.mu.Lock()
	msg := map[string]any{
		"type": "daemon_update", "hostId": d.config.HostID,
		"current": daemonVersion, "available": st.available,
		"checkedAt":    st.checkedAt,
		"mismatchWant": st.mismatchWant, "mismatchGot": st.mismatchGot,
		"mismatchAt": st.mismatchAt,
		"autoUpdate": d.autoUpdateEnabled(),
		"frozen":     st.frozen, "freezeStage": st.freezeStage,
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
