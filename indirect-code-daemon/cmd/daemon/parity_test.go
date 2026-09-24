package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestParityV1Format: v2 opens a session file written in v1 format
// (turn-lines + meta, same JSON keys) and serves identical content.
// This is the byte-compat gate for cutover: existing data dirs open
// in v2 with zero migration.
func TestParityV1Format(t *testing.T) {
	dir := t.TempDir()
	sessDir := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sid := "sess_parity01"
	turn1 := `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"user","content":[{"type":"text","text":"hello"}],"turnIndex":1},{"role":"assistant","content":[{"type":"text","text":"hi there"}],"turnIndex":1}],"usage":{}}`
	meta := `{"v":1,"kind":"meta","id":"` + sid + `","cwd":"/tmp","title":"parity","model":"m","status":"idle","createdAt":1,"updatedAt":2,"turnSeq":1,"options":{"effort":"none","mode":"talk","access":"full"}}`
	if err := os.WriteFile(filepath.Join(sessDir, sid+".jsonl"), []byte(turn1+"\n"+meta+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	st := newDiskStore(dir)
	rec, _, err := st.loadSessionFused(sid)
	if err != nil {
		t.Fatalf("v2 cannot open v1 file: %v", err)
	}
	if len(rec.Messages) != 2 {
		t.Fatalf("want 2 messages, got %d", len(rec.Messages))
	}
	if rec.Title != "parity" || rec.TurnSeq != 1 || rec.Status != "idle" {
		t.Fatalf("bad record: %+v", rec)
	}
	// Round-trip: save + reload identical.
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	rec2, _, err := st.loadSessionFused(sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(rec2.Messages) != 2 || rec2.Title != "parity" {
		t.Fatalf("round-trip mismatch: %+v", rec2)
	}
	// Summaries list it (dashboard pull path).
	found := false
	for _, s := range listSessionSummaries(dir) {
		if s.ID == sid && s.Title == "parity" {
			found = true
		}
	}
	if !found {
		t.Fatalf("listSessionSummaries missed v1 session")
	}
}
