package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Self-managed daemon binary: the launcher (installed as the user-facing
// `indirect-code`) fetches and pins the real daemon version. Updates never
// require re-running install.sh — the launcher re-resolves on every start
// (cached, checksum-verified).
//
// Layout inside <dataDir>/bin:
//   indirect-code          -> the launcher itself (this binary, copied by installer)
//   daemon-<version>/      -> per-version daemon dir (atomic switch)
//     indirect-code[-exe]
//   daemon-current         -> symlink (unix) or version file (windows) to active version

const (
	// No GitHub fallback by design (gateway-first updates/installs).
	// Order: INDIRECT_REPO_RAW env > INDIRECT_GATEWAY (gateway dist/) >
	// error. Install scripts always derive the gateway from CONNECT_URL.
	defaultReleaseBase = ""
	// daemonPinnedVersion is overridden at build time (-ldflags
	// -X main.daemonPinnedVersion=vX.Y.Z). Empty = latest asset name
	// (no pin; checksum still verified against SHA256SUMS.txt).
	daemonPinnedVersion = ""
)

// releaseBase resolves the download mirror.
func releaseBase() string {
	return mirrorBase()
}

// daemonAssetName is the platform asset, e.g. indirect-code-linux-amd64.
func daemonAssetName() string {
	goos, goarch := runtime.GOOS, runtime.GOARCH
	name := "indirect-code-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// isInsideSlotDir reports whether dir is (or is inside) a slots/slot-x
// dir. Running with such a dataDir would nest slots/ inside slots/ —
// refuse instead (see main.go guard).
func isInsideSlotDir(dir string) bool {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	parts := strings.Split(filepath.Clean(abs), string(os.PathSeparator))
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "slots" && (parts[i+1] == "slot-a" || parts[i+1] == "slot-b") {
			return true
		}
	}
	return false
}

// resolveSlotDaemon resolves the daemon binary for normal boot:
// ensureLayout first (repairs broken installs), then the active slot's
// bin. First-ever boot (no slots/): self-install slot-a (copy launcher
// binary, download daemon latest, write active) then resolve.
// Repair notes from ensureLayout are returned so the caller prints one
// summary line (fetch.go itself stays quiet: it runs inside the
// "Preparing ... done" step).
func resolveSlotDaemon(dataDir string) (string, string, []string, error) {
	repairNotes, err := ensureLayout(dataDir)
	if err != nil {
		return "", "", nil, err
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "slots", "active"))
	if err != nil {
		if !os.IsNotExist(err) {
			return "", "", repairNotes, err
		}
		if err := installSlotA(dataDir); err != nil {
			return "", "", repairNotes, err
		}
		raw, err = os.ReadFile(filepath.Join(dataDir, "slots", "active"))
		if err != nil {
			return "", "", repairNotes, err
		}
	}
	slot := ""
	for _, c := range strings.TrimSpace(string(raw)) {
		if c == 'a' || c == 'b' {
			slot = string(c)
			break
		}
	}
	if slot == "" {
		return "", "", repairNotes, fmt.Errorf("slots/active corrupt")
	}
	slotDir := filepath.Join(dataDir, "slots", "slot-"+slot)
	binDir := filepath.Join(slotDir, "bin")
	local := filepath.Join(binDir, slotBinName())

	needDownload := false
	if st, err := os.Stat(local); err != nil || st.IsDir() || st.Size() == 0 {
		needDownload = true
	} else if launcherVersion != "dev" && launcherVersion != "" {
		if err := selfVerifyDaemon(local, launcherVersion); err != nil {
			needDownload = true
		}
	}

	if needDownload {
		targetVer := launcherVersion
		if ver, _, err := latestDaemonAsset(); err == nil && ver != "" {
			targetVer = ver
		}
		fmt.Printf("Downloading daemon %s ... ", targetVer)
		dlPath, err := fetchDaemonTo(slotDir, targetVer)
		if err != nil {
			fmt.Println("FAILED")
			if st, serr := os.Stat(local); serr == nil && !st.IsDir() && st.Size() > 0 {
				fmt.Printf("Warning: cannot download latest daemon (%v), using existing binary\n", err)
				return local, slot, repairNotes, nil
			}
			return "", "", repairNotes, fmt.Errorf("slot %s daemon unavailable: %w", slot, err)
		}
		local = dlPath
		fmt.Println("done")
		verifyVer := targetVer
		if verifyVer == "dev" {
			verifyVer = ""
		}
		if err := selfVerifyDaemon(local, verifyVer); err != nil {
			fmt.Printf("Warning: downloaded daemon self-verify: %v\n", err)
		}
	}

	if exe, err := os.Executable(); err == nil {
		slotLauncher := filepath.Join(binDir, slotLauncherName())
		if st, serr := os.Stat(slotLauncher); serr != nil || st.Size() == 0 {
			_ = copyFileLink(exe, slotLauncher)
		}
	}

	return local, slot, repairNotes, nil
}

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

// installSlotA bootstraps slots/ on first-ever boot: copies THIS launcher
// binary into slot-a/bin, downloads the latest daemon into slot-a/bin,
// self-verifies both via --version, writes slots/active=a.
// Stray top-level sessions/ was already adopted by ensureLayout (which
// runs before this); the move below is a second net for the exact
// first-boot interleaving.
func installSlotA(dataDir string) error {
	slotsDir := filepath.Join(dataDir, "slots")
	slotA := filepath.Join(slotsDir, "slot-a")
	binDir := filepath.Join(slotA, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return err
	}
	// 1. Copy own binary (the running launcher) into the slot.
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("own binary: %w", err)
	}
	launcherName := slotLauncherName()
	if err := copyFileLink(exe, filepath.Join(binDir, launcherName)); err != nil {
		return fmt.Errorf("install launcher: %w", err)
	}
	// 2. Download latest daemon (version resolved from manifest or launcherVersion).
	targetVer := launcherVersion
	if ver, _, err := latestDaemonAsset(); err == nil && ver != "" {
		targetVer = ver
	}
	local, err := fetchDaemonTo(slotA, targetVer)
	if err != nil {
		return fmt.Errorf("download daemon: %w", err)
	}
	// 3. Self-verify both.
	if err := selfVerifyLauncher(filepath.Join(binDir, launcherName), ""); err != nil {
		return fmt.Errorf("self verify launcher: %w", err)
	}
	verifyVer := targetVer
	if verifyVer == "dev" {
		verifyVer = ""
	}
	if err := selfVerifyDaemon(local, verifyVer); err != nil {
		return fmt.Errorf("self verify daemon: %w", err)
	}
	// 4. Adopt stray sessions/ (rename, instant) when present.
	if _, err := os.Stat(filepath.Join(dataDir, "sessions")); err == nil {
		if _, err := os.Stat(filepath.Join(slotA, "sessions")); os.IsNotExist(err) {
			if err := os.Rename(filepath.Join(dataDir, "sessions"), filepath.Join(slotA, "sessions")); err != nil {
				return fmt.Errorf("adopt sessions: %w", err)
			}
		}
	}
	// 5. Flip active.
	if err := os.MkdirAll(slotsDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(slotsDir, "active"), []byte("a\n"), 0o600)
}

// mirrorBase resolves the release mirror: explicit env override first,
// then the gateway that spawned us (INDIRECT_GATEWAY, set by the daemon
// on takeover — the gateway serves dist/ itself, no CDN cache), or derived
// from -connect flag or config.json.
func mirrorBase() string {
	if v := os.Getenv("INDIRECT_REPO_RAW"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if v := os.Getenv("INDIRECT_GATEWAY"); v != "" {
		return strings.TrimRight(v, "/") + "/r"
	}
	// Check -connect flag in os.Args
	for i, a := range os.Args {
		if (a == "-connect" || a == "--connect") && i+1 < len(os.Args) {
			if u, err := url.Parse(os.Args[i+1]); err == nil && u.Scheme != "" && u.Host != "" {
				return fmt.Sprintf("%s://%s/r", u.Scheme, u.Host)
			}
		}
		if strings.HasPrefix(a, "-connect=") || strings.HasPrefix(a, "--connect=") {
			parts := strings.SplitN(a, "=", 2)
			if u, err := url.Parse(parts[1]); err == nil && u.Scheme != "" && u.Host != "" {
				return fmt.Sprintf("%s://%s/r", u.Scheme, u.Host)
			}
		}
	}
	// Check saved config.json: slot-local first (canonical), then the
	// default root (this machine's real install — tests override HOME).
	home, _ := os.UserHomeDir()
	cfgPaths := []string{
		filepath.Join(defaultDataDir(), "slots", "slot-a", "config.json"),
		filepath.Join(defaultDataDir(), "slots", "slot-b", "config.json"),
		filepath.Join(defaultDataDir(), "config.json"),
	}
	for i, a := range os.Args {
		if (a == "-data-dir" || a == "--data-dir") && i+1 < len(os.Args) {
			cfgPaths = append([]string{filepath.Join(os.Args[i+1], "config.json")}, cfgPaths...)
		}
		if strings.HasPrefix(a, "-data-dir=") || strings.HasPrefix(a, "--data-dir=") {
			parts := strings.SplitN(a, "=", 2)
			cfgPaths = append([]string{filepath.Join(parts[1], "config.json")}, cfgPaths...)
		}
	}
	if home != "" {
		cfgPaths = append(cfgPaths,
			filepath.Join(home, ".indirect-code", "slots", "slot-a", "config.json"),
			filepath.Join(home, ".indirect-code", "slots", "slot-b", "config.json"),
			filepath.Join(home, ".indirect-code", "config.json"))
	}
	for _, cp := range cfgPaths {
		if data, err := os.ReadFile(cp); err == nil {
			var cfg struct {
				GatewayURL string `json:"gateway_url"`
			}
			if json.Unmarshal(data, &cfg) == nil && cfg.GatewayURL != "" {
				if u, err := url.Parse(cfg.GatewayURL); err == nil && u.Scheme != "" && u.Host != "" {
					return fmt.Sprintf("%s://%s/r", u.Scheme, u.Host)
				}
			}
		}
	}
	return defaultReleaseBase
}

// latestDaemonAsset resolves (version, asset) for this platform from the
// manifest.
func latestDaemonAsset() (string, string, error) {
	m, err := fetchVersionsManifest()
	if err != nil {
		return "", "", err
	}
	key := runtime.GOOS + "-" + runtime.GOARCH
	asset := m.Daemon.Assets[key]
	if asset == "" {
		return "", "", fmt.Errorf("no daemon asset for %s", key)
	}
	return m.Daemon.Version, asset, nil
}

// downloadToMirror fetches url -> local (tmp+rename, executable bit).
func downloadToMirror(url, local string) error {
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(local), ".dl-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := fetchURL(url, tmp); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, 0o755); err != nil {
			return err
		}
	}
	return os.Rename(tmpName, local)
}

// copyFileLink hardlinks (same device) or copies bytes.
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
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

// selfVerifyLauncher runs `bin --version` (empty want = just runs).
func selfVerifyLauncher(path, want string) error {
	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		defer close(done)
		out, runErr = runVersionCmd(path)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		return fmt.Errorf("launcher --version timed out")
	}
	if runErr != nil {
		return fmt.Errorf("launcher --version failed: %v (%s)", runErr, strings.TrimSpace(string(out)))
	}
	if want != "" && !strings.Contains(string(out), want) {
		return fmt.Errorf("launcher version mismatch: want %q, got %q", want, strings.TrimSpace(string(out)))
	}
	return nil
}

// versionManifest mirrors dist/versions.json (daemon + launcher assets).
type versionManifest struct {
	Daemon   releaseAsset `json:"daemon"`
	Launcher releaseAsset `json:"launcher"`
}

type releaseAsset struct {
	Version string            `json:"version"`
	Assets  map[string]string `json:"assets"`
	Sums    map[string]string `json:"sums"`
}

// fetchVersionsManifest downloads + parses versions.json.
func fetchVersionsManifest() (*versionManifest, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	base := mirrorBase()
	if base == "" {
		return nil, fmt.Errorf("no release mirror available (pair a gateway or set INDIRECT_REPO_RAW)")
	}
	resp, err := client.Get(base + "/versions.json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("versions.json HTTP %d", resp.StatusCode)
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
