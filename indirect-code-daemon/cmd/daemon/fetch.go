package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Boot-path binary helpers for the multi-call binary. ONE artifact, two
// roles (see main.go): the running executable IS the app. There is no
// download layer at boot — downloads live only in the worker's update
// checker (update.go). Stale installs converge through the runtime
// update protocol, never through boot-time network.

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
// refuse instead (see the boot role's dataDir guard).
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

// stageAppTo copies the RUNNING executable into slotDir/bin under the
// canonical app name. Always a real copy, never a hardlink: the staged
// app must stay isolated from the running binary for rollback.
func stageAppTo(slotDir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	binDir := filepath.Join(slotDir, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		return "", err
	}
	local := filepath.Join(binDir, slotBinName())
	if err := copyFileContents(exe, local, 0o755); err != nil {
		return "", fmt.Errorf("stage app: %w", err)
	}
	return local, nil
}

// copyFileContents is a real byte copy (no hardlink) with an explicit
// final mode — used for app binaries where isolation and the exec bit
// both matter.
func copyFileContents(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		return err
	}
	if err := out.Chmod(mode); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// resolveSlotDaemon prepares a boot and resolves the WORKER binary:
// ensureLayout first (repairs broken installs), then the active slot,
// then rollback hygiene (the active slot must hold a runnable app copy —
// staged from OUR bytes when missing or corrupt: deterministic, never a
// network fetch). The returned worker is the running binary itself: the
// multi-call binary self-starts in worker mode.
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
	local := filepath.Join(slotDir, "bin", slotBinName())
	if st, serr := os.Stat(local); serr != nil || st.IsDir() || st.Size() == 0 {
		if _, serr := stageAppTo(slotDir); serr != nil {
			return "", "", repairNotes, serr
		}
	}

	exe, err := os.Executable()
	if err != nil {
		return "", "", repairNotes, err
	}
	return exe, slot, repairNotes, nil
}

// installSlotA performs first-ever boot install: create slot-a, stage
// the running binary as the app copy, adopt stray sessions/, flip active.
func installSlotA(dataDir string) error {
	slotsDir := filepath.Join(dataDir, "slots")
	slotA := filepath.Join(slotsDir, "slot-a")
	if err := os.MkdirAll(filepath.Join(slotA, "bin"), 0o700); err != nil {
		return err
	}
	if _, err := stageAppTo(slotA); err != nil {
		return err
	}
	// Adopt stray sessions/ (rename, instant) when present.
	if _, err := os.Stat(filepath.Join(dataDir, "sessions")); err == nil {
		if _, err := os.Stat(filepath.Join(slotA, "sessions")); os.IsNotExist(err) {
			if err := os.Rename(filepath.Join(dataDir, "sessions"), filepath.Join(slotA, "sessions")); err != nil {
				return fmt.Errorf("adopt sessions: %w", err)
			}
		}
	}
	if err := os.MkdirAll(slotsDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(slotsDir, "active"), []byte("a\n"), 0o600)
}
