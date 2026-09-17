package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveSlotDaemonMissing(t *testing.T) {
	if _, _, err := resolveSlotDaemon(t.TempDir()); err == nil {
		t.Fatal("empty dir must trigger install attempt (network) or error")
	}
}

func TestSharedRootFor(t *testing.T) {
	if got := sharedRootFor("/x/slots/slot-a"); got != "/x" {
		t.Fatalf("got %q", got)
	}
	if got := sharedRootFor("/plain"); got != "/plain" {
		t.Fatalf("got %q", got)
	}
}

func TestActiveSessionsDir(t *testing.T) {
	// Pre-slot layout: legacy dir.
	dir := t.TempDir()
	if got := activeSessionsDir(dir); got != dir+"/sessions" {
		t.Fatalf("legacy = %q", got)
	}
	// Post-adoption layout: active slot wins.
	os.MkdirAll(filepath.Join(dir, "slots", "slot-a", "sessions"), 0o700)
	os.WriteFile(filepath.Join(dir, "slots", "active"), []byte("a\n"), 0o600)
	if got := activeSessionsDir(dir); got != filepath.Join(dir, "slots", "slot-a", "sessions") {
		t.Fatalf("slotted = %q", got)
	}
}
