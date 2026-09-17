package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
	dir := t.TempDir()
	d.dataDir = dir
	os.MkdirAll(filepath.Join(dir, "slots", "slot-b", "sessions"), 0o700)
	os.WriteFile(filepath.Join(dir, "slots", "slot-b", "sessions", "x.jsonl"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(dir, "slots", "active"), []byte("a\n"), 0o600)
	d.setFrozen(true, "test")
	d.abortHandoff("boom")
	if d.isFrozen() {
		t.Fatal("still frozen after abort")
	}
	if _, err := os.Stat(filepath.Join(dir, "slots", "slot-b")); !os.IsNotExist(err) {
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
	dir := t.TempDir()
	d.dataDir = dir
	os.WriteFile(filepath.Join(dir, "slots", "active"), []byte("a\n"), 0o600)
	src := filepath.Join(dir, "sessions")
	os.MkdirAll(src, 0o700)
	os.WriteFile(filepath.Join(src, "s.jsonl"), []byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s\"}\n"), 0o600)
	sl := d.slots()
	if sl.active != "a" || sl.inactive != "b" {
		t.Fatalf("slots: %+v", sl)
	}
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "slots", "slot-b", "sessions", "s.jsonl"))
	if err != nil || len(raw) == 0 {
		t.Fatalf("copy failed: %v", err)
	}
}

func TestLegacySlotDir(t *testing.T) {
	d := testDaemon(t)
	d.dataDir = t.TempDir()
	// No slots/ dir: active resolves to dataDir itself.
	if got := d.slotDir("a"); got != d.dataDir {
		t.Fatalf("legacy active = %q", got)
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
