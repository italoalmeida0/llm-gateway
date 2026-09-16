package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestUnishAssetName(t *testing.T) {
	cases := map[string]string{
		"linux/amd64":   "unish-linux-amd64",
		"linux/arm64":   "unish-linux-arm64",
		"darwin/amd64":  "unish-macos-amd64",
		"darwin/arm64":  "unish-macos-arm64",
		"windows/amd64": "unish-windows-amd64.exe",
		"windows/arm64": "unish-windows-arm64.exe",
	}
	for plat, want := range cases {
		var goos, goarch string
		for i := 0; i < len(plat); i++ {
			if plat[i] == '/' {
				goos, goarch = plat[:i], plat[i+1:]
			}
		}
		got, err := UnishAssetName(goos, goarch)
		if err != nil || got != want {
			t.Fatalf("%s: got %q,%v want %q", plat, got, err, want)
		}
	}
	if _, err := UnishAssetName("plan9", "amd64"); err == nil {
		t.Fatal("want error for unsupported OS")
	}
}

func TestParseUnishVersion(t *testing.T) {
	if got := ParseUnishVersion("unish v0.1.0\n"); got != "v0.1.0" {
		t.Fatalf("got %q", got)
	}
	if got := ParseUnishVersion("garbage"); got != "" {
		t.Fatalf("got %q", got)
	}
}

// TestEnsureUnishDownloadsWhenMissing stubs the network: no binary + a
// newer release tag must trigger exactly one download, and the "downloaded"
// binary is a shell script so the final probe passes for real.
func TestEnsureUnishDownloadsWhenMissing(t *testing.T) {
	oldTag, oldDl := unishLatestTagFunc, unishDownloadFunc
	defer func() { unishLatestTagFunc, unishDownloadFunc = oldTag, oldDl }()

	dataDir := t.TempDir()
	asset, err := UnishAssetName("linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	downloads := 0
	unishLatestTagFunc = func(ctx context.Context) (string, error) { return "v9.9.9", nil }
	unishDownloadFunc = func(ctx context.Context, tag, a, dest string) error {
		downloads++
		if tag != "v9.9.9" || a != asset {
			t.Fatalf("download(%q,%q)", tag, a)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			t.Fatal(err)
		}
		script := "#!/bin/sh\necho shell-probe-ok\n"
		if err := os.WriteFile(dest, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		return nil
	}
	got, err := EnsureUnish(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if downloads != 1 {
		t.Fatalf("want 1 download, got %d", downloads)
	}
	if got != UnishBinPath(dataDir) {
		t.Fatalf("got %q", got)
	}
}

// TestEnsureUnishUpdatesOnVersionMismatch: a valid local binary whose
// --version differs from the release must be re-downloaded.
func TestEnsureUnishUpdatesOnVersionMismatch(t *testing.T) {
	oldTag, oldDl := unishLatestTagFunc, unishDownloadFunc
	defer func() { unishLatestTagFunc, unishDownloadFunc = oldTag, oldDl }()

	dataDir := t.TempDir()
	dest := UnishBinPath(dataDir)
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		t.Fatal(err)
	}
	// Fake local binary: --version prints v0.0.1, -c probes pass.
	stub := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"unish v0.0.1\"; else echo shell-probe-ok; fi\n"
	if err := os.WriteFile(dest, []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	downloads := 0
	unishLatestTagFunc = func(ctx context.Context) (string, error) { return "v0.1.0", nil }
	unishDownloadFunc = func(ctx context.Context, tag, asset, d string) error {
		downloads++
		if err := os.MkdirAll(filepath.Dir(d), 0o700); err != nil {
			t.Fatal(err)
		}
		script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"unish v0.1.0\"; else echo shell-probe-ok; fi\n"
		if err := os.WriteFile(d, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		return nil
	}
	if _, err := EnsureUnish(dataDir); err != nil {
		t.Fatal(err)
	}
	if downloads != 1 {
		t.Fatalf("want 1 update download, got %d", downloads)
	}
}

// TestEnsureUnishRedownloadsInvalidBinary: same version but failing probe
// must trigger a re-download; a still-invalid binary is an error.
func TestEnsureUnishRedownloadsInvalidBinary(t *testing.T) {
	oldTag, oldDl := unishLatestTagFunc, unishDownloadFunc
	defer func() { unishLatestTagFunc, unishDownloadFunc = oldTag, oldDl }()

	dataDir := t.TempDir()
	dest := UnishBinPath(dataDir)
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		t.Fatal(err)
	}
	// Reports the release version but can never execute a command.
	if err := os.WriteFile(dest, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"unish v0.1.0\"; else exit 126; fi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	unishLatestTagFunc = func(ctx context.Context) (string, error) { return "v0.1.0", nil }
	unishDownloadFunc = func(ctx context.Context, tag, asset, d string) error {
		// "Re-download" the same broken binary.
		return nil
	}
	if _, err := EnsureUnish(dataDir); err == nil {
		t.Fatal("want error for still-invalid binary")
	}
}

// TestEnsureShellFailsClosed: when nothing probes (no bash/zsh/sh, unish
// download fails), EnsureShell must error so the daemon refuses to start.
func TestEnsureShellFailsClosed(t *testing.T) {
	oldTag, oldDl := unishLatestTagFunc, unishDownloadFunc
	defer func() { unishLatestTagFunc, unishDownloadFunc = oldTag, oldDl }()

	unishLatestTagFunc = func(ctx context.Context) (string, error) { return "v0.1.0", nil }
	unishDownloadFunc = func(ctx context.Context, tag, asset, dest string) error {
		return errors.New("offline")
	}
	// Point PATH at an empty dir so LookPath finds nothing; /bin/bash and
	// /bin/sh probes depend on the host — if they pass there IS a shell
	// and EnsureShell succeeding is correct. The assertion below only
	// applies when the host truly has nothing usable.
	t.Setenv("PATH", t.TempDir())
	ClearShellOverride()
	defer ClearShellOverride()
	err := EnsureShell(t.TempDir())
	hasSysShell := probeShellPath("/bin/bash", "-c") || probeShellPath("/bin/sh", "-c")
	if !hasSysShell && err == nil {
		t.Fatal("want error when no shell is usable")
	}
	if hasSysShell && err != nil {
		t.Fatalf("host has a shell but EnsureShell failed: %v", err)
	}
}
