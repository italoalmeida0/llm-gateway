package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Launcher --update flag + version-ordering unit tests (no processes).

func TestParseUpdateFlags(t *testing.T) {
	root, from, to, want, old, fail, done, pid := parseUpdateFlags([]string{
		"--update",
		"--root-dir", "/r",
		"--from-slot", "a",
		"--to-slot", "b",
		"--expect-version", "1.0.28",
		"--old-version", "1.0.27",
		"--fail-file", "/r/slots/update.fail",
		"--done-file", "/r/slots/update.done",
		"--parent-pid", "1234",
	})
	if root != "/r" || from != "a" || to != "b" || want != "1.0.28" || old != "1.0.27" ||
		fail != "/r/slots/update.fail" || done != "/r/slots/update.done" || pid != "1234" {
		t.Fatalf("flags = %q %q %q %q %q %q %q %q", root, from, to, want, old, fail, done, pid)
	}
}

func TestIsVersionNewerUpdate(t *testing.T) {
	if !isVersionNewerUpdate("1.0.28", "1.0.27") {
		t.Fatal("1.0.28 > 1.0.27")
	}
	// Dev installs bootstrapping to a release still count as an update.
	if !isVersionNewerUpdate("1.0.27", "dev") {
		t.Fatal("release > dev")
	}
	for _, tc := range [][2]string{
		{"1.0.27", "1.0.27"},
		{"1.0.27", "1.0.28"},
		{"dev", "dev"},
		{"dev", "1.0.27"},
		{"", "1.0.27"},
		{"1.0.28", ""},
	} {
		if isVersionNewerUpdate(tc[0], tc[1]) {
			t.Fatalf("isVersionNewerUpdate(%q,%q) must be false", tc[0], tc[1])
		}
	}
}

func TestWriteSignalFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "slots", "update.fail")
	writeSignalFile(p, "failed: boom")
	raw, err := os.ReadFile(p)
	if err != nil || string(raw) != "failed: boom" {
		t.Fatalf("signal = %q,%v", raw, err)
	}
}
