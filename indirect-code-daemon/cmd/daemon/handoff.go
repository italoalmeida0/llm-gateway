package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Brutal update orchestrator (daemon side): no quiesce, no freeze dance.
//
// Order:
//  0. Background: detect (manifest poll) + clean the update slot (never
//     the own one) + download the new launcher + self-verify (--version)
//     + require the manifest version strictly newer than this daemon.
//     NOTHING pauses yet.
//  1. Spawn OURSELVES with --update-start (detached, own pid passed) and
//     keep serving until SIGKILLed. The updater is fully naive (loads no
//     sessions), kills us brutally (SIGKILL — crash recovery resumes the
//     turns from WALs), takes over the pidfile, owns the host in "update"
//     state (host_status updating via the relay), copies our slot
//     into the update slot, and runs the new launcher in --update mode.
//  2. The launcher migrates the update slot, fetches + verifies the new
//     daemon (runs + expected version + strictly newer), then spawns it
//     DETACHED with --update-end and exits.
//  3. --update-end boots, commits slots/active, attempts a relay hello,
//     SIGKILLs the waiter, deletes the old slot and reports update_done.
//  4. Any failure: the launcher writes the fail file (only when ready to
//     be killed); the waiter kills the launcher, deletes the update slot,
//     reports update_failed + back-to-normal, and re-execs itself as a
//     normal daemon (crash recovery resumes the turns).
//
// See update_flow.go (daemon --update-start/--update-end) + launcher/update.go.

// slotLayout resolves active/inactive slot dirs under <dataDir>/slots.
type slotLayout struct {
	base     string
	active   string // "a" or "b"
	inactive string
}

func (d *DaemonServer) slots() slotLayout {
	// Canonical layout: dataDir IS the active slot (<root>/slots/slot-x),
	// so the root is two levels up. The launcher guarantees the layout
	// before exec.
	//
	// TEST/LEGACY layout: dataDir IS the root (slots/ directly inside,
	// as the E2E harness and old installs use). Detect it: when dataDir
	// itself contains slots/active, the root is dataDir. Without this,
	// rootDir() walks two levels up from dataDir (which is NOT inside
	// slots/), reads a nonexistent slots/active, and every slot path
	// (fetchLauncherTo, copyToSlot, abort cleanup) fans out to a WRONG
	// directory — phase-0 verify then fails with the version of
	// whatever stale binary was already there (caught on Windows: the
	// E2E daemon-home root layout downloaded vE2E.2 into a phantom dir
	// while slot-a kept the installed vE2E.1 launcher).
	if raw, err := os.ReadFile(filepath.Join(d.dataDir, "slots", "active")); err == nil {
		if s := strings.TrimSpace(string(raw)); s == "a" || s == "b" {
			active := s
			inactive := "b"
			if active == "b" {
				inactive = "a"
			}
			return slotLayout{base: filepath.Join(d.dataDir, "slots"), active: active, inactive: inactive}
		}
	}
	root := d.rootDir()
	active := "a"
	if raw, err := os.ReadFile(filepath.Join(root, "slots", "active")); err == nil {
		if s := strings.TrimSpace(string(raw)); s == "a" || s == "b" {
			active = s
		}
	}
	inactive := "b"
	if active == "b" {
		inactive = "a"
	}
	return slotLayout{base: filepath.Join(root, "slots"), active: active, inactive: inactive}
}

func (s slotLayout) dir(which string) string {
	return filepath.Join(s.base, "slot-"+which)
}

// slotDir resolves the slot dir: dataDir IS the active slot, so the
// active slot is dataDir itself; the inactive one is its sibling.
func (d *DaemonServer) slotDir(which string) string {
	sl := d.slots()
	if which == sl.active {
		return d.dataDir
	}
	return sl.dir(which)
}

// beginHandoff starts the update handoff in background (never blocks the
// dispatcher). Safe to call multiple times: second call is a no-op while
// one is in flight (handoffBusy guard).
func (d *DaemonServer) beginHandoff() {
	st := d.updateChecker()
	st.mu.Lock()
	if st.handoffBusy {
		st.mu.Unlock()
		return
	}
	version := st.available
	if version == "" {
		st.mu.Unlock()
		return
	}
	if version == daemonVersion {
		// Stale manifest / cached asset / double click: swapping a daemon
		// for itself must never freeze, disconnect or kill anything.
		st.lastError = "already on " + version
		st.mu.Unlock()
		d.broadcastUpdateState()
		return
	}
	if st.mismatchWant == version && time.Now().UnixMilli()-st.mismatchAt < 60*1000 {
		// Same target failed verify <1min ago (mirror serving stale
		// bytes): retrying now is pointless. Refuse fast with the stored
		// reason; the next periodic check re-arms automatically.
		st.lastError = "mirror stale for " + version + " (got " + st.mismatchGot + "), retry later"
		st.mu.Unlock()
		d.broadcastUpdateState()
		return
	}
	st.handoffBusy = true
	st.mu.Unlock()
	go d.runHandoff(version)
}

// runHandoff executes the brutal update: clean the target slot (never the
// own one), download + verify the new launcher (runs the expected version
// AND strictly newer than this daemon), then spawn ITSELF with
// --update-start and keep serving until the updater SIGKILLs us. Any error
// before the spawn → cleanup + update_failed broadcast (WS never dropped).
func (d *DaemonServer) runHandoff(version string) {
	defer func() {
		st := d.updateChecker()
		st.mu.Lock()
		st.handoffBusy = false
		st.mu.Unlock()
	}()
	fail := func(reason string) {
		d.abortHandoff(reason)
	}
	if !isVersionNewer(version, daemonVersion) {
		fail(fmt.Sprintf("already on %s (target %s is not newer)", daemonVersion, version))
		return
	}
	sl := d.slots()
	// Clean the target slot FIRST (never the own slot: guard inside).
	if err := cleanInactiveSlot(d.rootDir(), sl.active, sl.inactive, d.dataDir); err != nil {
		fail(fmt.Sprintf("clean update slot: %v", err))
		return
	}
	// Download the new launcher into the clean slot + self-verify.
	// (Background: user untouched, still serving normally.)
	launcherPath, err := d.fetchLauncherTo(version, sl)
	if err != nil {
		fail(fmt.Sprintf("launcher download: %v", err))
		return
	}
	// The launcher MUST have been (re)downloaded by the fetch above:
	// a pre-existing binary (installed vE2E.1 launcher, stale cache)
	// would verify against the OLD version and fail with a confusing
	// "got 1.0.21" mismatch. Stat the mtime to prove freshness in
	// failure reports (caught on Windows: phase-0 verify failed with
	// the installed launcher's version).
	if st, serr := os.Stat(launcherPath); serr != nil {
		fail(fmt.Sprintf("launcher missing after download: %v", serr))
		return
	} else if time.Since(st.ModTime()) > 5*time.Minute {
		fail(fmt.Sprintf("launcher not refreshed by download (mtime %v)", st.ModTime()))
		return
	}
	if err := selfVerifyBinary(launcherPath, version, "launcher"); err != nil {
		d.recordMismatch(version, extractGotVersion(err))
		fail(fmt.Sprintf("launcher verify: %v", err))
		return
	}
	// The manifest version is strictly newer than this daemon (checked
	// above), and the launcher was verified to RUN that version: releases
	// bump daemon+launcher in lockstep, so the launcher is newer too.
	// Spawn OURSELVES in --update-start mode (detached): the updater kills
	// us brutally (SIGKILL — crash recovery resumes the turns), takes over
	// the pidfile + relay in "update" state, copies our slot, and runs
	// the new launcher. We keep serving until the SIGKILL lands.
	if err := spawnUpdateStart(d.rootDir(), sl.active, sl.inactive, version, launcherPath); err != nil {
		fail(fmt.Sprintf("spawn updater: %v", err))
		return
	}
	// Spawned: the updater SIGKILLs us, owns the host and reports
	// host_status updating via the relay — no broadcast needed here.
}

// abortHandoff: the brutal spawn never happened (failure before
// --update-start), so NOTHING was killed: delete the update slot,
// clear the busy flag via the runHandoff defer, and notify the
// frontend. The daemon keeps serving untouched (WS never dropped).
func (d *DaemonServer) abortHandoff(reason string) {
	sl := d.slots()
	if err := removeInactiveSlot(d.rootDir(), sl.active, sl.inactive, d.dataDir); err != nil {
		reason += fmt.Sprintf(" (cleanup refused: %v)", err)
	}
	st := d.updateChecker()
	st.mu.Lock()
	st.lastError = reason
	st.mu.Unlock()
	d.broadcastUpdateState()
	_ = d.sendWS(map[string]any{
		"type": "update_failed", "hostId": d.config.HostID, "reason": reason,
	})
}

// fetchLauncherTo downloads the launcher asset for version into the
// inactive slot's bin dir. Returns the local path.
func (d *DaemonServer) fetchLauncherTo(version string, sl slotLayout) (string, error) {
	asset := "indirect-launcher-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	binDir := filepath.Join(d.slotDir(sl.inactive), "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return "", err
	}
	local := filepath.Join(binDir, asset)
	if runtime.GOOS == "windows" {
		local = filepath.Join(binDir, "indirect-launcher.exe")
	}
	// NOTE: no reuse of a leftover binary here. A previous attempt may
	// have left bytes for a DIFFERENT version (or a stale-cache copy);
	// the caller (runHandoff phase 0) always downloads fresh and
	// self-verifies. Reusing by size alone once promoted a stale daemon
	// past the point of rollback (E2E caught it: launcher vE2E.2 reused
	// 1.0.21 bytes, new side fetched the same stale daemon, verify
	// failed after the old daemon was already gone).
	// Gateway first (serves dist/ itself — instant, no CDN), mirror fallback.
	var bases []string
	if gb := gatewayBaseURL(d); gb != "" {
		bases = append(bases, strings.TrimRight(gb, "/")+"/r/")
	}
	if raw := os.Getenv("INDIRECT_REPO_RAW"); raw != "" {
		bases = append(bases, strings.TrimRight(raw, "/")+"/")
	} else if mu := manifestURL(); mu != "" {
		bases = append(bases, mu[:len(mu)-len(updateManifestFile)])
	}
	// Floating asset only: a single URL per base (no -v copies).
	// Freshness is enforced by --version self-verify after download
	// (plus a cache-buster query), not by immutable versioned URLs.
	var candidates []string
	for _, b := range bases {
		candidates = append(candidates,
			fmt.Sprintf("%s%s?u=%s-%d", b, asset, version, time.Now().Unix()),
		)
	}
	tmp, err := os.CreateTemp(binDir, ".launcher-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	var dlErr error
	for _, u := range candidates {
		tmp.Seek(0, 0)
		tmp.Truncate(0)
		if err := fetchURL(u, tmp); err != nil {
			dlErr = fmt.Errorf("download %s: %w", asset, err)
			continue
		}
		dlErr = nil
		break
	}
	if dlErr != nil {
		tmp.Close()
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

// selfVerifyBinary runs `bin --version` and checks the output contains
// the expected version. Stronger than SHA: proves the binary RUNS on
// this platform (not just byte-identical).
func selfVerifyBinary(path, wantVersion, kind string) error {
	ctxDone := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		defer close(ctxDone)
		cmd := exec.Command(path, "--version")
		out, runErr = cmd.CombinedOutput()
	}()
	select {
	case <-ctxDone:
	case <-time.After(30 * time.Second):
		return fmt.Errorf("%s --version timed out", kind)
	}
	if runErr != nil {
		return fmt.Errorf("%s --version failed: %v (%s)", kind, runErr, strings.TrimSpace(string(out)))
	}
	if !strings.Contains(string(out), wantVersion) {
		return fmt.Errorf("%s version mismatch: want %q, got %q", kind, wantVersion, strings.TrimSpace(string(out)))
	}
	if st, err := os.Stat(path); err != nil || st.Size() < 1<<20 {
		return fmt.Errorf("%s binary suspiciously small (%v)", kind, err)
	}
	return nil
}

// recordMismatch remembers a self-verify failure for backoff + UI.
func (d *DaemonServer) recordMismatch(want, got string) {
	st := d.updateChecker()
	st.mu.Lock()
	st.mismatchWant = want
	st.mismatchGot = got
	st.mismatchAt = time.Now().UnixMilli()
	st.mu.Unlock()
}

// extractGotVersion pulls the quoted got-version from a mismatch error
// (`want "X", got "Y"`); "" when the error has no version pair.
func extractGotVersion(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	i := strings.Index(s, `got "`)
	if i < 0 {
		return ""
	}
	s = s[i+5:]
	if j := strings.Index(s, `"`); j >= 0 {
		return s[:j]
	}
	return ""
}

// copyToSlot copies the slot's sessions (+ WALs, + small configs) active ->
// inactive. Immutable/replaced files use hardlinks when possible; WALs
// are independent copies because they append in place. dataDir IS the
// active slot, so the source is dataDir itself.
//
// WAL sidecars (*.wal.jsonl) MUST travel with their session JSON: the
// new daemon resumes running turns from them (the old side is SIGKILLed,
// so Status=running + WAL stay exactly as the crash left them). The per-session brain scratch
// (<root>/brain/<sid>) is root-level, shared by both slots — nothing to
// copy, and bg .log files survive the handoff there.
func (d *DaemonServer) copyToSlot(sl slotLayout, inactiveDir string) error {
	src := d.dataDir
	srcSessions := d.sessionsDir()
	// Sessions first: sourced from the live sessionsDir (slot-aware).
	// The brutal protocol never copies a LIVE daemon: --update-start runs
	// AFTER SIGKILLing the old side, so no writer races this copy.
	if s, err := os.Stat(srcSessions); err == nil && s.IsDir() {
		if err := copyDirLink(filepath.Dir(srcSessions), filepath.Join(inactiveDir, "sessions"), "sessions"); err != nil {
			return fmt.Errorf("copy sessions: %w", err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, name := range []string{"projects.json", "config.json", "storage_version.json"} {
		s, err := os.Stat(filepath.Join(src, name))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		dst := filepath.Join(inactiveDir, name)
		if s.IsDir() {
			if err := copyDirLink(src, dst, name); err != nil {
				return fmt.Errorf("copy %s: %w", name, err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := copyFileLink(filepath.Join(src, name), dst); err != nil {
			return fmt.Errorf("copy %s: %w", name, err)
		}
	}
	return nil
}

// copyDirLink clones src/name -> dst (hardlinks, fallback copy).
func copyDirLink(srcDir, dst, name string) error {
	return filepath.Walk(filepath.Join(srcDir, name), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		target := filepath.Join(filepath.Dir(dst), rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		return copyFileLink(path, target)
	})
}

// copyFileLink hardlinks (same device) or copies bytes (cross-device /
// Windows without privilege). Binaries are NEVER hardlinked: the daemon
// overwrites dist/r assets in place during tests/releases, and a
// hardlinked slot binary would silently change under a running process
// (same inode = new bytes). Session snapshots/configs stay hardlinked
// (tmp+rename); WALs are copied because resume repairs and appends them.
func copyFileLink(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	// WALs append in place and may need tail repair on resume: they must
	// never share storage with the rollback slot.
	if !isBinaryAsset(src) && !strings.HasSuffix(src, ".wal.jsonl") {
		if err := os.Link(src, dst); err == nil {
			return nil
		}
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := out.ReadFrom(in); err != nil {
		// Go <1.15 fallback not needed (1.26); keep direct copy.
		return err
	}
	return out.Sync()
}

// isBinaryAsset reports whether a slot file is a release binary (never
// hardlinked — see copyFileLink). Matches the build's dist/r asset
// pattern: indirect-code-*, indirect-launcher-*.
func isBinaryAsset(path string) bool {
	base := filepath.Base(path)
	return strings.HasPrefix(base, "indirect-code-") || strings.HasPrefix(base, "indirect-launcher")
}

// gatewayBaseURL returns scheme://host of the connected gateway ("" when
// unconfigured). The gateway serves dist/ itself: instant, no CDN cache.
func gatewayBaseURL(d *DaemonServer) string {
	if d == nil {
		return ""
	}
	d.configMu.RLock()
	defer d.configMu.RUnlock()
	if d.config == nil || d.config.GatewayURL == "" {
		return ""
	}
	u, err := url.Parse(d.config.GatewayURL)
	if err != nil || u.Host == "" {
		return ""
	}
	scheme := "http"
	if u.Scheme == "wss" || u.Scheme == "https" {
		scheme = "https"
	}
	return scheme + "://" + u.Host
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

// debugMirror reports what the daemon's own download path resolves:
// the gateway base (from slot config), the manifest version the daemon
// last polled, and the first bytes of the launcher asset as fetched
// through fetchLauncherTo's candidate chain. E2E forensics only.
func (d *DaemonServer) debugMirror(raw []byte) {
	var req struct {
		RequestID string `json:"requestId"`
	}
	_ = json.Unmarshal(raw, &req)
	info := map[string]any{"type": "debug_mirror", "requestId": req.RequestID}
	info["gatewayBase"] = gatewayBaseURL(d)
	d.configMu.RLock()
	info["configGateway"] = d.config.GatewayURL
	d.configMu.RUnlock()
	st := d.updateChecker()
	st.mu.Lock()
	info["available"] = st.available
	info["current"] = daemonVersion
	st.mu.Unlock()
	// What would fetchLauncherTo download? HEAD the first candidate.
	sl := d.slots()
	asset := "indirect-launcher-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	var bases []string
	if gb := gatewayBaseURL(d); gb != "" {
		bases = append(bases, strings.TrimRight(gb, "/")+"/r/")
	}
	if raw := os.Getenv("INDIRECT_REPO_RAW"); raw != "" {
		bases = append(bases, strings.TrimRight(raw, "/")+"/")
	} else if mu := manifestURL(); mu != "" {
		bases = append(bases, mu[:len(mu)-len(updateManifestFile)])
	}
	info["asset"] = asset
	info["bases"] = bases
	if len(bases) > 0 {
		u := fmt.Sprintf("%s%s?u=dbg-%d", bases[0], asset, time.Now().Unix())
		info["url"] = u
		client := &http.Client{Timeout: 30 * time.Second}
		if resp, err := client.Get(u); err != nil {
			info["fetchErr"] = err.Error()
		} else {
			defer resp.Body.Close()
			info["status"] = resp.StatusCode
			head := make([]byte, 64)
			n, _ := resp.Body.Read(head)
			info["head"] = fmt.Sprintf("%x", head[:n])
			info["headLen"] = n
		}
	}
	_ = sl
	_ = d.sendWS(info)
}
