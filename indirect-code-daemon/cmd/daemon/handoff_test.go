package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Canonical layout in every test: dataDir IS the active slot
// (<root>/slots/slot-a). The launcher guarantees the layout before exec.

func testSlot(t *testing.T, root, which string) string {
	t.Helper()
	dir := filepath.Join(root, "slots", "slot-"+which)
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o700)
	return dir
}

func TestFreezeGuardsPrompt(t *testing.T) {
	d := testDaemon(t)
	d.setFrozen(true, "test")
	if !d.isFrozen() {
		t.Fatal("not frozen")
	}
	// startPrompt must reject while frozen (no turn starts).
	d.startPrompt("nope", "hello", nil, "", false, nil)
	d.setFrozen(false, "")
	if d.isFrozen() {
		t.Fatal("not unfrozen")
	}
}

func TestAbortHandoffCleansInactive(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	os.MkdirAll(filepath.Join(root, "slots", "slot-b", "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "slot-b", "sessions", "x.jsonl"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.setFrozen(true, "test")
	d.abortHandoff("boom")
	if d.isFrozen() {
		t.Fatal("still frozen after abort")
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); !os.IsNotExist(err) {
		t.Fatal("inactive slot survived abort")
	}
	st := d.updateChecker()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.lastError != "boom" {
		t.Fatalf("reason lost: %q", st.lastError)
	}
}

func TestCopyToSlotHardlink(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	os.WriteFile(filepath.Join(d.dataDir, "sessions", "s.jsonl"), []byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s\"}\n"), 0o600)
	sl := d.slots()
	if sl.active != "a" || sl.inactive != "b" {
		t.Fatalf("slots: %+v", sl)
	}
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, "slots", "slot-b", "sessions", "s.jsonl"))
	if err != nil || len(raw) == 0 {
		t.Fatalf("copy failed: %v", err)
	}
}

func TestSessionsDirIsSlotLocal(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	if got, want := d.sessionsDir(), filepath.Join(d.dataDir, "sessions"); got != want {
		t.Fatalf("sessionsDir = %q, want %q", got, want)
	}
	os.WriteFile(filepath.Join(d.dataDir, "sessions", "s.jsonl"),
		[]byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s\",\"title\":\"T\",\"updatedAt\":1}\n"), 0o600)
	// listSessions must see the slot session.
	found := false
	for _, s := range d.listSessions() {
		if s.ID == "s" {
			found = true
		}
	}
	if !found {
		t.Fatal("slot session invisible to listSessions")
	}
	// copyToSlot must copy FROM the active slot.
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	sl := d.slots()
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b", "sessions", "s.jsonl")); err != nil {
		t.Fatalf("copy missed slot session: %v", err)
	}
}

func TestSlotDirActiveIsDataDir(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	// Active resolves to dataDir itself; inactive to its sibling.
	if got := d.slotDir("a"); got != d.dataDir {
		t.Fatalf("active = %q, want dataDir %q", got, d.dataDir)
	}
	if got, want := d.slotDir("b"), filepath.Join(root, "slots", "slot-b"); got != want {
		t.Fatalf("inactive = %q, want %q", got, want)
	}
}

func TestHandoffResultParsing(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "h.json")
	os.WriteFile(p, []byte("promoted"), 0o600)
	if ok, done := readHandoffReady(p); !ok || !done {
		t.Fatal("promoted not parsed")
	}
	os.WriteFile(p, []byte("failed: x"), 0o600)
	if ok, done := readHandoffReady(p); ok || !done {
		t.Fatal("failed not parsed")
	}
	if err := readHandoffResult(p, nil); err == nil {
		t.Fatal("failed result must error")
	}
}
