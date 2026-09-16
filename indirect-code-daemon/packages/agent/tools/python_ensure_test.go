package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPythonTriple(t *testing.T) {
	cases := map[string]string{
		"linux/amd64":   "x86_64-unknown-linux-gnu",
		"linux/arm64":   "aarch64-unknown-linux-gnu",
		"darwin/amd64":  "x86_64-apple-darwin",
		"darwin/arm64":  "aarch64-apple-darwin",
		"windows/amd64": "x86_64-pc-windows-msvc",
		"windows/arm64": "aarch64-pc-windows-msvc",
	}
	for plat, want := range cases {
		var goos, goarch string
		for i := 0; i < len(plat); i++ {
			if plat[i] == '/' {
				goos, goarch = plat[:i], plat[i+1:]
			}
		}
		got, err := pythonTriple(goos, goarch)
		if err != nil || got != want {
			t.Fatalf("%s: got %q,%v want %q", plat, got, err, want)
		}
	}
	if _, err := pythonTriple("plan9", "amd64"); err == nil {
		t.Fatal("want error for unsupported platform")
	}
}

func TestPythonAssetRe(t *testing.T) {
	m := pythonAssetRe.FindStringSubmatch("cpython-3.12.14+20260901-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz")
	if m == nil || m[1] != "3.12.14" || m[2] != "20260901" || m[3] != "x86_64-unknown-linux-gnu" {
		t.Fatalf("no match: %v", m)
	}
	if pythonAssetRe.FindString("cpython-3.12.14+20260901-x86_64-unknown-linux-gnu.tar.gz") != "" {
		t.Fatal("must only match install_only_stripped")
	}
}

// managedPythonStub writes an executable stub interpreter into binPath:
// a .sh script on unix, a .bat wrapper on Windows (shell scripts don't
// execute there). version is printed for --version, probeToken for -c.
func managedPythonStub(t *testing.T, binPath, version, probeToken string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(binPath), 0o700); err != nil {
		t.Fatal(err)
	}
	var body string
	if runtime.GOOS == "windows" {
		// Batch: %1 is the first arg. --version prints the version,
		// anything else prints the probe token.
		body = "@echo off\r\nif \"%~1\"==\"--version\" (echo " + version + ") else (echo " + probeToken + ")\r\n"
		if !strings.HasSuffix(strings.ToLower(binPath), ".bat") && !strings.HasSuffix(strings.ToLower(binPath), ".exe") {
			t.Fatalf("windows stub must end in .bat/.exe: %s", binPath)
		}
	} else {
		body = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"" + version + "\"; else echo " + probeToken + "; fi\n"
	}
	if err := os.WriteFile(binPath, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
}
func TestEnsurePythonPrefersManagedCopy(t *testing.T) {
	oldDl := pythonDownloadFunc
	defer func() { pythonDownloadFunc = oldDl }()

	dataDir := t.TempDir()
	bin := PythonBinPath(dataDir)
	if runtime.GOOS == "windows" {
		// Shell scripts don't execute on Windows: stage a .bat stub and
		// point the managed path at it via a copy named python.exe? A
		// batch file can't masquerade as .exe, so exercise probePythonBin
		// directly plus EnsurePython against the system interpreter.
		stub := filepath.Join(dataDir, "stub.bat")
		managedPythonStub(t, stub, "Python 3.12.99", "python-probe-ok")
		if !probePythonBin(stub) {
			t.Fatal("bat stub must probe valid")
		}
		if isExecutableFile(filepath.Join(dataDir, "note.txt")) {
			t.Fatal("plain text must not count as executable")
		}
		_ = bin
		return
	}
	managedPythonStub(t, bin, "Python 3.12.99", "python-probe-ok")
	pythonDownloadFunc = func(ctx context.Context, dir string) (string, error) {
		t.Fatal("must not download when managed copy is valid")
		return "", nil
	}
	got, err := EnsurePython(dataDir)
	if err != nil || got != bin {
		t.Fatalf("got %q,%v", got, err)
	}
}

// TestEnsurePythonDownloadsWhenNothingUsable: no managed copy, empty PATH
// and a stubbed download must produce the downloaded binary.
func TestEnsurePythonDownloadsWhenNothingUsable(t *testing.T) {
	oldDl := pythonDownloadFunc
	defer func() { pythonDownloadFunc = oldDl }()

	dataDir := t.TempDir()
	downloads := 0
	pythonDownloadFunc = func(ctx context.Context, dir string) (string, error) {
		downloads++
		bin := PythonBinPath(dir)
		if runtime.GOOS == "windows" {
			// No stub .exe available: report the download as failed so
			// EnsurePython surfaces the error (covered below).
			return "", errors.New("stub .exe unavailable on windows")
		}
		if err := os.MkdirAll(filepath.Dir(bin), 0o700); err != nil {
			return "", err
		}
		stub := "#!/bin/sh\nif [ \"$1\" = \"-c\" ]; then echo python-probe-ok; else echo \"Python 3.12.1\"; fi\n"
		if err := os.WriteFile(bin, []byte(stub), 0o755); err != nil {
			return "", err
		}
		return bin, nil
	}
	t.Setenv("PATH", t.TempDir())
	if runtime.GOOS == "windows" {
		if _, err := EnsurePython(dataDir); err == nil {
			t.Fatal("want download error on windows without stub exe")
		}
		return
	}
	got, err := EnsurePython(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if downloads != 1 {
		t.Fatalf("want 1 download, got %d", downloads)
	}
	if got != PythonBinPath(dataDir) {
		t.Fatalf("got %q", got)
	}
}

// TestEnsurePythonErrorDisablesTool: a failed download surfaces the error
// so the caller disables the tool instead of starting broken.
func TestEnsurePythonErrorDisablesTool(t *testing.T) {
	oldDl := pythonDownloadFunc
	defer func() { pythonDownloadFunc = oldDl }()

	pythonDownloadFunc = func(ctx context.Context, dir string) (string, error) {
		return "", errors.New("offline")
	}
	t.Setenv("PATH", t.TempDir())
	if _, err := EnsurePython(t.TempDir()); err == nil {
		t.Fatal("want error when nothing provides python")
	} else if !strings.Contains(err.Error(), "offline") {
		t.Fatalf("want download error, got %v", err)
	}
}

// TestPythonToolRefusesWhenDisabled: a pinned error makes Execute fail with
// "unavailable" instead of running anything.
func TestPythonToolRefusesWhenDisabled(t *testing.T) {
	ClearPythonOverride()
	defer ClearPythonOverride()
	SetPythonOverride("", errors.New("no python here"))
	tool := &PythonTool{CWD: t.TempDir(), Sandbox: NewSandbox(t.TempDir())}
	_, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"code": "print(1)"}), nil)
	if err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("want unavailable error, got %v", err)
	}
}

// TestPythonToolUsesPinnedBinary: the startup-pinned interpreter is the one
// that actually runs the code.
func TestPythonToolUsesPinnedBinary(t *testing.T) {
	ClearPythonOverride()
	defer ClearPythonOverride()
	dir := t.TempDir()
	marker := filepath.Join(dir, "pinned-marker.txt")
	var wrapPath string
	if runtime.GOOS == "windows" {
		wrapPath = filepath.Join(dir, "wrap.bat")
		body := "@echo off\r\ntype nul > \"" + marker + "\"\r\necho pinned-ok\r\n"
		if err := os.WriteFile(wrapPath, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	} else {
		wrapPath = filepath.Join(dir, "wrap.sh")
		wrapper := "#!/bin/sh\nprintf 'x' > " + marker + "\necho pinned-ok\n"
		if err := os.WriteFile(wrapPath, []byte(wrapper), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	SetPythonOverride(wrapPath, nil)
	tool := &PythonTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"code": "print(1)"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "pinned-ok") {
		t.Fatalf("pinned binary was not used: %q", got)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("pinned binary did not run")
	}
}
