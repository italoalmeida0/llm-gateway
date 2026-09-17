package main

import "testing"

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
