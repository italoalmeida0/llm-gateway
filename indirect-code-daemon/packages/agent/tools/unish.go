package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

// Unish is a cross-platform bash-like shell (unish -c "...") published at
// https://github.com/italoalmeida0/unish/releases with prebuilt binaries
// for linux/macos/windows on amd64+arm64. The daemon keeps a managed copy
// under <dataDir>/bin and auto-updates it from the releases (see
// EnsureUnish). It sits in the middle of the terminal chain:
//
//	unix (linux/macos): bash -> unish -> zsh -> sh -> daemon refuses to start
//	windows:            unish -> daemon refuses to start
//
// Every candidate is probe-executed before use: a binary that merely exists
// but cannot run (wrong arch, corrupt download) is never selected.
const unishRepo = "italoalmeida0/unish"

const unishReleasesAPI = "https://api.github.com/repos/italoalmeida0/unish/releases/latest"

const unishLatestPage = "https://github.com/italoalmeida0/unish/releases/latest"

// Stubbable seams for tests (no network in unit tests).
var (
	unishLatestTagFunc = latestUnishTag
	unishDownloadFunc  = downloadUnish
)

// UnishAssetName maps GOOS/GOARCH to the release asset name, e.g.
// "unish-linux-amd64", "unish-macos-arm64", "unish-windows-amd64.exe".
func UnishAssetName(goos, goarch string) (string, error) {
	var osPart string
	switch goos {
	case "linux":
		osPart = "linux"
	case "darwin":
		osPart = "macos"
	case "windows":
		osPart = "windows"
	default:
		return "", fmt.Errorf("unish: unsupported OS %q", goos)
	}
	var archPart string
	switch goarch {
	case "amd64":
		archPart = "amd64"
	case "arm64":
		archPart = "arm64"
	default:
		return "", fmt.Errorf("unish: unsupported arch %q", goarch)
	}
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("unish-%s-%s%s", osPart, archPart, ext), nil
}

// UnishBinPath is the managed binary location inside <externalDir>
// (the shared <root>/external dir): <externalDir>/bin/unish[.exe].
func UnishBinPath(dataDir string) string {
	name := "unish"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dataDir, "bin", name)
}

var unishVersionRe = regexp.MustCompile(`v\d+\.\d+\.\d+`)

// ParseUnishVersion extracts the release tag from `unish --version` output
// ("unish v0.1.0"). Returns "" when nothing parseable is found.
func ParseUnishVersion(out string) string {
	return unishVersionRe.FindString(out)
}

// localUnishVersion runs the binary's --version flag. "" means the binary
// is missing, unusable or too old to report a version.
func localUnishVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	return ParseUnishVersion(string(out))
}

// latestUnishTag resolves the newest release tag, trying the GitHub API
// first and the /releases/latest redirect as a fallback.
func latestUnishTag(ctx context.Context) (string, error) {
	if tag, err := latestUnishTagViaAPI(ctx); err == nil {
		return tag, nil
	} else {
		apiErr := err
		if tag, err := latestUnishTagViaRedirect(ctx); err == nil {
			return tag, nil
		}
		return "", apiErr
	}
}

func latestUnishTagViaAPI(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", unishReleasesAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("unish: release API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unish: release API: HTTP %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	var v struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &v); err != nil || v.TagName == "" {
		return "", fmt.Errorf("unish: release API returned no tag")
	}
	return v.TagName, nil
}

func latestUnishTagViaRedirect(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", unishLatestPage, nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("unish: release page: %w", err)
	}
	defer resp.Body.Close()
	// The client followed /releases/latest -> /releases/tag/<tag>.
	parts := strings.Split(strings.Trim(resp.Request.URL.Path, "/"), "/")
	if len(parts) == 0 {
		return "", fmt.Errorf("unish: release page redirect has no tag")
	}
	if tag := ParseUnishVersion(parts[len(parts)-1]); tag != "" {
		return tag, nil
	}
	return "", fmt.Errorf("unish: release page redirect has no tag")
}

// downloadUnish fetches one release asset into dest (same dir, temp +
// rename), verifies its SHA-256 against SHA256SUMS.txt when reachable and
// marks it executable on unix. The checksum fetch is best-effort: when the
// sums file itself is unreachable the binary probe at the end of
// EnsureUnish stays the authoritative validity check.
func downloadUnish(ctx context.Context, tag, asset, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return fmt.Errorf("unish: mkdir bin: %w", err)
	}
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", unishRepo, tag, asset)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("unish: download %s: %w", asset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unish: download %s: HTTP %s", asset, resp.Status)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), "unish-download-*")
	if err != nil {
		return fmt.Errorf("unish: temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, 64<<20))
	if cerr := tmp.Close(); cerr != nil && err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("unish: download %s: %w", asset, err)
	}
	if n == 0 {
		return fmt.Errorf("unish: download %s: empty body", asset)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if err := verifyUnishChecksum(ctx, tag, asset, sum); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, 0o755); err != nil {
			return fmt.Errorf("unish: chmod: %w", err)
		}
	}
	if err := os.Rename(tmpName, dest); err != nil {
		// Windows refuses to replace an in-use .exe: remove first, then
		// move. If the old binary is locked by a running daemon the
		// remove fails and we surface a clear error instead of a
		// cryptic rename failure.
		if rerr := os.Remove(dest); rerr != nil && !os.IsNotExist(rerr) {
			return fmt.Errorf("unish: install: %w (remove: %v)", err, rerr)
		}
		if err := os.Rename(tmpName, dest); err != nil {
			return fmt.Errorf("unish: install: %w", err)
		}
	}
	return nil
}

// verifyUnishChecksum compares the downloaded bytes against the release's
// SHA256SUMS.txt. Unreachable sums file = skip (probe decides); mismatch =
// hard error.
func verifyUnishChecksum(ctx context.Context, tag, asset, sum string) error {
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s/SHA256SUMS.txt", unishRepo, tag)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[SHELL] unish: checksum file unreachable (%v), skipping verification\n", err)
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Printf("[SHELL] unish: checksum file HTTP %s, skipping verification\n", resp.Status)
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[1] == asset || strings.HasSuffix(fields[1], "/"+asset) {
			if !strings.EqualFold(fields[0], sum) {
				return fmt.Errorf("unish: checksum mismatch for %s", asset)
			}
			return nil
		}
	}
	fmt.Printf("[SHELL] unish: no checksum entry for %s, skipping verification\n", asset)
	return nil
}

func displayVer(v string) string {
	if v == "" {
		return "(unknown)"
	}
	return v
}

// EnsureUnish guarantees a usable managed unish binary at
// <externalDir>/bin/unish[.exe], downloading or re-downloading it from the
// unish releases when needed:
//
//  1. no local binary -> download the latest release;
//  2. local version (--version) differs from the release -> download;
//  3. same version but the binary fails its probe (invalid binary) ->
//     download again, probe once more;
//
// A still-invalid binary or a failed download is an error so the caller
// falls through to the next shell in the chain. When the release tag
// cannot be resolved (offline), the valid local copy is used as-is.
func EnsureUnish(dataDir string) (string, error) {
	asset, err := UnishAssetName(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	dest := UnishBinPath(dataDir)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	local := ""
	if isExecutableFile(dest) {
		local = localUnishVersion(dest)
	}
	latest, tagErr := unishLatestTagFunc(ctx)
	if tagErr != nil {
		fmt.Printf("Warning: could not check latest shell release (%v); using local copy.\n", tagErr)
	}
	if !isExecutableFile(dest) {
		if tagErr != nil {
			return "", fmt.Errorf("unish: no local binary and release check failed: %v", tagErr)
		}
		fmt.Printf("Downloading shell %s ... ", latest)
		if err := unishDownloadFunc(ctx, latest, asset, dest); err != nil {
			fmt.Println("FAILED")
			return "", err
		}
		fmt.Println("done")
		local = localUnishVersion(dest)
	} else if tagErr == nil && local != latest {
		fmt.Printf("Updating shell %s -> %s ... ", displayVer(local), latest)
		if err := unishDownloadFunc(ctx, latest, asset, dest); err != nil {
			fmt.Println("FAILED")
			return "", err
		}
		fmt.Println("done")
		local = localUnishVersion(dest)
	}
	if probeShellPath(dest, "-c") {
		return dest, nil
	}
	fmt.Printf("Warning: shell binary failed its probe, re-downloading ...\n")
	if tagErr != nil {
		return "", fmt.Errorf("unish: binary invalid and release check unavailable")
	}
	if tag, err := unishLatestTagFunc(ctx); err == nil {
		latest = tag
	}
	if err := unishDownloadFunc(ctx, latest, asset, dest); err != nil {
		return "", err
	}
	_ = local
	if probeShellPath(dest, "-c") {
		return dest, nil
	}
	return "", fmt.Errorf("unish: downloaded binary still invalid")
}

// EnsureShell probes the terminal chain for this OS and pins the winner for
// the whole process (see SetShellOverride), so every BashTool command uses
// the verified shell. Unix: bash -> unish -> zsh -> sh. Windows: unish
// only. An error means nothing on this host can run terminal commands —
// the daemon must refuse to start.
func EnsureShell(dataDir string) error {
	if runtime.GOOS == "windows" {
		path, err := EnsureUnish(dataDir)
		if err != nil {
			return fmt.Errorf("no usable terminal on Windows (unish unavailable: %v)", err)
		}
		SetShellOverride(path, "-c", true)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	if probeShellPath("/bin/bash", "-c") {
		SetShellOverride("/bin/bash", "-c", true)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	if p, err := exec.LookPath("bash"); err == nil && probeShellPath(p, "-c") {
		SetShellOverride(p, "-c", true)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	if upath, err := EnsureUnish(dataDir); err == nil {
		SetShellOverride(upath, "-c", true)
		// shell pinned (silent; visible in the dashboard).
		return nil
	} else {
		fmt.Printf("Warning: managed shell unavailable (%v), trying zsh/sh.\n", err)
	}
	if p, err := exec.LookPath("zsh"); err == nil && probeShellPath(p, "-c") {
		SetShellOverride(p, "-c", false)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	if probeShellPath("/bin/sh", "-c") {
		SetShellOverride("/bin/sh", "-c", false)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	if p, err := exec.LookPath("sh"); err == nil && probeShellPath(p, "-c") {
		SetShellOverride(p, "-c", false)
		// shell pinned (silent; visible in the dashboard).
		return nil
	}
	return fmt.Errorf("no usable terminal (probed bash, unish, zsh and sh — none executed)")
}

// ShellAvailable reports whether this process has a usable shell (the
// startup-pinned one, or a probed fallback).
func ShellAvailable() bool {
	return currentShell().path != ""
}
