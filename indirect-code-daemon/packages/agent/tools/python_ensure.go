package tools

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// EnsurePython mirrors the unish strategy (see unish.go) for the python
// tool: before the daemon starts it guarantees a usable Python 3
// interpreter, trying in order:
//
//  1. the managed copy in <dataDir>/python (the Indirect Code folder),
//     auto-installed from python-build-standalone when missing;
//  2. python3/python on PATH (must answer "Python 3." to --version and
//     execute a trivial snippet);
//  3. download the small install_only_stripped standalone build matching
//     this OS/arch into <dataDir>/python and use it.
//
// When nothing works the python tool is DISABLED (not advertised, and
// Execute refuses with "not available") — it never blocks startup. The
// terminal (bash) is the only hard gate: the daemon refuses to start only
// when BOTH the shell chain and python are unavailable, in which case the
// python binary doubles as a last-resort shell via `python3 -c`.
const pythonStandaloneRepo = "astral-sh/python-build-standalone"

const pythonStandaloneAPI = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"

// Pin the newest known-good standalone release. Bumped manually after
// smoke-testing a new tag; "latest" resolution is deliberately NOT used
// here so a bad upstream release can never break daemon startup.
const pythonStandaloneTag = "20260901"

// Pin the CPython minor used for the managed copy.
const pythonStandaloneVersion = "3.12"

var (
	pythonDownloadFunc = downloadPythonStandalone
)

// PythonBinPath is the managed interpreter location inside the daemon data
// dir: <dataDir>/python/bin/python3 (python.exe on Windows).
func PythonBinPath(dataDir string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(dataDir, "python", "python.exe")
	}
	return filepath.Join(dataDir, "python", "bin", "python3")
}

// pythonTriple maps GOOS/GOARCH to the standalone build triple, e.g.
// "x86_64-unknown-linux-gnu" or "aarch64-apple-darwin".
func pythonTriple(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "linux/amd64":
		return "x86_64-unknown-linux-gnu", nil
	case "linux/arm64":
		return "aarch64-unknown-linux-gnu", nil
	case "darwin/amd64":
		return "x86_64-apple-darwin", nil
	case "darwin/arm64":
		return "aarch64-apple-darwin", nil
	case "windows/amd64":
		return "x86_64-pc-windows-msvc", nil
	case "windows/arm64":
		return "aarch64-pc-windows-msvc", nil
	default:
		return "", fmt.Errorf("python: unsupported platform %s/%s", goos, goarch)
	}
}

// probePythonBin runs --version plus a trivial snippet through a candidate
// interpreter: a binary that merely exists but cannot execute (wrong arch,
// corrupt download, Python 2) must NOT be selected.
func probePythonBin(path string) bool {
	if path == "" || !isExecutableFile(path) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return false
	}
	if !strings.HasPrefix(strings.TrimSpace(string(out)), "Python 3.") {
		return false
	}
	out, err = exec.CommandContext(ctx, path, "-c", "print('python-probe-ok')").CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "python-probe-ok")
}

var pythonAssetRe = regexp.MustCompile(`^cpython-(\d+\.\d+\.\d+)\+(\d+)-(.+)-install_only_stripped\.tar\.gz$`)

// latestPythonStandaloneTag resolves the newest standalone release tag via
// the GitHub API (used only to NOTICE a newer release; the pinned tag in
// pythonStandaloneTag is what gets installed).
func latestPythonStandaloneTag(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", pythonStandaloneAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("python: release API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("python: release API: HTTP %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	var v struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &v); err != nil || v.TagName == "" {
		return "", fmt.Errorf("python: release API returned no tag")
	}
	return v.TagName, nil
}

// resolvePythonStandaloneAsset finds the exact asset file name for this
// platform inside the pinned release (fills in the CPython micro version,
// newest wins).
func resolvePythonStandaloneAsset(ctx context.Context, goos, goarch string) (string, error) {
	triple, err := pythonTriple(goos, goarch)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", pythonStandaloneAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("python: release API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("python: release API: HTTP %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	var v struct {
		Assets []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return "", err
	}
	var best string
	for _, a := range v.Assets {
		m := pythonAssetRe.FindStringSubmatch(a.Name)
		if m == nil {
			continue
		}
		if !strings.HasPrefix(m[1], pythonStandaloneVersion+".") || m[2] != pythonStandaloneTag {
			continue
		}
		if m[3] != triple {
			continue
		}
		if a.Name > best {
			best = a.Name
		}
	}
	if best == "" {
		return "", fmt.Errorf("python: no cpython-%s.*+%s asset in release %s", pythonStandaloneVersion, pythonStandaloneTag, pythonStandaloneTag)
	}
	return best, nil
}

// downloadPythonStandalone fetches the pinned standalone tarball and
// extracts it under <dataDir>/python (the archive's top-level "python/"
// dir), then probes the resulting interpreter.
func downloadPythonStandalone(ctx context.Context, dataDir string) (string, error) {
	asset, err := resolvePythonStandaloneAsset(ctx, runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s",
		pythonStandaloneRepo, pythonStandaloneTag, asset)
	fmt.Printf("[PYTHON] no usable interpreter, downloading %s ...\n", asset)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("python: download %s: %w", asset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("python: download %s: HTTP %s", asset, resp.Status)
	}
	dest := filepath.Join(dataDir, "python")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", fmt.Errorf("python: mkdir: %w", err)
	}
	tmp, err := os.MkdirTemp("", "python-standalone-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	if err := extractPythonTarball(io.LimitReader(resp.Body, 256<<20), tmp); err != nil {
		return "", err
	}
	staged := filepath.Join(tmp, "python")
	if st, err := os.Stat(staged); err != nil || !st.IsDir() {
		return "", fmt.Errorf("python: archive has no python/ top dir")
	}
	_ = os.RemoveAll(dest)
	if err := os.Rename(staged, dest); err != nil {
		return "", fmt.Errorf("python: install: %w", err)
	}
	bin := PythonBinPath(dataDir)
	if runtime.GOOS != "windows" {
		_ = os.Chmod(bin, 0o755)
	}
	if !probePythonBin(bin) {
		_ = os.RemoveAll(dest)
		return "", fmt.Errorf("python: downloaded interpreter failed its probe")
	}
	return bin, nil
}

// extractPythonTarball unpacks a .tar.gz safely under dst (no absolute
// paths, no ".." escapes, no symlinks/hardlinks leaving the tree).
func extractPythonTarball(r io.Reader, dst string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return fmt.Errorf("python: gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("python: tar: %w", err)
		}
		name := filepath.Clean(hdr.Name)
		if filepath.IsAbs(name) || strings.HasPrefix(name, "..") {
			return fmt.Errorf("python: unsafe archive entry %q", hdr.Name)
		}
		target := filepath.Join(dst, name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			// Recreate internal symlinks (python3 -> python3.12, plus
			// relative data links like terminfo): resolve the target
			// against the link's dir and require it to stay in-tree.
			if filepath.IsAbs(hdr.Linkname) {
				return fmt.Errorf("python: unsafe symlink %q -> %q", hdr.Name, hdr.Linkname)
			}
			resolved := filepath.Join(filepath.Dir(target), hdr.Linkname)
			if rel, err := filepath.Rel(dst, resolved); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return fmt.Errorf("python: unsafe symlink %q -> %q", hdr.Name, hdr.Linkname)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(hdr.Mode&0o777))
			if err != nil {
				return err
			}
			_, err = io.Copy(f, io.LimitReader(tr, 1<<30))
			cerr := f.Close()
			if err != nil {
				return err
			}
			if cerr != nil {
				return cerr
			}
		default:
			// Skip hardlinks/dev nodes (escape vector); symlinks are
			// handled above since the layout needs them.
		}
	}
}

// EnsurePython guarantees a usable Python 3 interpreter: managed copy in
// the Indirect Code folder first, PATH second, standalone download last.
// Returns the binary path, or an error when nothing works (caller disables
// the python tool but keeps running — python alone never blocks startup).
func EnsurePython(dataDir string) (string, error) {
	if bin := PythonBinPath(dataDir); probePythonBin(bin) {
		return bin, nil
	}
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil && probePythonBin(p) {
			return p, nil
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	bin, err := pythonDownloadFunc(ctx, dataDir)
	if err != nil {
		return "", err
	}
	if !probePythonBin(bin) {
		return "", fmt.Errorf("python: installed interpreter failed its probe")
	}
	return bin, nil
}

// SetPythonOverride pins the interpreter for this process: startup calls it
// once from EnsurePython, so every PythonTool uses the verified binary.
// A non-nil err disables the tool (Execute reports it). Tests use it to
// isolate from the host; ClearPythonOverride restores lazy PATH probing.
func SetPythonOverride(path string, err error) {
	pythonPinMu.Lock()
	defer pythonPinMu.Unlock()
	pythonPinned = true
	pythonPinBin, pythonPinErr = path, err
}

// ClearPythonOverride drops the pinned interpreter (tests only).
func ClearPythonOverride() {
	pythonPinMu.Lock()
	defer pythonPinMu.Unlock()
	pythonPinned = false
	pythonPinBin, pythonPinErr = "", nil
}
