package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/patriceckhart/zot/packages/agent/tools"
	"github.com/patriceckhart/zot/packages/core"
)

func TestSessionChoicesPersistIndependentlyAndRememberLastSelection(t *testing.T) {
	d := testDaemon(t)
	d.configPath = filepath.Join(d.dataDir, "config.json")
	for _, id := range []string{"one", "two"} {
		if err := d.saveSession(&SessionRecord{ID: id, Model: "first", Status: "idle"}); err != nil {
			t.Fatal(err)
		}
	}
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"one","model":"custom/one","options":{"effort":"high","mode":"learning","skills":["review","style"],"access":"ask"}}`))
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"two","model":"custom/two","options":{"effort":"low","mode":"plan","access":"full"}}`))
	one, err := d.loadSession("one")
	if err != nil {
		t.Fatal(err)
	}
	two, err := d.loadSession("two")
	if err != nil {
		t.Fatal(err)
	}
	if one.Model != "custom/one" || one.Options.Effort != "high" || one.Options.Mode != "learning" || len(one.Options.Skills) != 2 || one.Options.Access != "ask" {
		t.Fatalf("first session choices were overwritten: %+v", one.Options)
	}
	if two.Model != "custom/two" || two.Options.Effort != "low" || d.config.LastSelection.Model != "custom/two" || d.config.LastSelection.Effort != "low" {
		t.Fatal("last choice was not remembered independently")
	}
	d.handleMessage([]byte(`{"type":"update_config","settings":{"temperature":0.2},"skills":{"review":{"name":"review","enabled":true},"style":{"name":"style","enabled":true}}}`))
	var saved DaemonConfig
	data, err := os.ReadFile(d.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.LastSelection.Model != "custom/two" || len(saved.Skills) != 2 || !saved.Settings.NoAutoTitle {
		t.Fatal("saving settings lost choices, a skill, or omitted settings")
	}
	if normalizedOptions(SessionOptions{}).Effort != "medium" {
		t.Fatal("first choice must default to medium")
	}
}

func TestBrowseFoldersNavigatesWithoutCreatingPaths(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{".config", "project", "other"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, parent, entries, err := browseFolders(root)
	if err != nil || path != root || parent != filepath.Dir(root) || len(entries) != 3 || entries[0].Name != ".config" {
		t.Fatalf("unexpected folder listing: %q %q %+v %v", path, parent, entries, err)
	}
	if _, _, _, err := browseFolders(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing folder should fail")
	}
	if _, err := os.Stat(filepath.Join(root, "missing")); !os.IsNotExist(err) {
		t.Fatal("browsing created a folder")
	}
}

func TestModesExposeTheirIntendedTools(t *testing.T) {
	for _, mode := range []string{"plan", "learning"} {
		reg := core.NewRegistry(&tools.ReadTool{}, &tools.GlobTool{}, &tools.BashTool{}, &tools.WriteTool{}, &tools.EditTool{}, &tools.TodoTool{})
		restrictModeTools(reg, mode)
		if reg["write"] != nil || reg["edit"] != nil || reg["read"] == nil || reg["glob"] == nil || reg["todo"] == nil {
			t.Fatal("mode exposed the wrong file tools or lost the checklist")
		}
		if (reg["bash"] != nil) != (mode == "learning") {
			t.Fatal("Learning must retain the shell; Plan must not")
		}
		if modeInstructions(mode) == "" {
			t.Fatal("missing mode instructions")
		}
	}
}

func reviewFixture(t *testing.T) (*DaemonServer, *reviewJournal, *tools.Sandbox) {
	t.Helper()
	d := testDaemon(t)
	cwd := t.TempDir()
	rec := &SessionRecord{ID: "review-session", CWD: cwd, Status: "idle"}
	act := &ActiveSession{record: rec, gen: 1}
	d.sessions[rec.ID] = act
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	return d, newReviewJournal(d, act, 1, cwd, d.config.HostID, rec.ID), tools.NewSandbox(cwd)
}

func reviewedWrite(t *testing.T, j *reviewJournal, sb *tools.Sandbox, path, text string) {
	t.Helper()
	tool := &reviewedTool{Tool: &tools.WriteTool{CWD: j.cwd, Sandbox: sb}, journal: j}
	args, _ := json.Marshal(map[string]string{"path": path, "content": text})
	if _, err := tool.Execute(context.Background(), args, nil); err != nil {
		t.Fatal(err)
	}
}

func undoReview(d *DaemonServer, j *reviewJournal, path string) {
	data, _ := json.Marshal(map[string]any{"type": "undo_changes", "sessionId": j.sessionID, "reviewId": j.review.ID, "path": path})
	d.handleMessage(data)
}

func TestReviewUndoRestoresDirtyFilesAndDeletesNewFilesAfterReload(t *testing.T) {
	d, j, sb := reviewFixture(t)
	original := filepath.Join(j.cwd, "original.py")
	if err := os.WriteFile(original, []byte("my uncommitted work\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	reviewedWrite(t, j, sb, "original.py", "print('updated')\n")
	reviewedWrite(t, j, sb, "new.ts", "export const value = 1;\n")
	if len(j.review.Files) != 2 {
		t.Fatal("missing recorded changes")
	}
	// Simulate reconnect/restart: undo reads the journal from disk.
	d.sessions = map[string]*ActiveSession{}
	undoReview(d, j, "")
	got, err := os.ReadFile(original)
	if err != nil || string(got) != "my uncommitted work\n" {
		t.Fatal("undo discarded pre-task edits")
	}
	info, _ := os.Stat(original)
	if info.Mode().Perm() != 0o640 {
		t.Fatal("undo did not restore permissions")
	}
	if _, err := os.Stat(filepath.Join(j.cwd, "new.ts")); !os.IsNotExist(err) {
		t.Fatal("undo did not remove the newly created file")
	}
	data, _ := os.ReadFile(d.reviewPath(j.sessionID))
	var stored taskReview
	_ = json.Unmarshal(data, &stored)
	if len(stored.public(false)["files"].([]map[string]any)) != 0 {
		t.Fatal("undone changes still counted")
	}
}

func TestReviewUndoPreflightPreservesEditsMadeAfterTask(t *testing.T) {
	d, j, sb := reviewFixture(t)
	reviewedWrite(t, j, sb, "one.txt", "agent one")
	reviewedWrite(t, j, sb, "two.txt", "agent two")
	if err := os.WriteFile(filepath.Join(j.cwd, "one.txt"), []byte("my later edit"), 0o644); err != nil {
		t.Fatal(err)
	}
	undoReview(d, j, "")
	one, _ := os.ReadFile(filepath.Join(j.cwd, "one.txt"))
	two, _ := os.ReadFile(filepath.Join(j.cwd, "two.txt"))
	if string(one) != "my later edit" || string(two) != "agent two" {
		t.Fatal("conflicting undo partially changed files")
	}
}

func TestReviewCapturesShellChangesAndProtectsEditsBetweenTools(t *testing.T) {
	d, j, sb := reviewFixture(t)
	tool := &reviewedTool{Tool: &tools.BashTool{CWD: j.cwd, Sandbox: sb}, journal: j}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"printf shell > shell.txt"}`), nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := j.review.Files[filepath.Join(j.cwd, "shell.txt")]; !ok {
		t.Fatal("shell-created file was not recorded")
	}
	reviewedWrite(t, j, sb, "one.txt", "agent first")
	if err := os.WriteFile(filepath.Join(j.cwd, "one.txt"), []byte("user between tools"), 0o644); err != nil {
		t.Fatal(err)
	}
	reviewedWrite(t, j, sb, "one.txt", "agent second")
	undoReview(d, j, filepath.Join(j.cwd, "one.txt"))
	got, _ := os.ReadFile(filepath.Join(j.cwd, "one.txt"))
	if string(got) != "agent second" || !j.review.Files[filepath.Join(j.cwd, "one.txt")].Conflict {
		t.Fatal("interleaved user changes not protected")
	}
	if !strings.Contains(modeInstructions("learning"), "one guiding question") {
		t.Fatal("Learning lost its Socratic behavior")
	}
}

func TestShellReviewChangingIgnoreRulesPreservesExistingFiles(t *testing.T) {
	d, j, sb := reviewFixture(t)
	for path, content := range map[string]string{".gitignore": "local.txt\n", "local.txt": "my existing local work"} {
		if err := os.WriteFile(filepath.Join(j.cwd, path), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	tool := &reviewedTool{Tool: &tools.BashTool{CWD: j.cwd, Sandbox: sb}, journal: j}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{"command":"git init -q && printf '' > .gitignore && printf updated > local.txt"}`), nil); err != nil {
		t.Fatal(err)
	}
	undoReview(d, j, "")
	got, err := os.ReadFile(filepath.Join(j.cwd, "local.txt"))
	if err != nil || string(got) != "my existing local work" {
		t.Fatal("changing ignore rules caused undo to lose an existing file")
	}
}

func TestReviewUndoDoesNotFollowReplacedParentSymlink(t *testing.T) {
	d, j, sb := reviewFixture(t)
	reviewedWrite(t, j, sb, "src/file.txt", "agent content")
	out := t.TempDir()
	if err := os.WriteFile(filepath.Join(out, "file.txt"), []byte("agent content"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(j.cwd, "src")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(j.cwd, "src")); err != nil {
		t.Fatal(err)
	}
	undoReview(d, j, "")
	got, err := os.ReadFile(filepath.Join(out, "file.txt"))
	if err != nil || string(got) != "agent content" {
		t.Fatal("undo followed a replaced parent symlink")
	}
}

func TestReviewUndoDoesNotBlockCommandsWhileOtherTaskChangesFiles(t *testing.T) {
	d, j, sb := reviewFixture(t)
	reviewedWrite(t, j, sb, "file.txt", "agent content")
	d.filesMu.Lock()
	defer d.filesMu.Unlock()
	undoReview(d, j, "")
	got, err := os.ReadFile(filepath.Join(j.cwd, "file.txt"))
	if err != nil || string(got) != "agent content" {
		t.Fatal("undo overlapped another task's file mutation")
	}
}
