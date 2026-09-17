package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
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
	// daemonReleaseBase is overridden at build time (-ldflags) or via
	// INDIRECT_REPO_RAW; defaults to the public release mirror.
	defaultReleaseBase = "https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist"
	// daemonPinnedVersion is overridden at build time (-ldflags
	// -X main.daemonPinnedVersion=vX.Y.Z). Empty = latest asset name
	// (no pin; checksum still verified against SHA256SUMS.txt).
	daemonPinnedVersion = ""
)

// releaseBase resolves the download mirror.
func releaseBase() string {
	if v := os.Getenv("INDIRECT_REPO_RAW"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultReleaseBase
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

// resolveDaemon ensures a daemon binary exists locally and returns its
// path. Pinned builds use the pin; otherwise the newest staged
// daemon-<version> wins (update restarts land here), falling back to a
// fresh "latest" download.
func resolveDaemon(dataDir string) (string, error) {
	binDir := filepath.Join(dataDir, "bin")
	if daemonPinnedVersion != "" {
		return resolvePinned(binDir, daemonPinnedVersion)
	}
	if best := newestStaged(binDir); best != "" {
		return best, nil
	}
	return resolvePinned(binDir, "latest")
}

// newestStaged picks the highest-version staged daemon binary.
func newestStaged(binDir string) string {
	entries, err := os.ReadDir(binDir)
	if err != nil {
		return ""
	}
	var best, bestVer string
	for _, e := range entries {
		name := e.Name()
		if !e.IsDir() || len(name) < 8 || name[:7] != "daemon-" {
			continue
		}
		ver := name[7:]
		local := filepath.Join(binDir, name, daemonAssetName())
		if runtime.GOOS == "windows" {
			local = filepath.Join(binDir, name, "indirect-code.exe")
		}
		st, err := os.Stat(local)
		if err != nil || st.IsDir() || st.Size() == 0 {
			continue
		}
		if best == "" || compareVersions(ver, bestVer) > 0 {
			best, bestVer = local, ver
		}
	}
	return best
}

// compareVersions orders dotted versions ("latest" sorts below any real
// version; non-semver compares lexically).
func compareVersions(a, b string) int {
	if a == b {
		return 0
	}
	if a == "latest" {
		return -1
	}
	if b == "latest" {
		return 1
	}
	pa, pb := splitVer(a), splitVer(b)
	for i := 0; i < len(pa) && i < len(pb); i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	if len(pa) < len(pb) {
		return -1
	}
	if len(pa) > len(pb) {
		return 1
	}
	if a < b {
		return -1
	}
	return 1
}

func splitVer(v string) []int {
	v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
	var out []int
	for _, p := range strings.Split(v, ".") {
		n := 0
		for _, c := range p {
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
		}
		out = append(out, n)
	}
	return out
}

func resolvePinned(binDir, version string) (string, error) {
	daemonDir := filepath.Join(binDir, "daemon-"+version)
	asset := daemonAssetName()
	local := filepath.Join(daemonDir, asset)
	if runtime.GOOS == "windows" {
		local = filepath.Join(daemonDir, "indirect-code.exe")
	}
	if st, err := os.Stat(local); err == nil && !st.IsDir() && st.Size() > 0 {
		return local, nil
	}
	if err := downloadDaemon(binDir, daemonDir, asset, local); err != nil {
		return "", err
	}
	return local, nil
}

// downloadDaemon fetches the asset + verifies SHA256 against the
// published SHA256SUMS.txt (best-effort when the sums file is missing:
// download proceeds, verification is skipped with a warning — same
// policy as install.sh).
func downloadDaemon(binDir, daemonDir, asset, local string) error {
	base := releaseBase()
	if err := os.MkdirAll(daemonDir, 0o700); err != nil {
		return err
	}
	fmt.Printf("[FETCH] downloading %s ...\n", asset)
	tmp, err := os.CreateTemp(daemonDir, ".daemon-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := fetchURL(base+"/"+asset, tmp); err != nil {
		tmp.Close()
		return fmt.Errorf("download %s: %w", asset, err)
	}
	tmp.Close()
	if err := verifyChecksum(base, asset, tmpName); err != nil {
		fmt.Printf("[FETCH] warning: %v (continuing)\n", err)
	} else {
		fmt.Printf("[FETCH] checksum OK\n")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, 0o755); err != nil {
			return err
		}
	}
	if err := os.Rename(tmpName, local); err != nil {
		return err
	}
	_ = binDir
	return nil
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

// verifyChecksum checks the file against SHA256SUMS.txt from the mirror.
func verifyChecksum(base, asset, local string) error {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(base + "/SHA256SUMS.txt")
	if err != nil {
		return fmt.Errorf("sums unavailable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("sums HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	var want string
	for _, line := range strings.Split(string(body), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == asset {
			want = f[0]
			break
		}
	}
	if want == "" {
		return fmt.Errorf("no sum for %s", asset)
	}
	f, err := os.Open(local)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("checksum mismatch for %s", asset)
	}
	return nil
}
