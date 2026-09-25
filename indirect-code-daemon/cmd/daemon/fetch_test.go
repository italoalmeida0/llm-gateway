package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestWorkerModeRouting locks the multi-call contract (main.go): which
// invocations run the worker role vs the boot role. Mis-routing here is
// how "all or nothing" turns into nested supervisors.
func TestWorkerModeRouting(t *testing.T) {
	slotDir := filepath.Join(t.TempDir(), "slots", "slot-a")
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"bare boot", []string{}, false},
		{"boot with connect", []string{"--connect", "https://gw/api/x", "--name", "host"}, false},
		{"boot with root data-dir", []string{"--data-dir", t.TempDir()}, false},
		{"explicit worker", []string{"--worker", "--data-dir", t.TempDir()}, true},
		{"update handoff start", []string{"--update-start", "--app-path", "/x"}, true},
		{"update handoff end", []string{"--update-end", "--root-dir", "/x"}, true},
		{"slot flag is worker-only", []string{"--slot", "a", "--data-dir", t.TempDir()}, true},
		{"data-dir in slot is not a mode by itself", []string{"--data-dir", slotDir}, false},
		{"flags after -- are not routing", []string{"--", "--worker"}, false},
	}
	for _, c := range cases {
		if got := workerMode(c.args); got != c.want {
			t.Errorf("%s: workerMode(%v) = %v, want %v", c.name, c.args, got, c.want)
		}
	}
}

// TestResolveSlotDaemonSelfStages: the multi-call binary has no boot-time
// download — a fresh root must install and resolve the WORKER as the
// running binary itself, with the slot app staged from our own bytes.
func TestResolveSlotDaemonSelfStages(t *testing.T) {
	dir := t.TempDir()
	// Hermetic: no mirror envs can matter anymore, but clear them anyway
	// so a future re-introduction of network at boot fails loudly here.
	t.Setenv("INDIRECT_REPO_RAW", "")
	t.Setenv("INDIRECT_GATEWAY", "")
	worker, slot, _, err := resolveSlotDaemon(dir)
	if err != nil {
		t.Fatalf("fresh root must self-install: %v", err)
	}
	if slot != "a" {
		t.Fatalf("slot = %q, want a", slot)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if worker != exe {
		t.Fatalf("worker = %q, want self %q", worker, exe)
	}
	staged := filepath.Join(dir, "slots", "slot-a", "bin", slotBinName())
	if st, err := os.Stat(staged); err != nil || st.IsDir() || st.Size() == 0 {
		t.Fatalf("slot app not staged at %s: %v", staged, err)
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

// Boot path accepts a NEWER app than the caller (post-flip power loss:
// active=b holds vK2 while the running copy is vK1). Strict pinning
// would refuse to boot the good slot (K3 chaos caught it).
func TestSelfVerifyRunsAcceptsAnyVersion(t *testing.T) {
	dir := t.TempDir()
	// Real binary (shell scripts can't exec on Windows).
	src := filepath.Join(dir, "v.go")
	if err := os.WriteFile(src, []byte("package main\nimport \"fmt\"\nfunc main(){fmt.Println(\"indirect-code boot vNEWER\")}\n"), 0o600); err != nil {
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
		t.Fatalf("newer app must be accepted: %v", err)
	}
	os.WriteFile(bin, []byte("garbage-not-a-binary"), 0o755)
	if err := selfVerifyRuns(bin); err == nil {
		t.Fatal("garbage must not verify")
	}
}
