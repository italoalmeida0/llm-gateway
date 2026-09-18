package main

import (
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

// Handoff orchestrator (daemon side): full-slot update with late freeze.
//
// Order (user-approved protocol):
//  0. Background: detect (push manifest) + download new launcher to the
//     INACTIVE slot + self-verify (--version). NOTHING pauses yet.
//  1. Freeze (late): only after the launcher is verified. Mutations
//     rejected, WS stays connected, frontend shows loading screen.
//  2. Copy sessions (+ configs) active -> inactive slot.
//  3. Exec new launcher --takeover with slot paths (daemon passes its own
//     pid + active/inactive slot ids). The new launcher: migrates,
//     downloads the new daemon into the inactive slot, verifies
//     (--version), starts it in standby (no WS).
//  4. Old daemon: disconnect WS + die. New daemon: connect, assume,
//     unfreeze (broadcast update_done). Launcher flips `active`, deletes
//     the old slot.
//  5. Any failure before step 4: delete inactive slot, UNFREEZE (no WS
//     reconnect needed — it never dropped), broadcast update_failed.
//
// Queue-not-reject: prompts arriving while frozen are parked in the
// session queue and delivered after unfreeze/handoff.

// slotLayout resolves active/inactive slot dirs under <dataDir>/slots.
type slotLayout struct {
	base     string
	active   string // "a" or "b"
	inactive string
}

func (d *DaemonServer) slots() slotLayout {
	// Single-slot legacy (no slots dir yet): active = dataDir itself.
	active := "a"
	if raw, err := os.ReadFile(filepath.Join(d.dataDir, "slots", "active")); err == nil {
		if s := strings.TrimSpace(string(raw)); s == "a" || s == "b" {
			active = s
		}
	}
	inactive := "b"
	if active == "b" {
		inactive = "a"
	}
	return slotLayout{base: filepath.Join(d.dataDir, "slots"), active: active, inactive: inactive}
}

func (s slotLayout) dir(which string) string {
	return filepath.Join(s.base, "slot-"+which)
}

// legacySlotDir is used when slots/ doesn't exist yet: the dataDir IS
// slot "a" (bin/, sessions/, ... at top level).
func (d *DaemonServer) slotDir(which string) string {
	sl := d.slots()
	if _, err := os.Stat(sl.base); os.IsNotExist(err) && which == sl.active {
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
	if st.handoffBusy || st.frozen {
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
	if st.mismatchWant == version && time.Now().UnixMilli()-st.mismatchAt < 30*60*1000 {
		// Same target failed verify <30min ago (mirror serving stale
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

// runHandoff executes the 5 phases. Any error before promote → cleanup +
// unfreeze + update_failed broadcast.
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
	sl := d.slots()
	inactiveDir := d.slotDir(sl.inactive)
	// Phase 0: download new launcher into inactive slot + self-verify.
	// (Background: user untouched, nothing frozen.)
	launcherPath, err := d.fetchLauncherTo(version, sl)
	if err != nil {
		fail(fmt.Sprintf("launcher download: %v", err))
		return
	}
	if err := selfVerifyBinary(launcherPath, version, "launcher"); err != nil {
		d.recordMismatch(version, extractGotVersion(err))
		fail(fmt.Sprintf("launcher verify: %v", err))
		return
	}
	// Phase 1: quiesce (commit WALs, close handles, cancel turns) THEN
	// LATE freeze. Copying a live session dir races appends; quiesced
	// state is stable. Running turns are cancelled with full WAL commit
	// (same as graceful shutdown) — resumable history, no loss.
	d.quiesceSessions()
	// Phase 1b: LATE freeze (only now — download could have failed).
	d.setFrozen(true, "copying sessions")
	// Phase 2: copy sessions (+ configs) to inactive slot.
	if err := d.copyToSlot(sl, inactiveDir); err != nil {
		fail(fmt.Sprintf("copy sessions: %v", err))
		return
	}
	// Phase 3: exec new launcher --takeover. It migrates, fetches the new
	// daemon, verifies, starts it in standby, and signals us back via
	// exit code + a handoff file. WE WAIT (frozen, WS connected).
	d.setFrozen(true, "preparing update")
	if err := d.execTakeover(launcherPath, sl, version); err != nil {
		fail(fmt.Sprintf("takeover: %v", err))
		return
	}
	// Phase 4 happens in the new launcher/daemon (promote). If WE are
	// still alive after execTakeover returned success, the new side
	// failed to promote within timeout → unfreeze handled by fail() in
	// execTakeover paths. Reaching here means promote confirmed: the old
	// daemon disconnects WS + exits (the new one serves from here on).
	_ = inactiveDir
	d.gracefulShutdown("[HANDOFF] promoted to " + version)
}

// abortHandoff: delete inactive slot, unfreeze (WS never dropped — no
// reconnect needed), notify frontend.
func (d *DaemonServer) abortHandoff(reason string) {
	sl := d.slots()
	_ = os.RemoveAll(d.slotDir(sl.inactive))
	d.setFrozen(false, "")
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
	// Already there + verified? Reuse (idempotent retry).
	if st, err := os.Stat(local); err == nil && !st.IsDir() && st.Size() > 0 {
		return local, nil
	}
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
	// Dual publish (see takeover_help.go): versioned URL first (immutable),
	// floating fallback (may be stale; self-verify decides).
	verAsset := asset + "-v" + version
	if runtime.GOOS == "windows" {
		verAsset = "indirect-launcher-" + runtime.GOOS + "-" + runtime.GOARCH + "-v" + version + ".exe"
	}
	var candidates []string
	for _, b := range bases {
		candidates = append(candidates,
			fmt.Sprintf("%s%s?u=%s-%d", b, verAsset, version, time.Now().Unix()),
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

// copyToSlot copies sessions (+ small configs) active -> inactive.
// Uses hardlinks when possible (instant, CoW-safe: all our writes are
// tmp+rename), plain copy fallback otherwise. The sessions source is the
// daemon's live sessionsDir (active slot once slots/ exist, legacy dir
// otherwise) — never slotDir(active) blindly, which resolves to the
// legacy dir in pre-slot installs and would copy nothing.
func (d *DaemonServer) copyToSlot(sl slotLayout, inactiveDir string) error {
	src := d.slotDir(sl.active)
	srcSessions := d.sessionsDir()
	// Sessions first: sourced from the live sessionsDir (slot-aware).
	if s, err := os.Stat(srcSessions); err == nil && s.IsDir() {
		if err := copyDirLink(filepath.Dir(srcSessions), filepath.Join(inactiveDir, "sessions"), "sessions"); err != nil {
			return fmt.Errorf("copy sessions: %w", err)
		}
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, name := range []string{"projects.json", "config.json"} {
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
// Windows without privilege).
func copyFileLink(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	if err := os.Link(src, dst); err == nil {
		return nil
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

// execTakeover runs the new launcher --takeover and waits for the handoff
// result (promote confirmed or failure). Timeout -> failure.
func (d *DaemonServer) execTakeover(launcherPath string, sl slotLayout, version string) error {
	handoffFile := filepath.Join(d.slotDir(sl.inactive), "handoff.json")
	_ = os.Remove(handoffFile)
	// Pre-flight: the downloaded launcher must identify as the expected
	// version (stale cache serving an OLD launcher without --takeover
	// support dies with a bare exit code and no handoff file — exactly
	// the mystery "exit status 1". Catch it here with a clear message.
	if err := selfVerifyBinary(launcherPath, version, "launcher"); err != nil {
		return fmt.Errorf("launcher pre-flight: %w", err)
	}
	cmd := exec.Command(launcherPath,
		"--takeover",
		"--data-dir", d.dataDir,
		"--from-slot", sl.active,
		"--to-slot", sl.inactive,
		"--expect-version", version,
		"--handoff-file", handoffFile,
		"--parent-pid", fmt.Sprint(os.Getpid()),
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Takeover downloads from OUR gateway (instant, no CDN): pass it down
	// so the new launcher never touches GitHub. Falls back to GitHub raw
	// only when the gateway is unreachable (same rule as manifest fetch).
	cmd.Env = append(os.Environ(), "INDIRECT_GATEWAY="+gatewayBaseURL(d))
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	timeout := time.After(10 * time.Minute)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case err := <-done:
			// Launcher exited: read handoff result.
			return readHandoffResult(handoffFile, err)
		case <-timeout:
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			return fmt.Errorf("takeover timed out")
		case <-ticker.C:
			if res, ok := readHandoffReady(handoffFile); ok {
				if res {
					return nil // promoted
				}
				return fmt.Errorf("takeover refused by new launcher")
			}
		}
	}
}

func readHandoffResult(path string, runErr error) error {
	if ok, done := readHandoffReady(path); done {
		if ok {
			return nil
		}
		return fmt.Errorf("takeover failed (see new launcher log)")
	}
	if runErr != nil {
		return fmt.Errorf("takeover launcher: %w", runErr)
	}
	return fmt.Errorf("takeover launcher exited without result")
}

func readHandoffReady(path string) (bool, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, false
	}
	s := strings.TrimSpace(string(raw))
	if s == "promoted" {
		return true, true
	}
	if strings.HasPrefix(s, "failed") {
		return false, true
	}
	return false, false
}
