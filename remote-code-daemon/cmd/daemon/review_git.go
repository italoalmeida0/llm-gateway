package main

// Git-backed change tracking for remote-code sessions ("review").
//
// The daemon keeps a TEMPORARY git repository OUTSIDE the project folder,
// under the daemon data dir:
//
//	<dataDir>/sessions/<sessionID>/git/   (GIT_DIR; HEAD, objects, refs, info/exclude)
//
// Every git invocation uses --git-dir=<gitDir> --work-tree=<sessionCWD>, so:
//   - no .git is ever created inside the project folder;
//   - a project-owned .git (if any) is untouched — the AI keeps using the
//     project's own git normally; this repo exists only for the daemon to
//     discover changes (baseline commit + diff + checkout/clean on undo).
//
// Lifecycle (per session):
//   - before a turn: ensure repo exists, refresh info/exclude, baseline commit.
//   - during the turn: after every 5 tool calls, collect a SUMMARY and
//     broadcast session_changes (no diffs) + changes_updated.
//   - end of turn: one more summary collection.
//   - get_changes (user opens Review): full collection WITH diffs.
//   - undo (all): checkout + clean, then DELETE the temp git dir.
//   - undo (single file): checkout/clean that path, KEEP the temp git dir.
//   - keep: DELETE the temp git dir (work-tree already has what the user wants).
//
// If no git binary is available (PATH + common sidecar locations), the whole
// feature is silently disabled: collections return empty, handlers answer
// with an empty review, and no error is surfaced beyond a review notice.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/patriceckhart/zot/packages/core"
)

// gitToolCallsBetweenSummaries controls how often a running turn publishes a
// lightweight change summary (every N tool calls + once at turn end).
const gitToolCallsBetweenSummaries = 5

// gitDiffTimeout bounds every git subprocess so a wedged repo can never hang
// a turn, a WS handler, or a test.
const gitDiffTimeout = 30 * time.Second

// gitBinaryCandidates lists well-known sidecar locations besides PATH where a
// portable git may live (desktop bundles, IDE extensions, package managers).
var gitBinaryCandidates = []string{
	"/usr/bin/git",
	"/usr/local/bin/git",
	"/opt/homebrew/bin/git",
	"/opt/local/bin/git",
	"C:\\Program Files\\Git\\bin\\git.exe",
	"C:\\Program Files\\Git\\cmd\\git.exe",
}

var (
	gitBinaryOnce sync.Once
	gitBinaryPath string
	gitBinaryErr  error
)

// resolveGitBinary finds a usable git executable: PATH first, then the
// well-known sidecar locations. The result is cached process-wide.
func resolveGitBinary() (string, error) {
	gitBinaryOnce.Do(func() {
		if p, err := exec.LookPath("git"); err == nil {
			gitBinaryPath = p
			return
		}
		for _, cand := range gitBinaryCandidates {
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				gitBinaryPath = cand
				return
			}
		}
		gitBinaryErr = fmt.Errorf("git binary not found")
	})
	return gitBinaryPath, gitBinaryErr
}

// gitReviewAvailable reports whether change tracking can run on this host.
func gitReviewAvailable() bool {
	_, err := resolveGitBinary()
	return err == nil
}

// gitReviewTracker tracks pending changes of one session with a temp repo.
type gitReviewTracker struct {
	mu        sync.Mutex
	d         *DaemonServer
	act       *ActiveSession
	cwd       string
	hostID    string
	sessionID string
	gitDir    string

	toolCalls int
	summary   []gitFileSummary
	summaryAt int64
	baseline  string
}

// gitFileSummary is the cached lightweight entry broadcast during a turn.
type gitFileSummary struct {
	Path   string
	Kind   string
	State  string
	Binary bool
}

// gitChangeFile is one collected change (summary + optional full diff).
type gitChangeFile struct {
	Path         string
	Kind         string
	State        string
	Binary       bool
	Added        int
	Removed      int
	Diff         string
	Truncated    bool
	CanUndo      bool
	CurrentState string
}

// gitDirForSession returns the temp GIT_DIR for a session.
func (d *DaemonServer) gitDirForSession(sessionID string) string {
	return filepath.Join(d.sessionsDir(), sessionID, "git")
}

// trackerFor returns the live tracker of an active session, if any.
func (d *DaemonServer) trackerFor(sessionID string) *gitReviewTracker {
	d.sessionsMu.RLock()
	act := d.sessions[sessionID]
	d.sessionsMu.RUnlock()
	if act == nil {
		return nil
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	return act.gitTracker
}

// ensureGitTracker creates (or reuses) the session tracker, initializes the
// temp repo on first use, refreshes info/exclude, and records a baseline
// commit capturing everything currently on disk — but ONLY when the repo is
// clean. If changes are still pending (dirty), the old baseline is kept so
// pending changes accumulate across turns until keep/undo-all. A pre-existing
// temp repo (e.g. daemon restart with pending changes) is reattached, never
// re-baselined blindly. It returns nil (disabled, no error) when git is
// unavailable.
func (d *DaemonServer) ensureGitTracker(act *ActiveSession, sessionID, cwd string) *gitReviewTracker {
	act.mu.Lock()
	if act.gitTracker != nil {
		t := act.gitTracker
		act.mu.Unlock()
		// New turn over pending changes: keep accumulating, do NOT re-baseline.
		// Only capture a fresh baseline when the repo is clean.
		_ = t.maybeBaseline("turn")
		return t
	}
	act.mu.Unlock()

	if _, err := resolveGitBinary(); err != nil {
		return nil
	}
	gitDir := d.gitDirForSession(sessionID)
	reattaching := false
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err == nil {
		reattaching = true
	}
	t := &gitReviewTracker{d: d, act: act, cwd: cwd, hostID: d.config.HostID, sessionID: sessionID, gitDir: gitDir}
	if err := t.init(); err != nil {
		return nil
	}
	if reattaching {
		// Daemon restart (or any new in-memory tracker) over an existing temp
		// repo: keep the old baseline so pending changes stay visible.
		// Only commit when clean (nothing pending).
		if err := t.maybeBaseline("reattach"); err != nil {
			return nil
		}
	} else if err := t.baselineNow("session start"); err != nil {
		return nil
	}
	act.mu.Lock()
	act.gitTracker = t
	act.mu.Unlock()
	return t
}

// gitEnv returns the environment forcing git to use the temp repo + work-tree.
func (t *gitReviewTracker) gitEnv() []string {
	return []string{
		"GIT_DIR=" + t.gitDir,
		"GIT_WORK_TREE=" + t.cwd,
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_OPTIONAL_LOCKS=0",
	}
}

// runGit executes git with the temp repo environment and a timeout.
func (t *gitReviewTracker) runGit(ctx context.Context, args ...string) ([]byte, error) {
	bin, err := resolveGitBinary()
	if err != nil {
		return nil, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	cctx, cancel := context.WithTimeout(ctx, gitDiffTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, bin, args...)
	cmd.Env = append(os.Environ(), t.gitEnv()...)
	cmd.Dir = t.cwd
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = err.Error()
		}
		return out.Bytes(), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return out.Bytes(), nil
}

// init creates the temp repo (idempotent) and writes config + info/exclude.
func (t *gitReviewTracker) init() error {
	if err := os.MkdirAll(t.gitDir, 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(t.gitDir, "HEAD")); err != nil {
		if _, err := t.runGit(context.Background(), "init", "--quiet"); err != nil {
			return err
		}
	}
	for _, kv := range [][2]string{
		{"user.name", "llm-gateway"},
		{"user.email", "llm-gateway@local"},
		{"commit.gpgsign", "false"},
		{"core.preloadindex", "true"},
		{"core.quotepath", "false"},
		{"status.showUntrackedFiles", "all"},
	} {
		_, _ = t.runGit(context.Background(), "config", kv[0], kv[1])
	}
	return t.writeExclude()
}

// maybeBaseline records a fresh baseline commit only when the repo is
// clean (no pending changes). Dirty repos keep their baseline so changes
// accumulate across turns until keep or undo-all.
func (t *gitReviewTracker) maybeBaseline(msg string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if paths, err := t.statusPathsLocked(context.Background()); err != nil || len(paths) > 0 {
		return nil
	}
	return t.commitBaselineLocked(msg)
}

// baselineNow stages everything (respecting excludes) and records a commit.
// --allow-empty guarantees a SHA even when nothing changed.
func (t *gitReviewTracker) baselineNow(msg string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.commitBaselineLocked(msg)
}

func (t *gitReviewTracker) commitBaselineLocked(msg string) error {
	if _, err := t.runGit(context.Background(), "add", "-A"); err != nil {
		return err
	}
	out, err := t.runGit(context.Background(), "commit", "--allow-empty", "--quiet",
		"-m", fmt.Sprintf("llm-gateway baseline: %s", msg))
	_ = out
	if err != nil {
		return err
	}
	if sha, err := t.runGit(context.Background(), "rev-parse", "HEAD"); err == nil {
		t.baseline = strings.TrimSpace(string(sha))
	}
	return nil
}

// destroy removes the whole temp repo. Called on keep and undo-all.
func (t *gitReviewTracker) destroy() {
	t.mu.Lock()
	defer t.mu.Unlock()
	_ = os.RemoveAll(t.gitDir)
	t.summary = nil
	t.baseline = ""
}

// statusPaths parses `git status --porcelain=v1 -uall` into path -> code.
func (t *gitReviewTracker) statusPaths(ctx context.Context) (map[string]string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.statusPathsLocked(ctx)
}

func (t *gitReviewTracker) statusPathsLocked(ctx context.Context) (map[string]string, error) {
	out, err := t.runGit(ctx, "status", "--porcelain=v1", "-uall", "--ignored=no", "--", ".")
	if err != nil {
		return nil, err
	}
	paths := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if len(line) < 4 {
			continue
		}
		code := strings.TrimSpace(line[:2])
		rest := strings.TrimSpace(line[3:])
		// Rename/copy entries look like "old -> new"; track the new path.
		if i := strings.Index(rest, " -> "); i >= 0 {
			rest = rest[i+4:]
		}
		rest = strings.Trim(rest, `"`)
		if rest == "" {
			continue
		}
		paths[rest] = code
	}
	return paths, nil
}

// numstat parses `git diff --numstat HEAD` into path -> added/removed/binary.
func (t *gitReviewTracker) numstat(ctx context.Context) map[string][2]int {
	out, err := t.runGit(ctx, "diff", "--numstat", "-z", "HEAD", "--", ".")
	if err != nil {
		return map[string][2]int{}
	}
	stats := map[string][2]int{}
	parts := bytes.Split(out, []byte{0})
	for i := 0; i+2 < len(parts); i += 3 {
		added := parseNumstat(string(parts[i]))
		removed := parseNumstat(string(parts[i+1]))
		path := unquoteGitPath(string(parts[i+2]))
		if path != "" {
			stats[path] = [2]int{added, removed}
		}
	}
	return stats
}

func parseNumstat(s string) int {
	s = strings.TrimSpace(s)
	if s == "" || s == "-" {
		return -1
	}
	n, _ := strconv.Atoi(s)
	return n
}

// unquoteGitPath decodes the C-style quoting git emits for special paths.
func unquoteGitPath(s string) string {
	s = strings.TrimSpace(strings.Trim(s, `"`))
	if !strings.Contains(s, "\\") {
		return s
	}
	if unq, err := strconv.Unquote(`"` + s + `"`); err == nil {
		return unq
	}
	return s
}

// classify maps status code + numstat to the kind/state vocabulary the
// Review modal already renders (added/deleted/modified/renamed/...).
func classifyGitChange(code string, added, removed int, onDisk bool) (kind, state string, binary bool) {
	if added < 0 || removed < 0 {
		binary = true
	}
	switch {
	case strings.Contains(code, "R"):
		kind = "renamed"
	case code == "??":
		kind = "added"
	case code == "A":
		kind = "added"
	case code == "D" || code == " D" || code == "D ":
		kind = "deleted"
	case code == "AM" || code == "MM" || code == " M" || code == "M ":
		kind = "modified"
	default:
		if !onDisk {
			kind = "deleted"
		} else if strings.Contains(code, "A") {
			kind = "added"
		} else {
			kind = "modified"
		}
	}
	if !onDisk {
		state = "deleted"
	} else {
		state = "exists"
	}
	return kind, state, binary
}

// pathSafeForGit reports whether relPath can be passed to git checkout/clean
// without escaping the work-tree: no abs escapes, no "..", and no symlink
// on any component from cwd down to the file itself (a swapped parent dir
// must never redirect undo elsewhere).
func (t *gitReviewTracker) pathSafeForGit(relPath string) bool {
	if relPath == "" || relPath == "." || relPath == "/" {
		return false
	}
	if filepath.IsAbs(relPath) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(relPath))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return false
	}
	abs := filepath.Join(t.cwd, clean)
	if !strings.HasPrefix(abs, t.cwd+string(filepath.Separator)) && abs != t.cwd {
		return false
	}
	for p := abs; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return false
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if p == t.cwd || filepath.Dir(p) == p {
			break
		}
	}
	return true
}

// workTreeHas reports whether relPath still exists in the work-tree without
// following symlinks (a swapped parent must never redirect undo elsewhere).
func (t *gitReviewTracker) workTreeHas(relPath string) bool {
	abs := filepath.Join(t.cwd, filepath.FromSlash(relPath))
	for p := abs; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return false
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if p == t.cwd || filepath.Dir(p) == p {
			break
		}
	}
	info, err := os.Lstat(abs)
	return err == nil && info.Mode().IsRegular()
}

// collect gathers the current changes vs the baseline commit.
// With full=false only name/status/size info is returned (cheap, used for the
// periodic summary). With full=true unified diffs are included (Review open).
func (t *gitReviewTracker) collect(ctx context.Context, full bool) ([]gitChangeFile, int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	paths, err := t.statusPathsLocked(ctx)
	if err != nil {
		return nil, 0
	}
	if len(paths) == 0 {
		return nil, time.Now().UnixMilli()
	}
	stats := t.numstat(ctx)
	names := make([]string, 0, len(paths))
	for p := range paths {
		names = append(names, p)
	}
	sort.Strings(names)

	files := make([]gitChangeFile, 0, len(names))
	for _, p := range names {
		code := paths[p]
		st, tracked := stats[p]
		added, removed := st[0], st[1]
		untracked := code == "??"
		onDisk := t.workTreeHas(p)
		kind, state, binary := classifyGitChange(code, added, removed, onDisk)
		if untracked && !tracked {
			// Untracked paths never appear in `git diff HEAD`: synthesize
			// the entry from the work-tree file itself.
			added, removed = untrackedCounts(t.cwd, p)
			kind, state, binary = "added", "exists", added < 0
		}
		f := gitChangeFile{Path: p, Kind: kind, State: state, Binary: binary, CanUndo: true, CurrentState: state}
		if !binary {
			f.Added = max(added, 0)
			f.Removed = max(removed, 0)
		}
		if full && !binary {
			if untracked && !tracked {
				f.Diff, f.Truncated = untrackedDiff(t.cwd, p)
			} else if out, err := t.runGit(ctx, "diff", "--no-color", "--no-ext-diff", "-U3", "HEAD", "--", p); err == nil {
				diff := string(out)
				if len(diff) > 64000 {
					diff = diff[:64000]
					f.Truncated = true
				}
				f.Diff = diff
			}
		}
		files = append(files, f)
	}
	return files, time.Now().UnixMilli()
}

// untrackedCounts synthesizes added/removed line counts for a path git does
// not track (new file). Binary content reports (-1, -1); unreadable files
// report (0, 0).
func untrackedCounts(cwd, rel string) (int, int) {
	data, err := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(rel)))
	if err != nil {
		return 0, 0
	}
	if isBinaryBytes(data) {
		return -1, -1
	}
	n := 0
	for range strings.Split(string(data), "\n") {
		n++
	}
	if n > 0 {
		n-- // trailing newline does not start a new line
	}
	return n, 0
}

// untrackedDiff builds a synthetic unified diff for a new file so Review can
// render it like any added file. Caps output at 64KB like tracked diffs.
func untrackedDiff(cwd, rel string) (string, bool) {
	data, err := os.ReadFile(filepath.Join(cwd, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git a/%s b/%s\nnew file mode 100644\n--- /dev/null\n+++ b/%s\n", rel, rel, rel)
	truncated := false
	for _, line := range strings.Split(string(data), "\n") {
		if b.Len()+len(line)+2 > 64000 {
			truncated = true
			break
		}
		b.WriteString("+")
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String(), truncated
}

// isBinaryBytes reports NUL-byte binary content (same rule git uses).
func isBinaryBytes(data []byte) bool {
	if len(data) > 8000 {
		data = data[:8000]
	}
	return bytes.IndexByte(data, 0) >= 0
}

// publicGitReview renders collected files in the session_changes payload shape
// the web client already understands.
func publicGitReview(reviewID string, files []gitChangeFile, checkedAt int64, notice string) map[string]any {
	out := []map[string]any{}
	for _, f := range files {
		entry := map[string]any{
			"path": f.Path, "kind": f.Kind, "state": f.State,
			"canUndo": f.CanUndo, "currentState": f.CurrentState,
		}
		if f.Binary {
			entry["binary"] = true
		} else {
			entry["added"] = f.Added
			entry["removed"] = f.Removed
			if f.Diff != "" {
				entry["diff"] = f.Diff
				entry["truncated"] = f.Truncated
			}
		}
		out = append(out, entry)
	}
	return map[string]any{"id": reviewID, "files": out, "notice": notice, "checkedAt": checkedAt}
}

// reviewIDFor derives a stable review id from the change set so the undo/keep
// preflight (reviewId match) keeps working: any new change invalidates it.
func reviewIDFor(files []gitChangeFile) string {
	h := sha256.New()
	for _, f := range files {
		fmt.Fprintf(h, "%s\x00%s\x00%s\x00%d\x00%d\x00%v\n", f.Path, f.Kind, f.State, f.Added, f.Removed, f.Binary)
	}
	return "review_" + hex.EncodeToString(h.Sum(nil))[:16]
}

// broadcastSummary collects a cheap summary and publishes session_changes
// (without diffs) plus changes_updated so the UI badge updates live.
func (t *gitReviewTracker) broadcastSummary() {
	files, checkedAt := t.collect(context.Background(), false)
	summary := make([]gitFileSummary, 0, len(files))
	for _, f := range files {
		summary = append(summary, gitFileSummary{Path: f.Path, Kind: f.Kind, State: f.State, Binary: f.Binary})
	}
	t.mu.Lock()
	t.summary = summary
	t.summaryAt = checkedAt
	t.mu.Unlock()
	_ = t.d.sendWS(map[string]any{
		"type": "session_changes", "hostId": t.hostID, "sessionId": t.sessionID,
		"review": publicGitReview(reviewIDFor(files), files, checkedAt, gitReviewNotice()),
	})
	_ = t.d.sendWS(map[string]any{"type": "changes_updated", "hostId": t.hostID, "sessionId": t.sessionID})
	t.d.notifyChange("projects")
}

// noteToolCall counts one finished tool execution; every N calls it publishes
// a fresh summary. Called from the counting wrapper (nil-safe when disabled).
func (t *gitReviewTracker) noteToolCall() {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.toolCalls++
	n := t.toolCalls
	t.mu.Unlock()
	if n%gitToolCallsBetweenSummaries == 0 {
		t.broadcastSummary()
	}
}

// finalizeTurn collects one last summary at turn end (nil-safe).
func (t *gitReviewTracker) finalizeTurn() {
	if t == nil {
		return
	}
	t.broadcastSummary()
}

func gitReviewNotice() string {
	if !gitReviewAvailable() {
		return "Change tracking is unavailable: no git binary found on the host."
	}
	return ""
}

// countingTool wraps a registry tool so every finished execution notifies the
// session tracker (summary every 5 tool calls). Nil-tracker safe.
type countingTool struct {
	core.Tool
	tracker *gitReviewTracker
}

func (t *countingTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (core.ToolResult, error) {
	res, err := t.Tool.Execute(ctx, args, progress)
	if t.tracker != nil {
		t.tracker.noteToolCall()
	}
	return res, err
}

// handleGitReview serves get_changes / undo_changes for git-backed sessions.
func (d *DaemonServer) handleGitReview(raw []byte, undo bool) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		ReviewID  string `json:"reviewId"`
		Path      string `json:"path"`
		Detail    bool   `json:"detail"`
	}
	if json.Unmarshal(raw, &req) != nil || filepath.Base(req.SessionID) != req.SessionID {
		return
	}
	response := map[string]any{"type": "session_changes", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID, "detail": req.Detail}
	defer func() { _ = d.sendWS(response) }()

	if !gitReviewAvailable() {
		response["review"] = map[string]any{"files": []any{}, "notice": gitReviewNotice()}
		return
	}
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		response["error"] = "This conversation is no longer available on the host."
		return
	}
	cwd := act.record.CWD
	t := d.trackerFor(req.SessionID)
	if t == nil {
		// No tracker yet (turn never ran, or keep/undo-all cleared it):
		// answer with whatever the temp repo still shows, if anything.
		t = &gitReviewTracker{d: d, act: act, cwd: cwd, hostID: d.config.HostID, sessionID: req.SessionID, gitDir: d.gitDirForSession(req.SessionID)}
		if _, err := os.Stat(filepath.Join(t.gitDir, "HEAD")); err != nil {
			response["review"] = map[string]any{"files": []any{}}
			return
		}
	}

	if undo {
		act.mu.Lock()
		running := act.record.Status == "running"
		act.mu.Unlock()
		if running {
			response["error"] = "Wait for the task to finish before undoing changes"
			return
		}
		if !d.filesMu.TryLock() {
			response["error"] = "Another task is changing files. Try undo again when it finishes."
			return
		}
		defer d.filesMu.Unlock()
	}

	files, checkedAt := t.collect(context.Background(), true)
	if !undo {
		response["review"] = publicGitReview(reviewIDFor(files), files, checkedAt, "")
		return
	}

	// Undo preflight: stale reviewId means the set changed since Review opened.
	act.mu.Lock()
	running := act.record.Status == "running"
	act.mu.Unlock()
	if running {
		response["error"] = "Wait for the task to finish before undoing changes"
		return
	}
	if req.ReviewID == "" || req.ReviewID != reviewIDFor(files) {
		response["review"] = publicGitReview(reviewIDFor(files), files, checkedAt, "")
		response["error"] = "The changes have been updated. Review them again before undoing."
		return
	}
	if req.Path == "" {
		// Undo-all: discard everything, then delete the temp repo.
		// Skip paths whose parents were swapped for symlinks: restoring
		// through them could write outside the work-tree. They stay listed
		// as pending so the user sees what was NOT reverted.
		skipped := []string{}
		for _, f := range files {
			if !t.pathSafeForGit(f.Path) {
				skipped = append(skipped, f.Path)
				continue
			}
			if _, err := t.runGit(context.Background(), "checkout", "--", f.Path); err != nil {
				// Untracked paths are not in HEAD — clean handles them below.
				if t.workTreeHas(f.Path) && !strings.Contains(err.Error(), "did not match") {
					response["error"] = "Could not restore files: " + err.Error()
					return
				}
			}
			if _, err := t.runGit(context.Background(), "clean", "-fd", "--", f.Path); err != nil {
				response["error"] = "Could not remove new files: " + err.Error()
				return
			}
		}
		if len(skipped) > 0 {
			after, checkedAt2 := t.collect(context.Background(), req.Detail)
			response["review"] = publicGitReview(reviewIDFor(after), after, checkedAt2, "")
			response["error"] = "Skipped unsafe paths (symlink parents): " + strings.Join(skipped, ", ")
			return
		}
		t.destroy()
		act.mu.Lock()
		act.gitTracker = nil
		act.mu.Unlock()
	} else {
		// Single file: restore it, KEEP the temp repo for the rest.
		rel := req.Path
		if filepath.IsAbs(rel) {
			if r, err := filepath.Rel(t.cwd, rel); err == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
				rel = r
			}
		}
		rel = filepath.ToSlash(rel)
		known := false
		for _, f := range files {
			if f.Path == rel {
				known = true
				break
			}
		}
		if !known {
			response["review"] = publicGitReview(reviewIDFor(files), files, checkedAt, "")
			response["error"] = "File is not part of the pending changes."
			return
		}
		if !t.pathSafeForGit(rel) {
			response["review"] = publicGitReview(reviewIDFor(files), files, checkedAt, "")
			response["error"] = "Refusing to undo through a symlinked path: " + rel
			return
		}
		// Untracked (new) files are not in HEAD: clean removes them.
		// Tracked files: checkout restores the baseline content.
		if _, err := t.runGit(context.Background(), "clean", "-f", "--", rel); err != nil {
			response["error"] = "Could not remove " + rel + ": " + err.Error()
			return
		}
		if _, err := t.runGit(context.Background(), "checkout", "--", rel); err != nil {
			// checkout fails for paths never committed (already cleaned above)
			// — only a real error if the file still exists.
			if t.workTreeHas(rel) {
				response["error"] = "Could not restore " + rel + ": " + err.Error()
				return
			}
		}
	}
	after, checkedAt2 := t.collect(context.Background(), req.Detail)
	response["review"] = publicGitReview(reviewIDFor(after), after, checkedAt2, "")
	_ = d.sendWS(map[string]any{"type": "changes_updated", "hostId": d.config.HostID, "sessionId": req.SessionID})
}

// handleGitKeep serves keep_changes: the work-tree already holds the wanted
// content, so accepting means deleting the temp repo.
func (d *DaemonServer) handleGitKeep(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		ReviewID  string `json:"reviewId"`
	}
	if json.Unmarshal(raw, &req) != nil || req.SessionID == "" || filepath.Base(req.SessionID) != req.SessionID {
		return
	}
	response := map[string]any{"type": "session_changes", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID, "detail": true}
	defer func() { _ = d.sendWS(response) }()
	if !gitReviewAvailable() {
		response["review"] = map[string]any{"files": []any{}, "notice": gitReviewNotice()}
		return
	}
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		response["error"] = "Conversation unavailable"
		return
	}
	act.mu.Lock()
	running := act.record.Status == "running"
	tracker := act.gitTracker
	act.mu.Unlock()
	if running {
		response["error"] = "Wait for the turn to finish before keeping changes"
		return
	}
	gitDir := d.gitDirForSession(req.SessionID)
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		response["error"] = "No pending changes"
		return
	}
	if tracker != nil {
		files, _ := tracker.collect(context.Background(), false)
		if len(files) == 0 {
			tracker.destroy()
			act.mu.Lock()
			act.gitTracker = nil
			act.mu.Unlock()
			response["error"] = "No pending changes"
			return
		}
		if req.ReviewID == "" || req.ReviewID != reviewIDFor(files) {
			response["review"] = publicGitReview(reviewIDFor(files), files, time.Now().UnixMilli(), "")
			response["error"] = "Changes were updated. Review them again before keeping."
			return
		}
		tracker.destroy()
	} else {
		_ = os.RemoveAll(gitDir)
	}
	act.mu.Lock()
	act.gitTracker = nil
	act.mu.Unlock()
	response["review"] = map[string]any{"files": []any{}}
	_ = d.sendWS(map[string]any{"type": "changes_updated", "hostId": d.config.HostID, "sessionId": req.SessionID})
}
