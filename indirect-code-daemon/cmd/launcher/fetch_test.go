package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestResolveSlotDaemonMissing(t *testing.T) {
	// Hermetic: no mirror (env cleared), HOME pointed at the empty dir so
	// no real config.json leaks in. Install must fail, not succeed.
	// Windows: Go reads %USERPROFILE%, not %HOME% — clear both.
	dir := t.TempDir()
	t.Setenv("INDIRECT_REPO_RAW", "")
	t.Setenv("INDIRECT_GATEWAY", "")
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
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
//
// The fake mirror serves a REAL binary for the current platform (built
// from a tiny Go program): shell scripts can't exec on Windows and a
// fixture .exe can't run on unix (real bug caught on windows/arm64 —
// the old test served #!/bin/sh and fork/exec failed there).
func TestFetchDaemonFloatingURL(t *testing.T) {
	var hits []string
	fakeSrc := "package main\nimport \"fmt\"\nfunc main(){fmt.Println(\"indirect-code daemon v9.9.9\")}\n"
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "fake.go")
	if err := os.WriteFile(src, []byte(fakeSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBinPath := filepath.Join(srcDir, "fakebin")
	if runtime.GOOS == "windows" {
		fakeBinPath += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", fakeBinPath, src).CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v %s", err, out)
	}
	fakeBin, err := os.ReadFile(fakeBinPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
		w.Write(fakeBin)
	}))
	defer srv.Close()
	// Gateway-first: the daemon's gateway wins when set; the raw mirror
	// is the fallback. Clear any ambient gateway so the test mirror wins.
	t.Setenv("INDIRECT_GATEWAY", "")
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
	t.Setenv("INDIRECT_GATEWAY", "")
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

// Gateway-first: INDIRECT_GATEWAY wins over a stale INDIRECT_REPO_RAW.
// (E2E caught it: ambient raw mirror served old bytes while the gateway
// had the fresh release — the new side fetched stale and failed verify
// after the old daemon was already gone.)
func TestMirrorBaseGatewayFirst(t *testing.T) {
	t.Setenv("INDIRECT_GATEWAY", "http://gw:1234")
	t.Setenv("INDIRECT_REPO_RAW", "http://stale:9999/r")
	if got := mirrorBase(); got != "http://gw:1234/r" {
		t.Fatalf("gateway must win, got %q", got)
	}
	t.Setenv("INDIRECT_GATEWAY", "")
	t.Setenv("INDIRECT_REPO_RAW", "http://stale:9999/r")
	if got := mirrorBase(); got != "http://stale:9999/r" {
		t.Fatalf("raw fallback must work, got %q", got)
	}
}

func TestUpdateMirrorUsesCustomRoot(t *testing.T) {
	t.Setenv("INDIRECT_GATEWAY", "")
	t.Setenv("INDIRECT_REPO_RAW", "")
	root := t.TempDir()
	slot := filepath.Join(root, "slots", "slot-b")
	if err := os.MkdirAll(slot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(slot, "config.json"), []byte(`{"gateway_url":"https://paired.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	args := os.Args
	defer func() { os.Args = args }()
	os.Args = []string{"launcher", "--update", "--root-dir", root}
	if got := mirrorBase(); got != "https://paired.example/r" {
		t.Fatalf("custom update root lost its gateway: %q", got)
	}
}

// ws:// connect/config URLs map to the http(s) mirror (K5 chaos: the old
// code built a ws:// mirror URL and the download failed with
// "unsupported protocol scheme").
func TestHttpMirrorBaseSchemes(t *testing.T) {
	cases := map[string]string{
		"ws://h:1/api/x":    "http://h:1/r",
		"wss://h/x":         "https://h/r",
		"http://h:2/":       "http://h:2/r",
		"https://h/y":       "https://h/r",
		"ftp://h/z":         "",
		"not-a-url-\x7f":    "",
	}
	for in, want := range cases {
		if got := httpMirrorBase(in); got != want {
			t.Fatalf("httpMirrorBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// Boot path accepts a NEWER daemon than the launcher (post-flip power
// loss: active=b holds vK2 while the launcher is vK1). Strict pinning
// would refuse to boot the good slot (K3 chaos caught it).
func TestSelfVerifyRunsAcceptsAnyVersion(t *testing.T) {
	dir := t.TempDir()
	// Real binary (shell scripts can't exec on Windows — same rule as
	// the floating-URL test above).
	src := filepath.Join(dir, "v.go")
	if err := os.WriteFile(src, []byte("package main\nimport \"fmt\"\nfunc main(){fmt.Println(\"indirect-code daemon vNEWER\")}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(dir, "indirect-code")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", bin, src).CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v %s", err, out)
	}
	if err := selfVerifyRuns(bin); err != nil {
		t.Fatalf("newer daemon must boot: %v", err)
	}
	os.WriteFile(bin, []byte("garbage-not-a-binary"), 0o755)
	if err := selfVerifyRuns(bin); err == nil {
		t.Fatal("garbage must not boot")
	}
}
