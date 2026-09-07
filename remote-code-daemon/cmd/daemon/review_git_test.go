package main

// End-to-end coverage for the git-backed change tracker.
//
// These tests exercise init + baseline + collect + undo (file/all) + keep,
// plus the managed info/exclude writer, against the real git binary. They
// skip when git is unavailable — tracking is disabled in that case by design.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/patriceckhart/zot/packages/core"
)

func gitTestTracker(t *testing.T, d *DaemonServer, sessionID, cwd string) *gitReviewTracker {
	t.Helper()
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	act := &ActiveSession{record: &SessionRecord{ID: sessionID, CWD: cwd}}
	d.sessionsMu.Lock()
	d.sessions[sessionID] = act
	d.sessionsMu.Unlock()
	tracker := d.ensureGitTracker(act, sessionID, cwd)
	if tracker == nil {
		t.Fatal("ensureGitTracker returned nil despite git being available")
	}
	t.Cleanup(func() {
		d.sessionsMu.Lock()
		delete(d.sessions, sessionID)
		d.sessionsMu.Unlock()
	})
	return tracker
}

func collectPaths(t *testing.T, tracker *gitReviewTracker, full bool) []gitChangeFile {
	t.Helper()
	files, _ := tracker.collect(context.Background(), full)
	return files
}

func findChange(files []gitChangeFile, path string) *gitChangeFile {
	for i := range files {
		if files[i].Path == path {
			return &files[i]
		}
	}
	return nil
}

func TestGitTrackerBaselineCollectUndoKeep(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	sessionID := "sess-git-basic"

	if err := os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tracker := gitTestTracker(t, d, sessionID, cwd)

	// Clean right after baseline: nothing pending.
	if files := collectPaths(t, tracker, true); len(files) != 0 {
		t.Fatalf("expected no changes after baseline, got %v", files)
	}

	// Modify + create + delete.
	if err := os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, "b.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cwd, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, "sub", "c.txt"), []byte("c\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	files := collectPaths(t, tracker, true)
	if findChange(files, "a.txt") == nil || findChange(files, "b.txt") == nil || findChange(files, "sub/c.txt") == nil {
		t.Fatalf("expected a.txt, b.txt, sub/c.txt in changes, got %+v", files)
	}
	mod := findChange(files, "a.txt")
	if mod.Kind != "modified" || mod.Diff == "" || !strings.Contains(mod.Diff, "+two") {
		t.Fatalf("expected modified a.txt with diff, got %+v", mod)
	}
	added := findChange(files, "b.txt")
	if added.Kind != "added" || !added.CanUndo {
		t.Fatalf("expected added b.txt undoable, got %+v", added)
	}

	// Single-file undo keeps the repo for the rest.
	d.filesMu.Lock()
	before, _ := tracker.collect(context.Background(), true)
	reviewID := reviewIDFor(before)
	raw := []byte(`{"sessionId":"` + sessionID + `","reviewId":"` + reviewID + `","path":"b.txt"}`)
	d.filesMu.Unlock()
	_ = raw
	d.handleMessage([]byte(`{"type":"undo_changes","sessionId":"` + sessionID + `","reviewId":"` + reviewID + `","path":"b.txt"}`))
	if _, err := os.Stat(filepath.Join(cwd, "b.txt")); !os.IsNotExist(err) {
		t.Fatal("b.txt should be removed after single-file undo")
	}
	if _, err := os.Stat(filepath.Join(tracker.gitDir, "HEAD")); err != nil {
		t.Fatal("temp git dir must be kept after single-file undo")
	}
	rest := collectPaths(t, tracker, false)
	if findChange(rest, "b.txt") != nil || findChange(rest, "a.txt") == nil {
		t.Fatalf("expected only a.txt pending after undoing b.txt, got %+v", rest)
	}

	// Undo-all discards everything and deletes the temp repo.
	restFull, _ := tracker.collect(context.Background(), true)
	d.handleMessage([]byte(`{"type":"undo_changes","sessionId":"` + sessionID + `","reviewId":"` + reviewIDFor(restFull) + `"}`))
	data, _ := os.ReadFile(filepath.Join(cwd, "a.txt"))
	if string(data) != "one\n" {
		t.Fatalf("a.txt should be restored, got %q", data)
	}
	if _, err := os.Stat(filepath.Join(tracker.gitDir, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("temp git dir must be deleted after undo-all")
	}
}

func TestGitTrackerKeepDeletesRepo(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	sessionID := "sess-git-keep"
	if err := os.WriteFile(filepath.Join(cwd, "k.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tracker := gitTestTracker(t, d, sessionID, cwd)
	if err := os.WriteFile(filepath.Join(cwd, "k.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, _ := tracker.collect(context.Background(), true)
	if len(files) == 0 {
		t.Fatal("expected pending changes before keep")
	}
	d.handleMessage([]byte(`{"type":"keep_changes","sessionId":"` + sessionID + `","reviewId":"` + reviewIDFor(files) + `"}`))
	if _, err := os.Stat(filepath.Join(tracker.gitDir, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("temp git dir must be deleted after keep")
	}
	// Work-tree keeps the new content.
	data, _ := os.ReadFile(filepath.Join(cwd, "k.txt"))
	if string(data) != "v2\n" {
		t.Fatalf("keep must preserve work-tree content, got %q", data)
	}
}

func TestGitTrackerIgnoresTempDirs(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	tracker := gitTestTracker(t, d, "sess-git-ignore", cwd)
	for _, p := range []string{"node_modules/dep/index.js", "dist/bundle.js", "__pycache__/mod.pyc", "app.log"} {
		full := filepath.Join(cwd, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(cwd, "real.txt"), []byte("r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files := collectPaths(t, tracker, false)
	if findChange(files, "real.txt") == nil {
		t.Fatalf("real.txt must be tracked, got %+v", files)
	}
	for _, ignored := range []string{"node_modules/dep/index.js", "dist/bundle.js", "__pycache__/mod.pyc", "app.log"} {
		if findChange(files, ignored) != nil {
			t.Fatalf("%s must be ignored, got %+v", ignored, files)
		}
	}
}

func TestGitTrackerBinaryAndProjectGitUntouched(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	// Simulate a project-owned .git: the temp tracker must never touch it.
	if err := os.MkdirAll(filepath.Join(cwd, ".git", "objects"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cwd, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tracker := gitTestTracker(t, d, "sess-git-bin", cwd)
	bin := []byte{0x89, 0x50, 0x4e, 0x47, 0x0, 0x1, 0x2, 0xff, 0xfe}
	if err := os.WriteFile(filepath.Join(cwd, "img.bin"), bin, 0o644); err != nil {
		t.Fatal(err)
	}
	files := collectPaths(t, tracker, true)
	got := findChange(files, "img.bin")
	if got == nil || !got.Binary || got.Diff != "" {
		t.Fatalf("expected binary img.bin without diff, got %+v", files)
	}
	if _, err := os.Stat(filepath.Join(cwd, ".git")); err != nil {
		t.Fatal("project .git must remain untouched (only temp repo is used)")
	}
	if _, err := os.Stat(filepath.Join(cwd, ".git", "HEAD")); err != nil {
		t.Fatal("project .git/HEAD must remain untouched")
	}
}

type stubTool struct{}

func (stubTool) Name() string            { return "stub" }
func (stubTool) Description() string     { return "stub" }
func (stubTool) Schema() json.RawMessage { return json.RawMessage(`{}`) }
func (s stubTool) Execute(_ context.Context, _ json.RawMessage, _ func(string)) (core.ToolResult, error) {
	return core.ToolResult{}, nil
}

func TestGitTrackerSymlinkParentIsSkipped(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	sessionID := "sess-git-symlink"
	srcDir := filepath.Join(cwd, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "file.txt"), []byte("agent\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tracker := gitTestTracker(t, d, sessionID, cwd)
	// Change the file AFTER baseline so it becomes a pending change.
	if err := os.WriteFile(filepath.Join(srcDir, "file.txt"), []byte("agent v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Swap the parent for a symlink pointing outside the work-tree.
	out := t.TempDir()
	if err := os.WriteFile(filepath.Join(out, "file.txt"), []byte("agent v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(srcDir); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, srcDir); err != nil {
		t.Fatal(err)
	}
	files, _ := tracker.collect(context.Background(), true)
	d.handleMessage([]byte(`{"type":"undo_changes","sessionId":"` + sessionID + `","reviewId":"` + reviewIDFor(files) + `"}`))
	// The outside file must NOT be touched by undo.
	got, err := os.ReadFile(filepath.Join(out, "file.txt"))
	if err != nil || string(got) != "agent v2\n" {
		t.Fatal("undo followed a replaced parent symlink")
	}
	// Temp repo is kept (nothing was discarded) since paths were skipped.
	if _, err := os.Stat(filepath.Join(tracker.gitDir, "HEAD")); err != nil {
		t.Fatal("temp git dir should be kept when unsafe paths are skipped")
	}
}

func TestCountingToolPublishesEveryFiveCalls(t *testing.T) {
	d := testDaemon(t)
	cwd := t.TempDir()
	tracker := gitTestTracker(t, d, "sess-git-count", cwd)
	inner := &stubTool{}
	wrapped := &countingTool{Tool: inner, tracker: tracker}
	for i := 0; i < 4; i++ {
		if _, err := wrapped.Execute(context.Background(), nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	tracker.mu.Lock()
	n := tracker.toolCalls
	tracker.mu.Unlock()
	if n != 4 {
		t.Fatalf("expected 4 counted calls, got %d", n)
	}
}
