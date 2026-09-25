package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// Brutal update unit tests: version ordering, signal files, slot cleaning
// guards. No processes are spawned here (kill paths are covered by the
// boot stubborn test + the handoff E2E script).

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.0.27", "1.0.27", 0},
		{"1.0.28", "1.0.27", 1},
		{"1.0.27", "1.0.28", -1},
		{"v1.0.28", "1.0.27", 1},
		{"1.10.0", "1.9.9", 1},
		{"1.0.27", "1.0.27+build.1", 0},
		{"2.0", "1.99.99", 1},
		{"1.0", "1.0.1", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); (got > 0) != (c.want > 0) || (got < 0) != (c.want < 0) {
			t.Fatalf("compareVersions(%q,%q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestIsVersionNewer(t *testing.T) {
	if !isVersionNewer("1.0.28", "1.0.27") {
		t.Fatal("1.0.28 > 1.0.27")
	}
	if !isVersionNewer("v1.0.28", "1.0.27") {
		t.Fatal("v-prefix must not matter")
	}
	for _, tc := range [][2]string{
		{"1.0.27", "1.0.27"}, // same
		{"1.0.27", "1.0.28"}, // older
		{"dev", "1.0.27"},    // dev target
		{"1.0.28", "dev"},    // dev current
		{"", "1.0.27"},
		{"1.0.28", ""},
	} {
		if isVersionNewer(tc[0], tc[1]) {
			t.Fatalf("isVersionNewer(%q,%q) must be false", tc[0], tc[1])
		}
	}
}

// This executable also serves as a native child fixture on every platform.
func TestSlotProcessHelper(t *testing.T) {
	if os.Getenv("SLOT_PROCESS_CHILD") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

func TestKillSlotProcesses(t *testing.T) {
	root := t.TempDir()
	slot := filepath.Join(root, "slot with spaces")
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	spawn := func(dir string) *exec.Cmd {
		t.Helper()
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		name := "sleeper"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0700); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(path, "-test.run=^TestSlotProcessHelper$")
		cmd.Env = append(os.Environ(), "SLOT_PROCESS_CHILD=1")
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd
	}
	insider := spawn(filepath.Join(slot, "bin"))
	outsider := spawn(slot + "-neighbor")
	// No pidfile: the directory scan itself must discover the updater.
	found := map[int]bool{}
	killSlotProcessesByDir(slot, os.Getpid(), func(pid int, _ string) { found[pid] = true })
	if !found[insider.Process.Pid] || found[outsider.Process.Pid] {
		t.Fatalf("directory discovery: %v", found)
	}
	killSlotProcessesByDir(slot, insider.Process.Pid, func(pid int, _ string) {
		if pid == insider.Process.Pid {
			t.Fatal("scan selected its own process")
		}
	})
	killSlotProcesses(slot, os.Getpid(), t.Logf)
	if pidAliveStr(strconv.Itoa(insider.Process.Pid)) {
		t.Fatal("insider survived sweep")
	}
	if !pidAliveStr(strconv.Itoa(outsider.Process.Pid)) {
		t.Fatal("sibling with shared prefix killed")
	}
}

func TestUpdateSignals(t *testing.T) {
	dir := t.TempDir()
	fail := filepath.Join(dir, "slots", "update.fail")
	done := filepath.Join(dir, "slots", "update.done")
	writeUpdateSignal(fail, "failed: boom")
	body, ok := readUpdateSignal(fail)
	if !ok || body != "failed: boom" {
		t.Fatalf("fail signal = %q,%v", body, ok)
	}
	if _, ok := readUpdateSignal(done); ok {
		t.Fatal("missing done must read absent")
	}
	writeUpdateSignal(done, "1.0.28")
	if body, ok := readUpdateSignal(done); !ok || body != "1.0.28" {
		t.Fatalf("done signal = %q,%v", body, ok)
	}
}

func TestCleanInactiveSlotRefusesOwn(t *testing.T) {
	root := t.TempDir()
	own := filepath.Join(root, "slots", "slot-a")
	if err := os.MkdirAll(own, 0o700); err != nil {
		t.Fatal(err)
	}
	// Same letter: refuse.
	if err := cleanInactiveSlot(root, "a", "a", own); err == nil {
		t.Fatal("cleaning own slot letter must fail")
	}
	// Own dir path: refuse even with a different letter.
	ownB := filepath.Join(root, "slots", "slot-b")
	_ = os.MkdirAll(ownB, 0o700)
	if err := cleanInactiveSlot(root, "a", "b", ownB); err == nil {
		t.Fatal("cleaning own slot dir must fail")
	}
	// Sibling slot cleans fine.
	if err := cleanInactiveSlot(root, "a", "b", own); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); err != nil {
		t.Fatalf("target slot missing: %v", err)
	}
	// Own slot untouched (marker file survives).
	marker := filepath.Join(own, "marker")
	if err := os.WriteFile(marker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cleanInactiveSlot(root, "a", "b", own); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("own slot damaged by sibling clean")
	}
}
