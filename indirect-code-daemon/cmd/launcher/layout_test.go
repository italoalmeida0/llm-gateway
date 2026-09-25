package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Stale or forged update signal markers at the legacy root-level signal
// path (slots/update.done, slots/update.fail) must never gate or bless a
// boot — hardening D4: a fake update.done must not bypass verification.
// A normal boot clears them; slot-local ack markers travel with their
// slot and are never touched.
func TestEnsureLayoutClearsStaleUpdateSignals(t *testing.T) {
	root := t.TempDir()
	slots := filepath.Join(root, "slots")
	mustMkdirAll(filepath.Join(slots, "slot-a"))
	mustWriteFile(filepath.Join(slots, "active"), "a\n")
	mustWriteFile(filepath.Join(slots, "update.done"), "9.9.9")
	mustWriteFile(filepath.Join(slots, "update.fail"), "failed: forged")
	mustWriteFile(filepath.Join(slots, "slot-a", "update.done"), "1.0.0")

	if _, err := ensureLayout(root); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"update.done", "update.fail"} {
		if _, err := os.Lstat(filepath.Join(slots, name)); !os.IsNotExist(err) {
			t.Fatalf("stale %s survived the boot repair", name)
		}
	}
	if _, err := os.Lstat(filepath.Join(slots, "slot-a", "update.done")); err != nil {
		t.Fatalf("slot-local ack marker must never be touched: %v", err)
	}
}
