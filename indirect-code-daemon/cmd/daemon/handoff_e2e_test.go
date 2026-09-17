package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Full handoff phases 0-2 against the fake mirror (no WS needed):
// fetch launcher -> freeze -> copy -> (takeover exec mocked by checking
// launcher --takeover arg parsing would need a daemon; here we verify the
// daemon-side primitives the E2E shell drives).
func TestHandoffPrimitivesE2E(t *testing.T) {
	// Hermetic mirror: serves a fake launcher script for self-verify.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Fake launcher: valid --version output + >1MB body (passes both
		// the version gate and the suspicious-size floor; a truncated
		// download / HTML error page would fail at least one).
		pad := make([]byte, 2<<20)
		for i := range pad {
			pad[i] = '#'
		}
		w.Write([]byte("#!/bin/sh\necho 'indirect-code launcher vE2E.2'\nexit 0\n#"))
		w.Write(pad)
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	d := testDaemon(t)
	root := t.TempDir()
	// Seed slot-a with one session (mirrors the shell E2E layout).
	os.MkdirAll(filepath.Join(root, "slots", "slot-a", "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
		[]byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\",\"title\":\"T\"}\n"), 0o600)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = root
	d.initSharedDir()
	if got := d.sharedRoot(); got != root {
		t.Fatalf("shared = %q", got)
	}
	// Slot layout reads active=a.
	sl := d.slots()
	if sl.active != "a" || sl.inactive != "b" {
		t.Fatalf("slots: %+v", sl)
	}
	// Quiesce (no sessions = no-op, must not fail).
	d.quiesceSessions()
	// Freeze + copy.
	d.setFrozen(true, "e2e")
	if !d.isFrozen() {
		t.Fatal("not frozen")
	}
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b", "sessions", "s1.jsonl")); err != nil {
		t.Fatalf("copy missing: %v", err)
	}
	// Fetch launcher into slot-b + self-verify via --version.
	lp, err := d.fetchLauncherTo("vE2E.2", sl)
	if err != nil {
		t.Fatal(err)
	}
	if err := selfVerifyBinary(lp, "vE2E.2", "launcher"); err != nil {
		t.Fatalf("self-verify: %v", err)
	}
	if err := selfVerifyBinary(lp, "vNOPE", "launcher"); err == nil {
		t.Fatal("wrong version must fail verify")
	}
	// Abort path: cleans slot-b, unfreezes.
	d.abortHandoff("e2e-abort")
	if d.isFrozen() {
		t.Fatal("still frozen")
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); !os.IsNotExist(err) {
		t.Fatal("slot-b survived abort")
	}
	// Slot-a untouched.
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-a", "sessions", "s1.jsonl")); err != nil {
		t.Fatal("slot-a damaged")
	}
}
