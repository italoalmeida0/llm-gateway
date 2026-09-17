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

// Regression: after the first slot boot adopts sessions/ into
// slots/slot-a, sessionsDir must resolve to the ACTIVE slot — the
// daemon must keep serving (and copying) the adopted sessions, not
// the stale legacy dir. (Real incident 2026-09-17: two compacted
// sessions vanished from the frontend because the daemon kept reading
// the legacy dir after installSlotA moved it.)
func TestSessionsDirFollowsActiveSlot(t *testing.T) {
	d := testDaemon(t)
	dir := t.TempDir()
	d.dataDir = dir
	// Pre-slot layout: legacy dir is live.
	if got := d.sessionsDir(); got != filepath.Join(dir, "sessions") {
		t.Fatalf("legacy sessionsDir = %q", got)
	}
	// Post-adoption layout: active=a, sessions only in slot-a.
	os.MkdirAll(filepath.Join(dir, "slots", "slot-a", "sessions"), 0o700)
	os.WriteFile(filepath.Join(dir, "slots", "slot-a", "sessions", "s.jsonl"),
		[]byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s\",\"title\":\"T\",\"updatedAt\":1}\n"), 0o600)
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o700) // stale legacy dir
	os.WriteFile(filepath.Join(dir, "slots", "active"), []byte("a\n"), 0o600)
	if got, want := d.sessionsDir(), filepath.Join(dir, "slots", "slot-a", "sessions"); got != want {
		t.Fatalf("sessionsDir = %q, want %q", got, want)
	}
	// listSessions must see the adopted session.
	found := false
	for _, s := range d.listSessions() {
		if s.ID == "s" {
			found = true
		}
	}
	if !found {
		t.Fatal("adopted session invisible to listSessions")
	}
	// copyToSlot must copy FROM the active slot.
	sl := d.slots()
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "slots", "slot-b", "sessions", "s.jsonl")); err != nil {
		t.Fatalf("copy missed adopted session: %v", err)
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
