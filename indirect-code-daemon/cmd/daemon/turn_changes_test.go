package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

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

// TestTurnTrackingEndToEnd simulates one turn: read + edit + write(new) +
// write(existing), then builds the balloon, broadcasts nothing, and undoes it.
func TestTurnTrackingEndToEnd(t *testing.T) {
	dir := t.TempDir()
	existing := writeFile(t, dir, "main.go", "package main\n\nfunc main() {}\n")
	writeFile(t, dir, "touched.go", "package main\n")

	tr := filetrack.NewTurnTracker()
	readTool := &tools.ReadTool{CWD: dir, Changes: tr}
	writeTool := &tools.WriteTool{CWD: dir, Changes: tr}
	editTool := &tools.EditTool{CWD: dir, Changes: tr}
	ctx := context.Background()

	// 1. read existing (snapshots content, no balloon yet since unchanged).
	if _, err := readTool.Execute(ctx, mustJSON(t, map[string]any{"path": "touched.go"}), nil); err != nil {
		t.Fatal(err)
	}
	// 2. edit existing (snapshot before, then modify).
	if _, err := editTool.Execute(ctx, mustJSON(t, map[string]any{
		"path": "main.go",
		"edits": []map[string]any{
			{"oldText": "func main() {}", "newText": "func main() {\n\tprintln(\"hi\")\n}"},
		},
	}), nil); err != nil {
		t.Fatal(err)
	}
	// 3. write new file (marked new, no content stored).
	if _, err := writeTool.Execute(ctx, mustJSON(t, map[string]any{"path": "new.txt", "content": "created\n"}), nil); err != nil {
		t.Fatal(err)
	}
	// 4. write over existing (snapshots old content).
	if _, err := writeTool.Execute(ctx, mustJSON(t, map[string]any{"path": "touched.go", "content": "package main\n\n// touched\n"}), nil); err != nil {
		t.Fatal(err)
	}

	files := filetrack.BuildChanged(tr.Snapshot(), dir)
	if len(files) != 3 {
		t.Fatalf("want 3 changed files (main.go modified, touched.go modified, new.txt new): %+v", files)
	}
	byRel := map[string]filetrack.ChangedFile{}
	for _, f := range files {
		byRel[f.Rel] = f
	}
	if byRel["main.go"].Status != "modified" || byRel["main.go"].ReversePatch == "" {
		t.Fatalf("main.go must be modified with reverse patch: %+v", byRel["main.go"])
	}
	if byRel["touched.go"].Status != "modified" {
		t.Fatalf("touched.go must be modified: %+v", byRel["touched.go"])
	}
	if byRel["new.txt"].Status != "new" {
		t.Fatalf("new.txt must be new: %+v", byRel["new.txt"])
	}

	// Undo everything via reverse patches + new-file removal.
	d := &DaemonServer{sessions: map[string]*ActiveSession{}}
	act := &ActiveSession{record: &SessionRecord{
		ID: "s1", CWD: dir,
		FileBalloons: []filetrack.TurnChanges{{TurnIndex: 1, Files: files}},
	}}
	results, complete := d.undoTurnChanges(act, 1, "")
	if !complete || len(results) != 3 {
		t.Fatalf("undo must complete all 3: complete=%v results=%+v", complete, results)
	}
	for _, r := range results {
		if !r.OK {
			t.Fatalf("undo failed for %s: %s", r.Path, r.Message)
		}
	}
	if data, _ := os.ReadFile(existing); string(data) != "package main\n\nfunc main() {}\n" {
		t.Fatalf("main.go not restored: %q", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("new.txt must be removed by undo")
	}
	// Balloon persists with Undone flags.
	if len(act.record.FileBalloons) != 1 {
		t.Fatal("balloon must persist after undo")
	}
	for _, f := range act.record.FileBalloons[0].Files {
		if !f.Undone {
			t.Fatalf("file %s must be marked undone", f.Path)
		}
	}
}

// TestUndoRefusesToDeleteChangedNewFile: if the user edited a created file
// after the turn, undo must not remove it and must report partial failure.
func TestUndoRefusesToDeleteChangedNewFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "new.txt")
	if err := os.WriteFile(p, []byte("turn content\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// User edits it afterwards.
	if err := os.WriteFile(p, []byte("turn content\nuser edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d := &DaemonServer{sessions: map[string]*ActiveSession{}}
	act := &ActiveSession{record: &SessionRecord{
		ID: "s1", CWD: dir,
		FileBalloons: []filetrack.TurnChanges{{TurnIndex: 2, Files: []filetrack.ChangedFile{
			{Path: p, Rel: "new.txt", Status: "new", After: "turn content\n"},
		}}},
	}}
	results, complete := d.undoTurnChanges(act, 2, "")
	if complete {
		t.Fatal("undo must report partial failure")
	}
	if len(results) != 1 || results[0].OK {
		t.Fatalf("undo must refuse: %+v", results)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("file must be left untouched")
	}
}

