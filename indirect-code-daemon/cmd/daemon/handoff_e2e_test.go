package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Brutal update primitives against the fake mirror (no WS needed):
// fetch launcher -> copy (source is SIGKILLed, WAL travels verbatim) ->
// resume in the new slot. Canonical layout: dataDir IS the active slot
// (<root>/slots/slot-a), root holds brain/slots/logs.
func TestHandoffPrimitivesE2E(t *testing.T) {
	// The fake mirror must serve a REAL binary for the current platform:
	// shell scripts can't exec on Windows and a fixture .exe can't run
	// on unix (caught on windows/arm64 — same rule as the launcher's
	// floating-URL test).
	fakeSrc := "package main\nimport \"fmt\"\nfunc main(){fmt.Println(\"indirect-code launcher vE2E.2\")}\n"
	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "fake.go")
	if err := os.WriteFile(src, []byte(fakeSrc), 0o600); err != nil {
		t.Fatal(err)
	}
	fakeBin := filepath.Join(srcDir, "fakebin")
	if runtime.GOOS == "windows" {
		fakeBin += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", fakeBin, src).CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v %s", err, out)
	}
	fakeBytes, err := os.ReadFile(fakeBin)
	if err != nil {
		t.Fatal(err)
	}
	// Pad past the 1MB suspicious-size floor (a truncated download /
	// HTML error page would fail the size gate or the version gate).
	if len(fakeBytes) < (2 << 20) {
		pad := make([]byte, (2<<20)-len(fakeBytes))
		fakeBytes = append(fakeBytes, pad...)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(fakeBytes)
	}))
	defer srv.Close()
	t.Setenv("INDIRECT_REPO_RAW", srv.URL)
	d := testDaemon(t)
	root := t.TempDir()
	// Seed slot-a with one session (canonical layout: dataDir = slot-a).
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.WriteFile(filepath.Join(slotA, "sessions", "s1.jsonl"),
		[]byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\",\"title\":\"T\"}\n"), 0o600)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")
	if got := d.rootDir(); got != root {
		t.Fatalf("root = %q, want %q", got, root)
	}
	// Slot layout reads active=a.
	sl := d.slots()
	if sl.active != "a" || sl.inactive != "b" {
		t.Fatalf("slots: %+v", sl)
	}
	// Copy (brutal: the source is already SIGKILLed, WAL verbatim).
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
	// Abort path: cleans slot-b.
	d.abortHandoff("e2e-abort")
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); !os.IsNotExist(err) {
		t.Fatal("slot-b survived abort")
	}
	// Slot-a untouched.
	if _, err := os.Stat(filepath.Join(slotA, "sessions", "s1.jsonl")); err != nil {
		t.Fatal("slot-a damaged")
	}
}

// SIGKILL/resume: a running turn (WAL + running JSON) survives
// copyToSlot and resumes in the new slot — same turn index, transcript
// intact, never marked cancelled (this is the crash-recovery path the
// brutal protocol leans on: the old daemon is SIGKILLed mid-turn).
func TestHandoffPauseResumesRunningTurn(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")
	sl := d.slots()

	// Seed a running turn: frozen JSON (running) + WAL with 1 message.
	rec := &SessionRecord{ID: "run1", CWD: t.TempDir(), Model: "m",
		Status: "running", TurnSeq: 2,
		Turn:     &TurnActivity{StartedAt: 42, Status: "running"},
		Messages: []provider.Message{{Role: provider.RoleUser, TurnIndex: 2, Content: []provider.Content{provider.TextBlock{Text: "go"}}}},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	ww, err := d.openWAL(rec.ID, &walHeader{TurnIndex: 2, StartedAt: 42, Prompt: "go"})
	if err != nil {
		t.Fatal(err)
	}
	act := &ActiveSession{record: rec, wal: ww}
	d.sessions[rec.ID] = act

	// Close the WAL handle (flush) WITHOUT committing: the log is the
	// turn's recovery record (this is what a SIGKILL leaves behind).
	_ = act.wal.close()
	act.wal = nil
	if rec.Status != "running" || rec.Turn.Status != "running" {
		t.Fatalf("turn state damaged: %+v", rec.Turn)
	}
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b", "sessions", "run1.wal.jsonl")); err != nil {
		t.Fatalf("WAL did not travel to the new slot: %v", err)
	}

	// The new daemon (fresh server on slot-b) resumes the SAME turn.
	d2 := testDaemon(t)
	d2.dataDir = filepath.Join(root, "slots", "slot-b")
	d2.sharedDir = filepath.Join(root, "external")
	fused, h, err := d2.loadSessionFused("run1")
	if err != nil || h == nil || h.TurnIndex != 2 {
		t.Fatalf("fused load: %v %+v", h, err)
	}
	if len(fused.Messages) != 1 || fused.Turn.Status != "running" {
		t.Fatalf("fused record lost the turn: %+v", fused.Turn)
	}
	if turnResumeAbandoned(fused, h) {
		t.Fatal("paused handoff turn must NOT be abandoned")
	}
}

// Abort-before-spawn keeps serving: the brutal spawn never happened
// (failure before --update-start), so NOTHING was killed or frozen — the
// daemon keeps serving untouched and the update slot is cleaned.
func TestAbortHandoffResumesPausedTurn(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	os.WriteFile(filepath.Join(root, "slots", "slot-b", "sessions", "x.jsonl"), []byte("x"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")

	d.abortHandoff("boom-before-spawn")
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); !os.IsNotExist(err) {
		t.Fatal("update slot survived abort")
	}
	st := d.updateChecker()
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.lastError != "boom-before-spawn" {
		t.Fatalf("reason lost: %q", st.lastError)
	}
}



func TestCopyToSlotCopiesLiveStateAsIs(t *testing.T) {
	// Brutal protocol: --update-start SIGKILLs the old daemon first, so a
	// running turn's WAL is copied verbatim and the new daemon resumes it
	// from disk (crash recovery). The copy itself never refuses.
	d := testDaemon(t)
	root := t.TempDir()
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")
	sl := d.slots()

	rec := &SessionRecord{ID: "live1", CWD: t.TempDir(), Model: "m",
		Status: "running", TurnSeq: 1,
		Turn:     &TurnActivity{StartedAt: 1, Status: "running"},
		Messages: []provider.Message{{Role: provider.RoleUser, TurnIndex: 1}},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	ww, err := d.openWAL(rec.ID, &walHeader{TurnIndex: 1, StartedAt: 1, Prompt: "x"})
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a turn with an open WAL handle (SIGKILLed mid-turn).
	d.sessions[rec.ID] = &ActiveSession{record: rec, wal: ww}
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		_ = ww.close()
		t.Fatalf("copy must succeed (SIGKILLed source has no live writers): %v", err)
	}
	_ = ww.close()
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b", "sessions", "live1.jsonl")); err != nil {
		t.Fatalf("running session copied verbatim: %v", err)
	}
}

// Binaries must never be hardlinked into the new slot: an in-place
// overwrite of the source asset (release publish, test mirror swap)
// must not change bytes under a running process sharing the inode.
func TestCopyToSlotNeverHardlinksBinaries(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.MkdirAll(filepath.Join(slotA, "sessions", "bin"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")
	sl := d.slots()

	bin := filepath.Join(slotA, "sessions", "bin", "indirect-code-linux-amd64")
	os.WriteFile(bin, []byte("v1-bytes-padded........"), 0o755)
	if err := d.copyToSlot(sl, d.slotDir("b")); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "slots", "slot-b", "sessions", "bin", "indirect-code-linux-amd64")
	a, _ := os.Stat(bin)
	b, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("binary not copied: %v", err)
	}
	if os.SameFile(a, b) {
		t.Fatal("binary hardlinked: source overwrite would corrupt the copy")
	}
	// In-place source overwrite must not leak into the copy.
	os.WriteFile(bin, []byte("v2-bytes-padded........"), 0o755)
	got, _ := os.ReadFile(dst)
	if string(got) != "v1-bytes-padded........" {
		t.Fatalf("copy changed after source overwrite: %q", got)
	}
}
