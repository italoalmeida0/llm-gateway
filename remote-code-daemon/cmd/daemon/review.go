package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/patriceckhart/zot/packages/core"
)

const reviewFileLimit = 4 << 20
const reviewTotalLimit = 64 << 20

type fileVersion struct {
	Exists      bool        `json:"exists"`
	Data        []byte      `json:"data,omitempty"`
	Mode        fs.FileMode `json:"mode"`
	Unavailable bool        `json:"unavailable,omitempty"`
}
type fileChange struct {
	Conflict bool        `json:"conflict,omitempty"`
	Path     string      `json:"path"`
	Before   fileVersion `json:"before"`
	After    fileVersion `json:"after"`
	Undone   bool        `json:"undone,omitempty"`
}
type taskReview struct {
	ID     string                 `json:"id"`
	Files  map[string]*fileChange `json:"files"`
	Notice string                 `json:"notice,omitempty"`
}
type reviewJournal struct {
	mu                     sync.Mutex
	d                      *DaemonServer
	act                    *ActiveSession
	gen                    int
	cwd, hostID, sessionID string
	review                 taskReview
}

// Backups live alongside attachments on the daemon, never in the git index.
func (d *DaemonServer) reviewPath(id string) string {
	return filepath.Join(d.sessionsDir(), id, "review.json")
}
func (j *reviewJournal) persist() {
	j.act.mu.Lock()
	defer j.act.mu.Unlock()
	if j.act.gen != j.gen {
		return
	}
	path := j.d.reviewPath(j.sessionID)
	if os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	data, err := json.Marshal(j.review)
	if err != nil {
		return
	}
	if os.WriteFile(path+".tmp", data, 0o600) != nil {
		return
	}
	if os.Rename(path+".tmp", path) != nil {
		return
	}
	_ = j.d.sendWS(map[string]any{"type": "session_changes", "hostId": j.hostID, "sessionId": j.sessionID, "review": j.review.public(false)})
}

func newReviewJournal(d *DaemonServer, act *ActiveSession, gen int, cwd, hostID, sessionID string) *reviewJournal {
	j := &reviewJournal{d: d, act: act, gen: gen, cwd: cwd, hostID: hostID, sessionID: sessionID,
		review: taskReview{ID: fmt.Sprintf("review_%d", time.Now().UnixNano()), Files: map[string]*fileChange{}}}
	j.persist()
	return j
}

// Do not follow symlinks on capture or undo. A changed parent must not redirect
// restoration into another file, including when the original file was deleted.
func noSymlinks(path string) bool {
	for p := path; ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil && !os.IsNotExist(err) {
			return false
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return false
		}
		if filepath.Dir(p) == p {
			return true
		}
	}
}
func readVersion(path string) fileVersion {
	if !noSymlinks(path) {
		return fileVersion{Unavailable: true}
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return fileVersion{}
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > reviewFileLimit {
		return fileVersion{Unavailable: true}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fileVersion{Unavailable: true}
	}
	return fileVersion{Exists: true, Data: data, Mode: info.Mode().Perm()}
}
func sameVersion(a, b fileVersion) bool {
	return !a.Unavailable && !b.Unavailable && a.Exists == b.Exists && a.Mode == b.Mode && bytes.Equal(a.Data, b.Data)
}

func workspaceVersions(ctx context.Context, cwd string) (map[string]fileVersion, bool) {
	versions := map[string]fileVersion{}
	total := 0
	limited := false
	// Use a fixed scope: changing .gitignore must never make an existing file
	// look newly created and therefore eligible for deletion by Undo.
	_ = filepath.WalkDir(cwd, func(p string, e fs.DirEntry, err error) error {
		if ctx.Err() != nil || len(versions) >= 10000 {
			limited = true
			return fs.SkipAll
		}
		if err != nil {
			limited = true
			return nil
		}
		if e.IsDir() {
			if p != cwd {
				switch e.Name() {
				case ".git", "node_modules", "vendor", "dist", "build", ".cache", ".venv", "__pycache__":
					return filepath.SkipDir
				}
			}
			return nil
		}
		v := readVersion(p)
		if total+len(v.Data) > reviewTotalLimit {
			v = fileVersion{Unavailable: true}
		}
		total += len(v.Data)
		versions[p] = v
		return nil
	})
	return versions, limited
}

type reviewedTool struct {
	core.Tool
	journal *reviewJournal
}

func (t *reviewedTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (core.ToolResult, error) {
	j := t.journal
	j.d.filesMu.Lock()
	defer j.d.filesMu.Unlock()
	j.mu.Lock()
	defer j.mu.Unlock()
	before := map[string]fileVersion{}
	limited := false
	if t.Name() == "bash" {
		before, limited = workspaceVersions(ctx, j.cwd)
		j.review.Notice = "Shell changes are captured within the project folder, excluding dependency, build and cache folders."
	} else {
		var a struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(args, &a)
		if a.Path != "" {
			p := a.Path
			if !filepath.IsAbs(p) {
				p = filepath.Join(j.cwd, p)
			}
			p = filepath.Clean(p)
			before[p] = readVersion(p)
		}
	}
	result, err := t.Tool.Execute(ctx, args, progress)
	beforeLimited := limited
	after := map[string]fileVersion{}
	if t.Name() == "bash" {
		// A canceled command may already have written files. Capture those too.
		captureCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		var capped bool
		after, capped = workspaceVersions(captureCtx, j.cwd)
		cancel()
		limited = limited || capped
	} else {
		for p := range before {
			after[p] = readVersion(p)
		}
	}
	paths := map[string]bool{}
	for p := range before {
		paths[p] = true
	}
	for p := range after {
		paths[p] = true
	}
	for p := range paths {
		a, knownBefore := before[p]
		if !knownBefore && beforeLimited {
			// An incomplete scan cannot establish whether a file was newly made.
			continue
		}
		b, knownAfter := after[p]
		if !knownAfter {
			b = readVersion(p)
		}
		if a.Unavailable || b.Unavailable {
			limited = true
			continue
		}
		if sameVersion(a, b) {
			continue
		}
		change := j.review.Files[p]
		total := len(a.Data) + len(b.Data)
		if change != nil {
			total = len(change.Before.Data) + len(b.Data)
		}
		for path, existing := range j.review.Files {
			if path != p {
				total += len(existing.Before.Data) + len(existing.After.Data)
			}
		}
		if total > reviewTotalLimit {
			limited = true
			if change != nil {
				change.Conflict = true
			}
			continue
		}
		if change == nil {
			change = &fileChange{Path: p, Before: a}
			j.review.Files[p] = change
		}
		if !sameVersion(change.Before, a) && !sameVersion(change.After, a) {
			change.Conflict = true
		}
		change.After = b
		if sameVersion(change.Before, b) {
			delete(j.review.Files, p)
		}
	}
	if limited {
		j.review.Notice = "Some files could not be captured (symlinks, unreadable files or backup size limits). Shell review covers the project folder, excluding dependency, build and cache folders."
	}
	j.persist()
	return result, err
}

func (r *taskReview) public(detail bool) map[string]any {
	files := []map[string]any{}
	previewBudget := 1 << 20
	paths := []string{}
	for p := range r.Files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		f := r.Files[p]
		if f.Undone {
			continue
		}
		entry := map[string]any{"path": p, "kind": "modified", "canUndo": !f.Conflict}
		if !f.Before.Exists {
			entry["kind"] = "added"
		} else if !f.After.Exists {
			entry["kind"] = "deleted"
		}
		if detail {
			if utf8.Valid(f.Before.Data) && utf8.Valid(f.After.Data) && !bytes.Contains(f.Before.Data, []byte{0}) && !bytes.Contains(f.After.Data, []byte{0}) {
				const previewLimit = 32000
				beforeSize := min(len(f.Before.Data), previewLimit, previewBudget)
				previewBudget -= beforeSize
				afterSize := min(len(f.After.Data), previewLimit, previewBudget)
				previewBudget -= afterSize
				entry["before"] = string(f.Before.Data[:beforeSize])
				entry["after"] = string(f.After.Data[:afterSize])
				entry["truncated"] = len(f.Before.Data) > beforeSize || len(f.After.Data) > afterSize
			} else {
				entry["binary"] = true
			}
		}
		files = append(files, entry)
	}
	return map[string]any{"id": r.ID, "files": files, "notice": r.Notice}
}

func (d *DaemonServer) handleReview(raw []byte, undo bool) {
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
	response := map[string]any{"type": "session_changes", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID}
	defer func() { _ = d.sendWS(response) }()
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		response["error"] = "This conversation is no longer available on the host."
		return
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
	act.mu.Lock()
	defer act.mu.Unlock()
	var review taskReview
	data, err := os.ReadFile(d.reviewPath(req.SessionID))
	if err != nil || json.Unmarshal(data, &review) != nil {
		response["review"] = map[string]any{"files": []any{}}
		return
	}
	if undo {
		if act.record.Status == "running" {
			response["error"] = "Wait for the task to finish before undoing changes"
			return
		}
		if req.ReviewID == "" || req.ReviewID != review.ID {
			response["error"] = "The changes have been updated. Review them again before undoing."
			return
		}
		selected := []*fileChange{}
		for _, f := range review.Files {
			if !f.Undone && (req.Path == "" || req.Path == f.Path) {
				selected = append(selected, f)
			}
		}
		// Preflight every target before changing any file. Preserve later edits.
		for _, f := range selected {
			if f.Conflict || !sameVersion(readVersion(f.Path), f.After) {
				response["error"] = "Cannot undo: " + f.Path + " changed after this task. Your current edits were preserved."
				return
			}
		}
		for _, f := range selected {
			if f.Before.Exists {
				err = os.MkdirAll(filepath.Dir(f.Path), 0o755)
				if err == nil {
					err = os.WriteFile(f.Path, f.Before.Data, f.Before.Mode)
				}
				if err == nil {
					err = os.Chmod(f.Path, f.Before.Mode)
				}
			} else {
				err = os.Remove(f.Path)
			}
			if err != nil {
				response["error"] = "Could not restore " + f.Path + ": " + err.Error()
				break
			}
			f.Undone = true
		}
		if data, err := json.Marshal(review); err == nil {
			_ = os.WriteFile(d.reviewPath(req.SessionID), data, 0o600)
		}
	}
	response["review"] = review.public(req.Detail)
}
