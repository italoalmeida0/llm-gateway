package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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

// Floating asset only (no -vX.Y.Z copies): a single URL per mirror.
// Freshness is enforced by --version self-verify after download
// (plus a cache-buster query), not by immutable versioned URLs.
func TestFetchDaemonFloatingURL(t *testing.T) {
	var hits []string
	fakeBin := "#!/bin/sh\necho 'indirect-code daemon v9.9.9'\n"
	pad := make([]byte, 2<<20)
	for i := range pad {
		pad[i] = '#'
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		w.Write([]byte(fakeBin))
		w.Write(pad)
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	dir := t.TempDir()
	lp, err := fetchDaemonTo(dir, "9.9.9")
	if err != nil {
		t.Fatal(err)
	}
	want := "/indirect-code-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if len(hits) != 1 || hits[0] != want {
		t.Fatalf("single floating URL expected, hits=%v want=%s", hits, want)
	}
	if err := selfVerifyDaemon(lp, "9.9.9"); err != nil {
		t.Fatalf("self-verify: %v", err)
	}
}

func TestFetchDaemonStaleFailsVerify(t *testing.T) {
	// Mirror serves a stale-but-valid binary: download succeeds,
	// self-verify decides (fails here) — the freshness gate.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#!/bin/sh\necho 'indirect-code daemon vOLD'\n"))
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	dir := t.TempDir()
	lp, err := fetchDaemonTo(dir, "9.9.9")
	if err != nil {
		t.Fatalf("download must succeed: %v", err)
	}
	if err := selfVerifyDaemon(lp, "9.9.9"); err == nil {
		t.Fatal("stale binary must fail self-verify")
	}
}
