package migrations

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateFreshSlotStampsBaseline(t *testing.T) {
	slotDir := t.TempDir()
	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != CurrentVersion {
		t.Fatalf("fresh slot must stamp baseline, applied = %v", applied)
	}
	if v, _ := StoredVersion(slotDir); v != CurrentVersion {
		t.Fatalf("version = %d, want %d", v, CurrentVersion)
	}
	// Idempotent re-run: nothing to do.
	applied, err = Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-run applied %v", applied)
	}
}

func TestMigrateKeepsSessionsUntouched(t *testing.T) {
	slotDir := t.TempDir()
	sessDir := filepath.Join(slotDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	raw := []byte("{\"v\":1,\"kind\":\"turn\",\"id\":\"s1\",\"messages\":[]}\n{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\",\"title\":\"T\"}\n")
	os.WriteFile(filepath.Join(sessDir, "s1.jsonl"), raw, 0o600)
	if _, err := Migrate(slotDir); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(sessDir, "s1.jsonl"))
	if err != nil || string(got) != string(raw) {
		t.Fatal("migration must not touch session files")
	}
}

func TestMigrateV1ToV2SweepsBgFiles(t *testing.T) {
	slotDir := t.TempDir()
	// Stamp v1 manually, then plant v1 bg leftovers.
	os.WriteFile(filepath.Join(slotDir, "storage_version.json"), []byte("{\"version\": 1}"), 0o600)
	runners := filepath.Join(slotDir, "runners", "out")
	os.MkdirAll(runners, 0o700)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.state.json"), []byte("{}"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.disposition"), []byte("background\n"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "j1.launch"), []byte(""), 0o600)
	os.WriteFile(filepath.Join(runners, "s__j1__123.log"), []byte("out"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "runners", "indirect-code-runner-v1"), []byte("bin"), 0o600)
	os.MkdirAll(filepath.Join(slotDir, "bg"), 0o700)
	os.WriteFile(filepath.Join(slotDir, "bg", "j1.pid.json"), []byte("{}"), 0o600)
	os.WriteFile(filepath.Join(slotDir, "bg", "j1.notice.json"), []byte("{}"), 0o600)
	os.MkdirAll(filepath.Join(slotDir, "brain", "s1"), 0o700)
	os.WriteFile(filepath.Join(slotDir, "brain", "s1", "bg_bash__j1.log"), []byte("brain"), 0o600)
	// A session file must survive.
	os.MkdirAll(filepath.Join(slotDir, "sessions"), 0o700)
	sess := []byte("{\"v\":1,\"kind\":\"meta\",\"id\":\"s1\"}\n")
	os.WriteFile(filepath.Join(slotDir, "sessions", "s1.jsonl"), sess, 0o600)

	applied, err := Migrate(slotDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != 2 {
		t.Fatalf("applied = %v, want [2]", applied)
	}
	for _, p := range []string{
		"runners/j1.state.json", "runners/j1.disposition", "runners/j1.launch",
		"runners/out/s__j1__123.log", "runners/indirect-code-runner-v1",
		"bg/j1.pid.json", "bg/j1.notice.json", "brain/s1/bg_bash__j1.log",
	} {
		if _, err := os.Stat(filepath.Join(slotDir, p)); !os.IsNotExist(err) {
			t.Fatalf("%s must be swept", p)
		}
	}
	got, _ := os.ReadFile(filepath.Join(slotDir, "sessions", "s1.jsonl"))
	if string(got) != string(sess) {
		t.Fatal("session files must survive v2")
	}
	// Idempotent.
	if _, err := Migrate(slotDir); err != nil {
		t.Fatal(err)
	}
}
