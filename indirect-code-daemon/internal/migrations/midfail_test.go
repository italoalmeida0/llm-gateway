package migrations

import (
	"os"
	"path/filepath"
	"testing"
)

// Corrupt legacy JSON mid-batch: chain aborts, version NOT bumped,
// healthy sessions converted, corrupt one left for retry.
func TestMigrateMidFailure(t *testing.T) {
	dataDir := t.TempDir()
	sessDir := filepath.Join(dataDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	writeLegacy(t, sessDir, "good", 1)
	os.WriteFile(filepath.Join(sessDir, "bad.json"), []byte(`{"id":`), 0o600)

	_, err := Migrate(dataDir)
	if err == nil {
		t.Fatal("corrupt json must abort chain")
	}
	// Version NOT bumped (retry resumes correctly).
	if v, _ := StoredVersion(dataDir); v != 0 {
		t.Fatalf("version bumped on failure: %d", v)
	}
	// good.json converted (or skipped on retry — idempotent either way).
	// bad.json still present for the next attempt.
	if _, err := os.Stat(filepath.Join(sessDir, "bad.json")); err != nil {
		t.Fatal("corrupt file must survive for retry")
	}
	// Fix + retry: full chain completes.
	os.WriteFile(filepath.Join(sessDir, "bad.json"), []byte(`{"id":"bad","cwd":"/tmp","title":"B","model":"m","status":"idle","messages":[]}`), 0o600)
	applied, err := Migrate(dataDir)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if len(applied) == 0 {
		t.Fatal("retry must apply")
	}
	if v, _ := StoredVersion(dataDir); v != 1 {
		t.Fatalf("version = %d", v)
	}
}
