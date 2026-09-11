package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
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
	// dataDir points at a temp dir: undoTurnChanges persists the undone
	// balloon via saveSession, which would otherwise write sessions/s1.json
	// relative to the package dir (empty dataDir).
	d := &DaemonServer{dataDir: t.TempDir(), sessions: map[string]*ActiveSession{}}
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


func TestDropBalloonsAboveKeepsPrefix(t *testing.T) {
	in := []filetrack.TurnChanges{
		{TurnIndex: 1, MessageIndex: 2},
		{TurnIndex: 2, MessageIndex: 5},
		{TurnIndex: 3}, // unanchored legacy record: kept
	}
	got := dropBalloonsAbove(in, 2)
	if len(got) != 2 || got[0].TurnIndex != 1 || got[1].TurnIndex != 3 {
		t.Fatalf("want turns [1 3], got %+v", got)
	}
	if out := dropBalloonsAbove(nil, 0); out != nil {
		t.Fatalf("nil must stay nil, got %+v", out)
	}
}

func TestEditMessageTrimsDiscardedBalloons(t *testing.T) {
	d := testDaemon(t)
	userMsg := func(text string) provider.Message {
		return provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: text}}}
	}
	asstMsg := func(text string) provider.Message {
		return provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: text}}}
	}
	rec := &SessionRecord{
		ID: "s-balloon", CWD: t.TempDir(), Title: "T", Model: "m", Status: "idle",
		Messages: []provider.Message{userMsg("q1"), asstMsg("a1"), userMsg("q2"), asstMsg("a2")},
		FileBalloons: []filetrack.TurnChanges{
			{TurnIndex: 1, MessageIndex: 2, Files: []filetrack.ChangedFile{{Path: "a"}}},
			{TurnIndex: 2, MessageIndex: 4, Files: []filetrack.ChangedFile{{Path: "b"}}},
		},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	// Plain edit (no regenerate) at message 2: keeps 3 messages, so the
	// turn-1 balloon (anchored at 2) survives while turn-2 (anchored at
	// 4) goes with the discarded tail.
	raw, _ := json.Marshal(map[string]any{
		"type": "edit_message", "sessionId": "s-balloon", "index": 2, "text": "q2 edited",
	})
	d.handleMessage(raw)
	after, err := d.loadSession("s-balloon")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Messages) != 3 {
		t.Fatalf("want 3 messages kept, got %d", len(after.Messages))
	}
	if len(after.FileBalloons) != 1 || after.FileBalloons[0].TurnIndex != 1 {
		t.Fatalf("want only turn-1 balloon, got %+v", after.FileBalloons)
	}
	// Deeper cut at message 0: every balloon anchored past it drops too.
	raw, _ = json.Marshal(map[string]any{
		"type": "edit_message", "sessionId": "s-balloon", "index": 0, "text": "q1 edited",
	})
	d.handleMessage(raw)
	after, err = d.loadSession("s-balloon")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.FileBalloons) != 0 {
		t.Fatalf("want no balloons after full cut, got %+v", after.FileBalloons)
	}
}

func TestBrainFilesNeverBecomeBalloons(t *testing.T) {
	d := testDaemon(t)
	dir := t.TempDir()
	brain := filepath.Join(d.dataDir, "brain", "s-brain")
	if err := os.MkdirAll(brain, 0o700); err != nil {
		t.Fatal(err)
	}
	brainFile := filepath.Join(brain, "notes.md")
	if err := os.WriteFile(brainFile, []byte("scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	normalFile := filepath.Join(dir, "main.go")
	if err := os.WriteFile(normalFile, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	act := &ActiveSession{record: &SessionRecord{ID: "s-brain", CWD: dir}}
	tfc := beginTurnTracking(act, dir, 1, brain)
	// Simulate tools that tracked brain paths anyway (old journal shape).
	tfc.tracker.NoteRead(brainFile, "scratch\n")
	tfc.tracker.NoteWrite(normalFile, true, "package main\n")
	if err := os.WriteFile(normalFile, []byte("package main\n\n// touched\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	balloon := d.finishTurnTracking(act, tfc)
	if balloon == nil || len(balloon.Files) != 1 || balloon.Files[0].Path != normalFile {
		t.Fatalf("brain file leaked into balloon: %+v", balloon)
	}
	// Preview path filters too.
	tfc2 := beginTurnTracking(act, dir, 2, brain)
	tfc2.tracker.NoteRead(brainFile, "scratch\n")
	if files := previewIncoming(tfc2); len(files) != 0 {
		t.Fatalf("brain file leaked into live preview: %+v", files)
	}
	// Persisted balloons carrying brain files are stripped on read paths.
	stripped := stripBrainBalloonFiles([]filetrack.TurnChanges{
		{TurnIndex: 1, Files: []filetrack.ChangedFile{{Path: brainFile}, {Path: normalFile}}},
		{TurnIndex: 2, Files: []filetrack.ChangedFile{{Path: brainFile}}},
	}, brain)
	if len(stripped) != 1 || len(stripped[0].Files) != 1 || stripped[0].Files[0].Path != normalFile {
		t.Fatalf("stripBrainBalloonFiles wrong: %+v", stripped)
	}
	// Journal restore path filters too.
	restored := dropBrainTracked([]filetrack.TrackedFile{{Path: brainFile}, {Path: normalFile}}, brain)
	if len(restored) != 1 || restored[0].Path != normalFile {
		t.Fatalf("dropBrainTracked wrong: %+v", restored)
	}
}
