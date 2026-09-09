package filetrack

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestFirstSightingWins(t *testing.T) {
	tr := NewTurnTracker()
	tr.NoteRead("/a.txt", "v1")
	tr.NoteRead("/a.txt", "v2")
	tr.NoteEditBefore("/a.txt", "v3")
	tr.NoteWrite("/a.txt", true, "v4")
	snap := tr.Snapshot()
	if len(snap) != 1 || snap[0].Before != "v1" {
		t.Fatalf("first sighting must win: %+v", snap)
	}
}

func TestWriteNewThenBuild(t *testing.T) {
	dir := t.TempDir()
	tr := NewTurnTracker()
	p := filepath.Join(dir, "new.txt")
	tr.NoteWrite(p, false, "")
	if err := os.WriteFile(p, []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed := BuildChanged(tr.Snapshot(), dir)
	if len(changed) != 1 || changed[0].Status != "new" {
		t.Fatalf("want one new file: %+v", changed)
	}
	if !strings.Contains(changed[0].Diff, "+hello") || !strings.Contains(changed[0].Diff, "+world") {
		t.Fatalf("new diff must list added lines:\n%s", changed[0].Diff)
	}
	if changed[0].Additions != 2 {
		t.Fatalf("additions = %d, want 2", changed[0].Additions)
	}
}

func TestWriteNewThenDeletedIsIgnored(t *testing.T) {
	dir := t.TempDir()
	tr := NewTurnTracker()
	p := filepath.Join(dir, "tmp.txt")
	tr.NoteWrite(p, false, "")
	// File never materialized on disk: created and deleted within the turn.
	changed := BuildChanged(tr.Snapshot(), dir)
	if len(changed) != 0 {
		t.Fatalf("created-then-deleted must be ignored: %+v", changed)
	}
}

func TestModifiedAndDeleted(t *testing.T) {
	dir := t.TempDir()
	mod := writeFile(t, dir, "mod.txt", "a\nb\nc\n")
	del := writeFile(t, dir, "del.txt", "x\ny\n")
	tr := NewTurnTracker()
	tr.NoteEditBefore(mod, "a\nb\nc\n")
	tr.NoteRead(del, "x\ny\n")
	if err := os.WriteFile(mod, []byte("a\nB\nc\nd\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(del); err != nil {
		t.Fatal(err)
	}
	changed := BuildChanged(tr.Snapshot(), dir)
	if len(changed) != 2 {
		t.Fatalf("want modified+deleted: %+v", changed)
	}
	var m, d *ChangedFile
	for i := range changed {
		if changed[i].Status == "modified" {
			m = &changed[i]
		}
		if changed[i].Status == "deleted" {
			d = &changed[i]
		}
	}
	if m == nil || d == nil {
		t.Fatalf("missing entries: %+v", changed)
	}
	if !strings.Contains(m.Diff, "-b") || !strings.Contains(m.Diff, "+B") || !strings.Contains(m.Diff, "+d") {
		t.Fatalf("modified diff wrong:\n%s", m.Diff)
	}
	if m.ReversePatch == "" {
		t.Fatal("modified must carry a reverse patch")
	}
	if !strings.Contains(d.Diff, "-x") {
		t.Fatalf("deleted diff wrong:\n%s", d.Diff)
	}
	if m.Rel != "mod.txt" || d.Rel != "del.txt" {
		t.Fatalf("rel paths wrong: %q %q", m.Rel, d.Rel)
	}
}

func TestReadOnlyIsNotChanged(t *testing.T) {
	dir := t.TempDir()
	p := writeFile(t, dir, "same.txt", "same\n")
	tr := NewTurnTracker()
	tr.NoteRead(p, "same\n")
	if changed := BuildChanged(tr.Snapshot(), dir); len(changed) != 0 {
		t.Fatalf("merely read files must not appear: %+v", changed)
	}
}

func TestReversePatchRoundTrip(t *testing.T) {
	before := "line1\nline2\nline3\n"
	after := "line1\nLINE2\nline3\nline4\n"
	rp := MakeReversePatch(after, before)
	if rp == "" {
		t.Fatal("empty reverse patch")
	}
	restored, applied, err := ApplyReversePatch(rp, after)
	if err != nil {
		t.Fatal(err)
	}
	for _, ok := range applied {
		if !ok {
			t.Fatalf("hunk not applied: %v", applied)
		}
	}
	if restored != before {
		t.Fatalf("round trip failed: %q", restored)
	}
}

func TestUnifiedDiffCounts(t *testing.T) {
	diff, adds, dels := UnifiedDiff("f.txt", "a\nb\nc\n", "a\nB\nc\nd\n")
	if adds != 2 || dels != 1 {
		t.Fatalf("adds=%d dels=%d, want 2/1:\n%s", adds, dels, diff)
	}
	if !strings.Contains(diff, "@@ ") || !strings.Contains(diff, "--- f.txt") {
		t.Fatalf("missing unified headers:\n%s", diff)
	}
}
