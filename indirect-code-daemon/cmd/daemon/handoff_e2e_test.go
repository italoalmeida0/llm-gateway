package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Full handoff phases 0-2 against the fake mirror (no WS needed):
// fetch launcher -> quiesce-for-handoff (pause, WAL kept) -> copy ->
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
	// Quiesce-for-handoff (running turn PAUSES, WAL kept — nothing is
	// cancelled, nothing is committed).
	d.quiesceForHandoff()
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
	if _, err := os.Stat(filepath.Join(slotA, "sessions", "s1.jsonl")); err != nil {
		t.Fatal("slot-a damaged")
	}
}

// Handoff pause/resume: a running turn (WAL + running JSON) survives
// quiesceForHandoff + copyToSlot and resumes in the new slot — same turn
// index, transcript intact, never marked cancelled.
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

	// Pause (NOT cancel/commit) + copy.
	d.quiesceForHandoff()
	if act.wal != nil {
		t.Fatal("quiesce must close the WAL handle")
	}
	if rec.Status != "running" || rec.Turn.Status != "running" {
		t.Fatalf("quiesce cancelled the turn: %+v", rec.Turn)
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

// Abort-after-pause resumes the turn in the SAME process: the WAL was
// never cancelled, so abortHandoff restarts the worker and the turn
// keeps running (no reboot, no new daemon).
func TestAbortHandoffResumesPausedTurn(t *testing.T) {
	d := testDaemon(t)
	root := t.TempDir()
	slotA := filepath.Join(root, "slots", "slot-a")
	os.MkdirAll(filepath.Join(slotA, "sessions"), 0o700)
	os.WriteFile(filepath.Join(root, "slots", "active"), []byte("a\n"), 0o600)
	d.dataDir = slotA
	d.sharedDir = filepath.Join(root, "external")

	rec := &SessionRecord{ID: "run2", CWD: t.TempDir(), Model: "m",
		Status: "running", TurnSeq: 1,
		Turn:     &TurnActivity{StartedAt: 7, Status: "running"},
		Messages: []provider.Message{{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hi"}}}},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	ww, err := d.openWAL(rec.ID, &walHeader{TurnIndex: 1, StartedAt: 7, Prompt: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	act := &ActiveSession{record: rec, wal: ww}
	d.sessions[rec.ID] = act

	// Pause (like phase 1), then fail AFTER pausing.
	d.quiesceForHandoff()
	d.setFrozen(true, "copying sessions")
	resumed := make(chan string, 4)
	d.runTurnHook = func(a *ActiveSession, prompt string) {
		resumed <- a.record.ID + ":" + prompt
	}
	d.abortHandoff("boom-after-pause")
	if d.isFrozen() {
		t.Fatal("still frozen after abort")
	}
	select {
	case got := <-resumed:
		if got != "run2:hi" {
			t.Fatalf("wrong resume: %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("paused turn did not resume after abort")
	}
}

// Copy audit: a session that starts writing between quiesce and copy
// must abort the copy (fail = abort, never a torn snapshot).
func TestCopyToSlotRefusesLiveWriter(t *testing.T) {
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
	// Simulate a turn that started AFTER quiesce (open WAL handle).
	d.sessions[rec.ID] = &ActiveSession{record: rec, wal: ww}
	if err := d.copyToSlot(sl, d.slotDir("b")); err == nil {
		_ = ww.close()
		t.Fatal("copy with a live writer must fail")
	}
	// Windows locks open files: close the handle so TempDir cleanup can
	// remove it (the assertions above already proved the copy refused).
	_ = ww.close()
	if _, err := os.Stat(filepath.Join(root, "slots", "slot-b")); !os.IsNotExist(err) {
		t.Fatal("failed copy must not leave a half-copied slot")
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
