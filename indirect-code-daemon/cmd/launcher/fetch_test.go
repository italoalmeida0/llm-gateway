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
	// Hermetic: no mirror (env cleared), HOME pointed at the empty dir so
	// no real config.json leaks in. Install must fail, not succeed.
	dir := t.TempDir()
	t.Setenv("INDIRECT_REPO_RAW", "")
	t.Setenv("INDIRECT_GATEWAY", "")
	t.Setenv("HOME", dir)
	if _, _, _, err := resolveSlotDaemon(dir); err == nil {
		t.Fatal("empty dir with no mirror must fail install")
	}
}

func TestEnsureLayoutFresh(t *testing.T) {
	root := t.TempDir()
	notes, err := ensureLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) == 0 {
		t.Fatal("fresh root should report layout notes")
	}
	if got := readActiveSlot(filepath.Join(root, "slots")); got != "a" {
		t.Fatalf("active = %q, want a", got)
	}
	for _, d := range []string{"slots/slot-a/bin", "slots/slot-a/sessions", "logs", "brain", "external"} {
		if st, err := os.Stat(filepath.Join(root, d)); err != nil || !st.IsDir() {
			t.Fatalf("missing dir %s", d)
		}
	}
	// Idempotent: second run reports nothing.
	notes, err = ensureLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) != 0 {
		t.Fatalf("clean layout should be silent, got %v", notes)
	}
}

func TestEnsureLayoutAdoptsStrayRoot(t *testing.T) {
	root := t.TempDir()
	// Stray state BEFORE any slot exists: ensureLayout must adopt it
	// into slot-a (rename, instant). No slot dirs pre-created.
	os.WriteFile(filepath.Join(root, "config.json"), []byte("{}"), 0o600)
	os.MkdirAll(filepath.Join(root, "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "sessions", "s.jsonl"), []byte("x"), 0o600)
	notes, err := ensureLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) == 0 {
		t.Fatal("adoption should report notes")
	}
	slotA := filepath.Join(root, "slots", "slot-a")
	if _, err := os.Stat(filepath.Join(slotA, "config.json")); err != nil {
		t.Fatal("config.json not adopted")
	}
	if _, err := os.Stat(filepath.Join(slotA, "sessions", "s.jsonl")); err != nil {
		t.Fatal("sessions not adopted")
	}
	if _, err := os.Stat(filepath.Join(root, "config.json")); !os.IsNotExist(err) {
		t.Fatal("stray root config.json survived")
	}
}

func TestEnsureLayoutDiscoversLiveSlot(t *testing.T) {
	root := t.TempDir()
	slots := filepath.Join(root, "slots")
	os.MkdirAll(filepath.Join(slots, "slot-b", "sessions"), 0o700)
	os.WriteFile(filepath.Join(slots, "slot-b", "sessions", "s.jsonl"), []byte("x"), 0o600)
	// No active file: freshest slot wins.
	notes, err := ensureLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(notes) == 0 {
		t.Fatal("discovery should report notes")
	}
	if got := readActiveSlot(slots); got != "b" {
		t.Fatalf("active = %q, want b", got)
	}
}

func TestEnsureLayoutCorruptActive(t *testing.T) {
	root := t.TempDir()
	slots := filepath.Join(root, "slots")
	os.MkdirAll(filepath.Join(slots, "slot-a", "sessions"), 0o700)
	os.WriteFile(filepath.Join(slots, "active"), []byte("garbage\n"), 0o600)
	if _, err := ensureLayout(root); err != nil {
		t.Fatal(err)
	}
	if got := readActiveSlot(slots); got != "a" {
		t.Fatalf("active = %q, want a", got)
	}
}

func TestActiveSessionsDir(t *testing.T) {
	// Canonical: active slot wins.
	dir := t.TempDir()
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
