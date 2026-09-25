package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Canonical layout in every test: dataDir IS the active slot
// (<root>/slots/slot-a). The boot role guarantees the layout before exec.

func testSlot(t *testing.T, root, which string) string {
	t.Helper()
	dir := filepath.Join(root, "slots", "slot-"+which)
	os.MkdirAll(filepath.Join(dir, "sessions"), 0o700)
	return dir
}

func TestAbortHandoffCleansInactive(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	os.MkdirAll(filepath.Join(root, "slots", "slot-b", "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "slot-b", "sessions", "x.jsonl"), []byte("x"), 0o600)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.abortHandoff("boom")
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

func TestAbortHandoffRefusesOwnSlotWithStaleActiveMarker(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "b")
	marker := filepath.Join(d.dataDir, "sessions", "keep.jsonl")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	d.abortHandoff("stale active marker")
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep" {
		t.Fatal("abort deleted its own data")
	}
}

func TestCopyToSlotKeepsWALRepairIsolated(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	d.dataDir = testSlot(t, root, "a")
	if err := os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ww, err := storeOf(d).openWAL("repair", &walHeader{TurnIndex: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := ww.close(); err != nil {
		t.Fatal(err)
	}
	prefix, _ := os.ReadFile(storeOf(d).walPath("repair"))
	original := append(prefix, []byte("{broken")...)
	if err := os.WriteFile(storeOf(d).walPath("repair"), original, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.copyToSlot(d.slots(), d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	d2 := testDaemon(t)
	d2.dataDir = d.slotDir("b")
	ww, err = storeOf(d2).openWALAppend("repair")
	if err != nil {
		t.Fatal(err)
	}
	if err := ww.append(walEvent{Type: walTypeTitle, Title: "new slot"}); err != nil {
		t.Fatal(err)
	}
	if err := ww.close(); err != nil {
		t.Fatal(err)
	}
	repaired, err := os.ReadFile(storeOf(d2).walPath("repair"))
	if err != nil {
		t.Fatal(err)
	}
	record, _, err := replayWAL(&SessionRecord{ID: "repair"}, repaired)
	if err != nil || record.Title != "new slot" {
		t.Fatalf("repaired WAL did not append a replayable event: %v, %s", err, repaired)
	}
	after, err := os.ReadFile(storeOf(d).walPath("repair"))
	if err != nil || string(after) != string(original) {
		t.Fatal("new slot changed rollback WAL")
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
	for _, s := range listSessionSummaries(d.dataDir) {
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

func TestUpdateSignalParsing(t *testing.T) {
	// The brutal fail/done signals are plain files under slots/:
	// any non-empty body counts as the signal (the 100ms poller
	// tolerates torn reads by retrying).
	dir := t.TempDir()
	fail := filepath.Join(dir, "slots", "update.fail")
	writeUpdateSignal(fail, "failed: x")
	body, ok := readUpdateSignal(fail)
	if !ok || body != "failed: x" {
		t.Fatalf("fail signal = %q,%v", body, ok)
	}
	if _, ok := readUpdateSignal(filepath.Join(dir, "slots", "update.done")); ok {
		t.Fatal("missing done must read absent")
	}
}
