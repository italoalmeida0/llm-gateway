package main

// Coverage for the shared per-project review layout: one temp git repo per
// project folder (reviews/<key>/git), shared by every session rooted there.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewRootResolvesProjectPath(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	projects := []ProjectEntry{{ID: "p1", Name: "P", Path: root}}
	if got := reviewRootForCWD(sub, projects); got != normalizeReviewRoot(root) {
		t.Fatalf("sub dir must resolve to project root, got %q", got)
	}
	if got := reviewRootForCWD(root, projects); got != normalizeReviewRoot(root) {
		t.Fatalf("root must resolve to itself, got %q", got)
	}
	// No project match: falls back to the normalized CWD itself.
	outside := t.TempDir()
	if got := reviewRootForCWD(outside, projects); got != normalizeReviewRoot(outside) {
		t.Fatalf("unmatched cwd must resolve to itself, got %q", got)
	}
}

func TestReviewKeyStableAndSafe(t *testing.T) {
	root := t.TempDir()
	a, b := reviewKeyForRoot(root), reviewKeyForRoot(root)
	if a != b || len(a) < 18 || strings.Contains(a, "/") || strings.Contains(a, string(filepath.Separator)) {
		t.Fatalf("key must be stable and filesystem-safe, got %q", a)
	}
	other := reviewKeyForRoot(t.TempDir())
	if a == other {
		t.Fatal("different roots must produce different keys")
	}
}

func TestSharedTrackerAcrossSessions(t *testing.T) {
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	d := testDaemon(t)
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ta := gitTestTracker(t, d, "sess-shared-a", cwd)
	tb := gitTestTracker(t, d, "sess-shared-b", cwd)
	if ta != tb {
		t.Fatal("sessions in the same folder must share one tracker instance")
	}
	if ta.gitDir != tb.gitDir {
		t.Fatalf("shared tracker must share gitDir: %q vs %q", ta.gitDir, tb.gitDir)
	}
	if !strings.Contains(ta.gitDir, filepath.Join("reviews", ta.key, "git")) {
		t.Fatalf("gitDir must live under reviews/<key>/git, got %q", ta.gitDir)
	}
	if _, err := os.Stat(filepath.Join(d.reviewsDir(), ta.key, "meta.json")); err != nil {
		t.Fatalf("meta.json must exist next to the shared repo: %v", err)
	}

	// A change made "by session A" is visible through session B's tracker.
	if err := os.WriteFile(filepath.Join(cwd, "shared.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if files, _ := tb.collect(context.Background(), false); findChange(files, "shared.txt") == nil {
		t.Fatalf("sibling session must see the same pending changes, got %+v", files)
	}

	// Sub-directory sessions join the same root once a project entry covers
	// the root (mirrors projects.json in production).
	if err := d.saveProjects([]ProjectEntry{{ID: "p-shared", Name: "shared", Path: cwd}}); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(cwd, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	tc := gitTestTracker(t, d, "sess-shared-c", sub)
	if tc != ta {
		t.Fatal("session in a project subdir must reuse the project-root tracker")
	}
	if got := tc.cwd; got != normalizeReviewRoot(cwd) {
		t.Fatalf("shared tracker work-tree must be the project root, got %q", got)
	}
}

func TestKeepClearsSharedRepoForSiblings(t *testing.T) {
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	d := testDaemon(t)
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "k.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ta := gitTestTracker(t, d, "sess-keep-a", cwd)
	gitTestTracker(t, d, "sess-keep-b", cwd)
	if err := os.WriteFile(filepath.Join(cwd, "k.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, _ := ta.collect(context.Background(), true)
	if len(files) == 0 {
		t.Fatal("expected pending changes before keep")
	}
	d.handleMessage([]byte(`{"type":"keep_changes","sessionId":"sess-keep-a","reviewId":"` + reviewIDFor(files) + `"}`))
	if _, err := os.Stat(filepath.Join(ta.gitDir, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("shared temp git dir must be deleted after keep")
	}
	if cur := d.trackerForRoot(ta.key); cur != nil {
		t.Fatal("shared tracker must be detached after keep")
	}
	d.sessionsMu.RLock()
	bAct := d.sessions["sess-keep-b"]
	d.sessionsMu.RUnlock()
	bAct.mu.Lock()
	bTracker := bAct.gitTracker
	bAct.mu.Unlock()
	if bTracker != nil {
		t.Fatal("sibling back-pointer must be cleared after keep")
	}
}

func TestUndoAllClearsSharedRepoForSiblings(t *testing.T) {
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	d := testDaemon(t)
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "u.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ta := gitTestTracker(t, d, "sess-undo-a", cwd)
	gitTestTracker(t, d, "sess-undo-b", cwd)
	if err := os.WriteFile(filepath.Join(cwd, "u.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files, _ := ta.collect(context.Background(), true)
	d.handleMessage([]byte(`{"type":"undo_changes","sessionId":"sess-undo-a","reviewId":"` + reviewIDFor(files) + `"}`))
	data, _ := os.ReadFile(filepath.Join(cwd, "u.txt"))
	if string(data) != "v1\n" {
		t.Fatalf("undo-all from a sibling must restore the file, got %q", data)
	}
	if _, err := os.Stat(filepath.Join(ta.gitDir, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("shared temp git dir must be deleted after undo-all")
	}
}

func TestLegacySessionGitMigrated(t *testing.T) {
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	d := testDaemon(t)
	cwd := t.TempDir()
	sessionID := "sess-legacy"
	legacy := filepath.Join(d.sessionsDir(), sessionID, "git")
	// Hand-roll a legacy per-session repo the old layout would have left.
	legacyTracker := &gitReviewTracker{d: d, cwd: cwd, hostID: "h", sessionID: sessionID, gitDir: legacy}
	if err := legacyTracker.init(); err != nil {
		t.Fatal(err)
	}
	if err := legacyTracker.baselineNow("legacy"); err != nil {
		t.Fatal(err)
	}
	rec := &SessionRecord{ID: sessionID, CWD: cwd}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	act := &ActiveSession{record: rec}
	d.sessionsMu.Lock()
	d.sessions[sessionID] = act
	d.sessionsMu.Unlock()

	tracker := d.ensureGitTracker(act, sessionID, cwd)
	if tracker == nil {
		t.Fatal("ensureGitTracker must create the shared tracker")
	}
	if _, err := os.Stat(filepath.Join(legacy, "HEAD")); !os.IsNotExist(err) {
		t.Fatal("legacy sessions/<id>/git must be removed on migration")
	}
	if _, err := os.Stat(filepath.Join(tracker.gitDir, "HEAD")); err != nil {
		t.Fatalf("shared repo must exist after migration: %v", err)
	}
}

func TestPurgeSessionKeepsSharedRepo(t *testing.T) {
	if !gitReviewAvailable() {
		t.Skip("git binary not available")
	}
	d := testDaemon(t)
	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "p.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ta := gitTestTracker(t, d, "sess-purge-a", cwd)
	gitTestTracker(t, d, "sess-purge-b", cwd)
	if err := os.WriteFile(filepath.Join(cwd, "p.txt"), []byte("v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d.purgeSession("sess-purge-a")
	if _, err := os.Stat(filepath.Join(ta.gitDir, "HEAD")); err != nil {
		t.Fatalf("shared repo must survive purge of one sibling: %v", err)
	}
	if files, _ := ta.collect(context.Background(), false); findChange(files, "p.txt") == nil {
		t.Fatalf("remaining sibling must still see pending changes, got %+v", files)
	}
}
