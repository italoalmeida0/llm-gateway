package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Self-update, daemon side: the daemon CHECKS a version manifest on the
// release mirror (versions.json next to SHA256SUMS.txt) on start, on every
// reconnect, and every updateCheckInterval, and broadcasts availability via
// daemon_update. It never downloads anything itself.
//
// Download + verify + restart live in the BRUTAL update protocol:
// the daemon spawns itself --update-start (SIGKILLs the old side, copies
// the slot, runs the new launcher), the launcher spawns --update-end,
// and promote happens after its first WS connect. See handoff.go (active
// side) + update_flow.go (--update-start/--update-end) + launcher/update.go.
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
	// instead of a generic failure, and beginHandoff backs off 1min for
	// the same target version (retrying stale bytes is pointless).
	mismatchWant string
	mismatchGot  string
	mismatchAt   int64
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
	gw, token := d.configNow().GatewayURL, d.configNow().DaemonToken
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
		d.broadcastUpdateState()
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

// broadcastUpdateState emits daemon_update to all frontend clients.
func (d *DaemonServer) broadcastUpdateState() {
	st := d.updateChecker()
	st.mu.Lock()
	msg := map[string]any{
		"type": "daemon_update", "hostId": d.configNow().HostID,
		"current": daemonVersion, "available": st.available,
		"checkedAt":    st.checkedAt,
		"mismatchWant": st.mismatchWant, "mismatchGot": st.mismatchGot,
		"mismatchAt": st.mismatchAt,
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
	if d.configNow() == nil {
		return true
	}
	return d.configNow().AutoUpdate == nil || *d.configNow().AutoUpdate
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
