package migrations

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLegacy(t *testing.T, dir, sid string, turns int) {
	t.Helper()
	var msgs []map[string]any
	for turn := 1; turn <= turns; turn++ {
		msgs = append(msgs,
			map[string]any{"role": "user", "turnIndex": turn, "content": []any{map[string]any{"type": "text", "text": "q"}}},
			map[string]any{"role": "assistant", "turnIndex": turn, "content": []any{map[string]any{"type": "text", "text": "a"}}},
		)
	}
	rec := map[string]any{
		"id": sid, "cwd": "/tmp", "title": "T", "model": "m", "status": "idle",
		"createdAt": 1, "updatedAt": 2, "turnSeq": turns,
		"messages": msgs,
		"fileBalloons": []any{
			map[string]any{"turnIndex": 1, "files": []any{map[string]any{"path": "/x"}}},
		},
	}
	data, _ := json.Marshal(rec)
	if err := os.WriteFile(filepath.Join(dir, sid+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestMigrateJSONToJSONL(t *testing.T) {
	dataDir := t.TempDir()
	sessDir := filepath.Join(dataDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	writeLegacy(t, sessDir, "s1", 3)
	writeLegacy(t, sessDir, "s2", 1)

	applied, err := Migrate(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 || applied[0] != 1 {
		t.Fatalf("applied = %v", applied)
	}
	// Legacy removed, jsonl present with meta tail + all messages.
	for _, sid := range []string{"s1", "s2"} {
		if _, err := os.Stat(filepath.Join(sessDir, sid+".json")); !os.IsNotExist(err) {
			t.Fatalf("%s.json survived", sid)
		}
		raw, err := os.ReadFile(filepath.Join(sessDir, sid+".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		if err := verifyConverted(filepath.Join(sessDir, sid+".jsonl"), sid, map[string]int{"s1": 6, "s2": 2}[sid]); err != nil {
			t.Fatal(err)
		}
		_ = raw
	}
	// Idempotent re-run.
	applied, err = Migrate(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 0 {
		t.Fatalf("re-run applied %v", applied)
	}
	v, err := StoredVersion(dataDir)
	if err != nil || v != 1 {
		t.Fatalf("version = %d, %v", v, err)
	}
}

func TestMigrateEmptyDir(t *testing.T) {
	dataDir := t.TempDir()
	applied, err := Migrate(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 {
		t.Fatalf("empty dir should stamp v1, got %v", applied)
	}
}

func TestMigratePartialFailureResumes(t *testing.T) {
	dataDir := t.TempDir()
	sessDir := filepath.Join(dataDir, "sessions")
	os.MkdirAll(sessDir, 0o700)
	writeLegacy(t, sessDir, "good", 2)
	// Corrupt session: fails conversion mid-chain.
	os.WriteFile(filepath.Join(sessDir, "bad.json"), []byte(`{"id":`), 0o600)
	if _, err := Migrate(dataDir); err == nil {
		t.Fatal("corrupt session must abort migration")
	}
	// Version unbumped (chain resumes on retry).
	if v, _ := StoredVersion(dataDir); v != 0 {
		t.Fatalf("version = %d; want 0 (unbumped)", v)
	}
	// Good session may or may not be converted (order-dependent) — but a
	// retry after fixing the bad file must converge fully.
	os.Remove(filepath.Join(sessDir, "bad.json"))
	writeLegacy(t, sessDir, "bad", 1)
	applied, err := Migrate(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(applied) != 1 {
		t.Fatalf("retry applied %v", applied)
	}
	if v, _ := StoredVersion(dataDir); v != 1 {
		t.Fatalf("version = %d; want 1", v)
	}
	// Both sessions readable with correct message counts.
	for sid, want := range map[string]int{"good": 4, "bad": 2} {
		raw, err := os.ReadFile(filepath.Join(sessDir, sid+".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		if got := countTurnMessages(t, raw); got != want {
			t.Fatalf("%s: %d msgs; want %d", sid, got, want)
		}
	}
}

func countTurnMessages(t *testing.T, raw []byte) int {
	t.Helper()
	n := 0
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var tl struct {
			Kind     string            `json:"kind"`
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal([]byte(line), &tl); err != nil {
			t.Fatal(err)
		}
		if tl.Kind == "turn" {
			n += len(tl.Messages)
		}
	}
	return n
}
