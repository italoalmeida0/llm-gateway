package main

// Git-backed change tracking for indirect-code sessions ("review").
//
// The daemon keeps a TEMPORARY git repository OUTSIDE the project folder,
// under the daemon data dir — ONE PER PROJECT FOLDER (shared by every
// session/chat rooted there), like a normal .git would be:
//
//	<dataDir>/reviews/<key>/git/   (GIT_DIR; HEAD, objects, refs, info/exclude)
//	<dataDir>/reviews/<key>/meta.json (root + timestamps, for debug/GC)
//
// Every git invocation uses --git-dir=<gitDir> --work-tree=<reviewRoot>, so:
//   - no .git is ever created inside the project folder;
//   - a project-owned .git (if any) is untouched — the AI keeps using the
//     project's own git normally; this repo exists only for the daemon to
//     discover changes (baseline commit + diff + checkout/clean on undo).
//
// Lifecycle (per project root, shared across sessions):
//   - before a turn: ensure repo exists, refresh info/exclude, baseline commit.
//   - during the turn: after every 5 tool calls, collect a SUMMARY and
//     broadcast session_changes (no diffs) + changes_updated to every
//     sibling session of the same root.
//   - end of turn: one more summary collection.
//   - get_changes (user opens Review): full collection WITH diffs.
//   - undo (all): checkout + clean, then DELETE the shared temp git dir.
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

	"llm-gateway/indirect-code-daemon/packages/core"
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

// gitReviewTracker tracks pending changes of one project root with a temp
// repo shared by every session rooted there. act/sessionID identify the
// session that created (or last attached) the tracker and are used for
// lifecycle bookkeeping; the work-tree is ALWAYS root.
type gitReviewTracker struct {
	mu        sync.Mutex
	d         *DaemonServer
	act       *ActiveSession
	cwd       string // review root (work-tree)
	key       string // reviews/<key> dir name for this root
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
	Path    string
	Kind    string
	State   string
	Binary  bool
	Added   int
	Removed int
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

// reviewsDir returns the base dir for shared per-project review repos.
func (d *DaemonServer) reviewsDir() string {
	return filepath.Join(d.dataDir, "reviews")
}

// gitDirForSession resolves the SHARED temp GIT_DIR for a session by mapping
// its CWD to the owning review root. Kept under the session-oriented name
// so existing call sites keep reading naturally; it is root-keyed, not
// session-keyed. Legacy per-session repos (sessions/<id>/git) are migrated
// away on first use (see migrateLegacySessionGit).
func (d *DaemonServer) gitDirForSession(sessionID string) string {
	root, key := d.reviewRootAndKeyForSession(sessionID)
	_ = root
	return filepath.Join(d.reviewsDir(), key, "git")
}

// reviewRootAndKeyForSession maps a session to its shared (root, key).
// Unknown sessions fall back to a key derived from the session id so callers
// never receive an empty path.
func (d *DaemonServer) reviewRootAndKeyForSession(sessionID string) (string, string) {
	cwd := ""
	d.sessionsMu.RLock()
	cached := d.sessions[sessionID]
	d.sessionsMu.RUnlock()
	if cached != nil {
		cached.mu.Lock()
		if cached.record != nil {
			cwd = cached.record.CWD
		}
		cached.mu.Unlock()
	}
	if cwd == "" {
		if rec, err := d.loadSession(sessionID); err == nil {
			cwd = rec.CWD
		}
	}
	if strings.TrimSpace(cwd) == "" {
		return "", "sess-" + sessionID
	}
	root := reviewRootForCWD(cwd, d.loadProjects())
	return root, reviewKeyForRoot(root)
}

// reviewRootAndKeyForCWD maps an arbitrary CWD to its shared (root, key).
func (d *DaemonServer) reviewRootAndKeyForCWD(cwd string) (string, string) {
	root := reviewRootForCWD(cwd, d.loadProjects())
	return root, reviewKeyForRoot(root)
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

// ensureGitTracker creates (or reuses) the SHARED tracker for the session's
// review root, initializes the temp repo on first use, refreshes
// info/exclude, and records a baseline commit capturing everything currently
// on disk — but ONLY when the repo is clean. If changes are still pending
// (dirty), the old baseline is kept so pending changes accumulate across
// turns AND sessions until keep/undo-all. A pre-existing temp repo (e.g.
// daemon restart with pending changes) is reattached, never re-baselined
// blindly. It returns nil (disabled, no error) when git is unavailable.
//
// The tracker is owned by d.reviewTrackers[key]; act.gitTracker is just a
// back-pointer so noteToolCall/finalizeTurn keep working. The tracker's own
// mu serializes baseline/collect/undo within the root, so concurrent turns
// from sibling sessions can't corrupt the baseline.
func (d *DaemonServer) ensureGitTracker(act *ActiveSession, sessionID, cwd string) *gitReviewTracker {
	root, key := d.reviewRootAndKeyForCWD(cwd)
	if root == "" || key == "" {
		return nil
	}
	act.mu.Lock()
	if act.gitTracker != nil && act.gitTracker.key == key {
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
	d.reviewMu.Lock()
	if d.reviewTrackers == nil {
		d.reviewTrackers = make(map[string]*gitReviewTracker)
	}
	if t, ok := d.reviewTrackers[key]; ok {
		d.reviewMu.Unlock()
		_ = t.maybeBaseline("turn")
		act.mu.Lock()
		act.gitTracker = t
		act.mu.Unlock()
		return t
	}
	d.migrateLegacySessionGitLocked(root, key)
	gitDir := filepath.Join(d.reviewsDir(), key, "git")
	reattaching := false
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err == nil {
		reattaching = true
	}
	t := &gitReviewTracker{d: d, act: act, cwd: root, key: key, hostID: d.config.HostID, sessionID: sessionID, gitDir: gitDir}
	if err := t.init(); err != nil {
		d.reviewMu.Unlock()
		return nil
	}
	d.reviewTrackers[key] = t
	d.reviewMu.Unlock()
	t.touchMeta()
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

// trackerForRoot returns the live shared tracker for a review key, if any.
func (d *DaemonServer) trackerForRoot(key string) *gitReviewTracker {
	if key == "" {
		return nil
	}
	d.reviewMu.Lock()
	defer d.reviewMu.Unlock()
	return d.reviewTrackers[key]
}

// detachTrackerKey removes a shared tracker from the map and clears every
// back-pointer sessions hold to it. Callers must already have destroyed the
// on-disk repo (or decided to keep it for reattach — then don't call this).
func (d *DaemonServer) detachTrackerKey(key string, t *gitReviewTracker) {
	if key == "" {
		return
	}
	d.reviewMu.Lock()
	if cur, ok := d.reviewTrackers[key]; !ok || (t != nil && cur != t) {
		d.reviewMu.Unlock()
		return
	}
	delete(d.reviewTrackers, key)
	d.reviewMu.Unlock()
	d.sessionsMu.RLock()
	acts := make([]*ActiveSession, 0, len(d.sessions))
	for _, act := range d.sessions {
		acts = append(acts, act)
	}
	d.sessionsMu.RUnlock()
	for _, act := range acts {
		act.mu.Lock()
		if act.gitTracker != nil && (t == nil || act.gitTracker == t) && act.gitTracker.key == key {
			act.gitTracker = nil
		}
		act.mu.Unlock()
	}
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
	// Remove the parent key dir too when it holds nothing but meta.json, so
	// keep/undo-all leaves no empty husk behind.
	if t.d != nil && t.key != "" {
		parent := filepath.Dir(t.gitDir)
		entries, err := os.ReadDir(parent)
		if err == nil {
			leftovers := false
			for _, e := range entries {
				if e.Name() != "meta.json" {
					leftovers = true
					break
				}
			}
			if !leftovers {
				_ = os.RemoveAll(parent)
			}
		}
	}
	t.summary = nil
	t.baseline = ""
}

// reviewMeta is the sidecar stored next to each shared repo for debug/GC.
type reviewMeta struct {
	Root      string `json:"root"`
	Key       string `json:"key"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// touchMeta creates/refreshes reviews/<key>/meta.json.
func (t *gitReviewTracker) touchMeta() {
	if t.d == nil || t.key == "" {
		return
	}
	dir := filepath.Dir(t.gitDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	p := filepath.Join(dir, "meta.json")
	now := time.Now().UnixMilli()
	meta := reviewMeta{Root: t.cwd, Key: t.key, CreatedAt: now, UpdatedAt: now}
	if data, err := os.ReadFile(p); err == nil {
		var prev reviewMeta
		if json.Unmarshal(data, &prev) == nil && prev.CreatedAt != 0 {
			meta.CreatedAt = prev.CreatedAt
		}
	}
	if out, err := json.MarshalIndent(meta, "", "  "); err == nil {
		_ = os.WriteFile(p, out, 0o600)
	}
}

// migrateLegacySessionGitLocked discards per-session repos
// (sessions/<id>/git, the pre-project layout) whose session CWD resolves to
// this root, so the first shared baseline starts clean. The caller must hold
// d.reviewMu. Objects are NOT transplanted: a fresh baseline is safer than
// grafting another repo's objects/refs.
func (d *DaemonServer) migrateLegacySessionGitLocked(root, key string) {
	_ = key
	if strings.TrimSpace(root) == "" {
		return
	}
	projects := d.loadProjects()
	dir := d.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		legacy := filepath.Join(dir, e.Name(), "git")
		if _, err := os.Stat(filepath.Join(legacy, "HEAD")); err != nil {
			continue
		}
		cwd := ""
		if rec, err := d.loadSession(e.Name()); err == nil {
			cwd = rec.CWD
		}
		if strings.TrimSpace(cwd) == "" {
			continue
		}
		if reviewRootForCWD(cwd, projects) != root {
			continue
		}
		_ = os.RemoveAll(legacy)
		fmt.Printf("[INFO] migrated review git: removed legacy sessions/%s/git (now shared under reviews/)\n", e.Name())
	}
}

// gcStaleReviews removes shared repos whose root vanished or that have been
// untouched for 30 days. Best-effort and lazy: called from ensureGitTracker
// paths is too hot, so callers invoke it explicitly (project delete/list).
func (d *DaemonServer) gcStaleReviews() {
	base := d.reviewsDir()
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	now := time.Now().UnixMilli()
	const maxAge = int64(30 * 24 * time.Hour / time.Millisecond)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		key := e.Name()
		if d.trackerForRoot(key) != nil {
			continue // live tracker: in use
		}
		metaPath := filepath.Join(base, key, "meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue // no meta (legacy hand-made dir?): leave alone
		}
		var meta reviewMeta
		if json.Unmarshal(data, &meta) != nil {
			continue
		}
		stale := now-meta.UpdatedAt > maxAge
		missing := strings.TrimSpace(meta.Root) != "" && inspectWorkspace(meta.Root).Status == "missing"
		if stale || missing {
			_ = os.RemoveAll(filepath.Join(base, key))
			fmt.Printf("[INFO] gc review repo %s (root %q)\n", key, meta.Root)
		}
	}
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
	return t.collectLocked(ctx, full)
}

// collectLocked is collect without the mutex (callers already holding t.mu,
// e.g. broadcast paths that need summary + payload from one snapshot).
func (t *gitReviewTracker) collectLocked(ctx context.Context, full bool) ([]gitChangeFile, int64) {
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
	// Untracked directories show in porcelain as "dir/" but numstat reports
	// per-FILE paths — expand them so counts/diffs resolve to real files.
	names = t.expandUntrackedDirs(ctx, paths, names)

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

// expandUntrackedDirs replaces porcelain "dir/" entries (untracked dirs are
// collapsed to one line by `git status`) with the actual untracked file
// paths inside, so numstat counts and diffs attach to real files instead of
// leaving the directory entry with 0/0. Tracked paths pass through as-is.
func (t *gitReviewTracker) expandUntrackedDirs(ctx context.Context, paths map[string]string, names []string) []string {
	out := make([]string, 0, len(names))
	for _, p := range names {
		if paths[p] != "??" || !strings.HasSuffix(p, "/") {
			out = append(out, p)
			continue
		}
		abs := filepath.Join(t.cwd, filepath.FromSlash(p))
		var found []string
		_ = filepath.WalkDir(abs, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if rel, err := filepath.Rel(t.cwd, path); err == nil {
				rel = filepath.ToSlash(rel)
				found = append(found, rel)
				paths[rel] = "??"
			}
			return nil
		})
		if len(found) == 0 {
			out = append(out, p)
			continue
		}
		sort.Strings(found)
		out = append(out, found...)
		delete(paths, p)
	}
	sort.Strings(out)
	return out
}
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
// the web client already understands. Added/removed counts ride along even
// on summary payloads (no diff) so the banner can show +N/-M live.
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
// The repo is shared per project root, so the summary fans out to EVERY
// sibling session of the same root (same payload, per-session sessionId) —
// the frontend keeps filtering by its own sessionId, unchanged.
func (t *gitReviewTracker) broadcastSummary() {
	t.mu.Lock()
	files, checkedAt := t.collectLocked(context.Background(), false)
	summary := make([]gitFileSummary, 0, len(files))
	for _, f := range files {
		summary = append(summary, gitFileSummary{Path: f.Path, Kind: f.Kind, State: f.State, Binary: f.Binary, Added: f.Added, Removed: f.Removed})
	}
	t.summary = summary
	t.summaryAt = checkedAt
	t.mu.Unlock()
	review := publicGitReview(reviewIDFor(files), files, checkedAt, gitReviewNotice())
	for _, sid := range t.d.siblingSessionIDs(t.key, t.sessionID) {
		_ = t.d.sendWS(map[string]any{
			"type": "session_changes", "hostId": t.hostID, "sessionId": sid,
			"review": review,
		})
		_ = t.d.sendWS(map[string]any{"type": "changes_updated", "hostId": t.hostID, "sessionId": sid})
	}
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
	act.mu.Lock()
	cwd := ""
	if act.record != nil {
		cwd = act.record.CWD
	}
	act.mu.Unlock()
	root, key := d.reviewRootAndKeyForCWD(cwd)
	t := d.trackerForRoot(key)
	if t == nil {
		// No tracker yet (turn never ran, or keep/undo-all cleared it):
		// answer with whatever the shared temp repo still shows, if anything.
		t = &gitReviewTracker{d: d, act: act, cwd: root, key: key, hostID: d.config.HostID, sessionID: req.SessionID, gitDir: filepath.Join(d.reviewsDir(), key, "git")}
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
			key, shared := t.key, t
		t.destroy()
		d.detachTrackerKey(key, shared)
		d.fanOutChanges(key, req.SessionID, req.Detail, true)
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
	review := publicGitReview(reviewIDFor(after), after, checkedAt2, "")
	response["review"] = review
	d.fanOutReview(keyOf(t), req.SessionID, review, req.Detail)
}

// keyOf returns the shared review key of a tracker (empty when nil).
func keyOf(t *gitReviewTracker) string {
	if t == nil {
		return ""
	}
	return t.key
}

// siblingSessionIDs lists every session rooted at the same review key —
// in-memory actives plus on-disk records — always including origin first.
// Fan-out sends one event per id so the frontend's per-session filter works
// unchanged in every open chat of the project.
func (d *DaemonServer) siblingSessionIDs(key, origin string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}
	add(origin)
	if key == "" {
		return out
	}
	projects := d.loadProjects()
	d.sessionsMu.RLock()
	acts := make([]*ActiveSession, 0, len(d.sessions))
	for _, act := range d.sessions {
		acts = append(acts, act)
	}
	d.sessionsMu.RUnlock()
	for _, act := range acts {
		act.mu.Lock()
		id, cwd := "", ""
		if act.record != nil {
			id, cwd = act.record.ID, act.record.CWD
		}
		act.mu.Unlock()
		if id == "" || id == origin || strings.TrimSpace(cwd) == "" {
			continue
		}
		if reviewKeyForRoot(reviewRootForCWD(cwd, projects)) == key {
			add(id)
		}
	}
	for _, s := range d.listSessionSummaries() {
		if s.ID == "" || s.ID == origin || strings.TrimSpace(s.CWD) == "" {
			continue
		}
		if reviewKeyForRoot(reviewRootForCWD(s.CWD, projects)) == key {
			add(s.ID)
		}
	}
	return out
}

// fanOutReview publishes a session_changes payload (+ changes_updated) to
// every sibling session of key, except origin (whose handler already answers
// via its own response object). includeOrigin re-adds origin for fire-and-
// forget paths like keep/undo-all where no direct response carries the state.
func (d *DaemonServer) fanOutReview(key, origin string, review map[string]any, detail bool) {
	for _, sid := range d.siblingSessionIDs(key, origin) {
		if sid == origin {
			continue
		}
		_ = d.sendWS(map[string]any{
			"type": "session_changes", "hostId": d.config.HostID,
			"sessionId": sid, "detail": detail, "review": review,
		})
		_ = d.sendWS(map[string]any{"type": "changes_updated", "hostId": d.config.HostID, "sessionId": sid})
	}
}

// fanOutChanges re-collects the current state and fans it out (used after
// destructive ops). When includeOrigin is set, origin gets the events too.
func (d *DaemonServer) fanOutChanges(key, origin string, detail, includeOrigin bool) {
	t := d.trackerForRoot(key)
	files := []gitChangeFile{}
	checkedAt := time.Now().UnixMilli()
	if t != nil {
		files, checkedAt = t.collect(context.Background(), detail)
	}
	review := publicGitReview(reviewIDFor(files), files, checkedAt, "")
	targets := d.siblingSessionIDs(key, origin)
	if !includeOrigin {
		filtered := targets[:0]
		for _, sid := range targets {
			if sid != origin {
				filtered = append(filtered, sid)
			}
		}
		targets = filtered
	}
	for _, sid := range targets {
		_ = d.sendWS(map[string]any{
			"type": "session_changes", "hostId": d.config.HostID,
			"sessionId": sid, "detail": detail, "review": review,
		})
		_ = d.sendWS(map[string]any{"type": "changes_updated", "hostId": d.config.HostID, "sessionId": sid})
	}
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
	cwd := ""
	if act.record != nil {
		cwd = act.record.CWD
	}
	act.mu.Unlock()
	if running {
		response["error"] = "Wait for the turn to finish before keeping changes"
		return
	}
	root, key := d.reviewRootAndKeyForCWD(cwd)
	_ = root
	tracker := d.trackerForRoot(key)
	gitDir := filepath.Join(d.reviewsDir(), key, "git")
	if _, err := os.Stat(filepath.Join(gitDir, "HEAD")); err != nil {
		response["error"] = "No pending changes"
		return
	}
	if tracker != nil {
		files, _ := tracker.collect(context.Background(), false)
		if len(files) == 0 {
			tracker.destroy()
			d.detachTrackerKey(key, tracker)
			response["error"] = "No pending changes"
			d.fanOutChanges(key, req.SessionID, true, true)
			return
		}
		if req.ReviewID == "" || req.ReviewID != reviewIDFor(files) {
			response["review"] = publicGitReview(reviewIDFor(files), files, time.Now().UnixMilli(), "")
			response["error"] = "Changes were updated. Review them again before keeping."
			return
		}
		tracker.destroy()
		d.detachTrackerKey(key, tracker)
	} else {
		_ = os.RemoveAll(gitDir)
	}
	response["review"] = map[string]any{"files": []any{}}
	d.fanOutReview(key, req.SessionID, map[string]any{"files": []any{}}, true)
}
