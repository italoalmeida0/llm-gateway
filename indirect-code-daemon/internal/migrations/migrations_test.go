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
