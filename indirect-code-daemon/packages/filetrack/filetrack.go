package filetrack

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// MaxSnapshotBytes bounds how much original content is kept per file. Files
// larger than this are still listed in the balloon but carry no textual diff
// (Binary or TooLarge), so one huge file can't exhaust daemon memory.
const MaxSnapshotBytes = 2 << 20 // 2MB

// TrackedFile is the per-file snapshot for one turn. Only the FIRST sighting
// of a path inside a turn is stored; later touches are ignored.
type TrackedFile struct {
	// Path is the absolute, cleaned path.
	Path string
	// Before holds the content as first seen in the turn. Empty when the
	// file did not exist yet (HasBefore == false).
	Before string
	// HasBefore is false when the file was marked as new (write to a path
	// that did not exist on disk at write time).
	HasBefore bool
	// CreatedWithWrite mirrors the user's vocabulary: the entry was first
	// seen via write. Kept for debugging/display; the source of truth for
	// "new" is !HasBefore.
	CreatedWithWrite bool
	// Binary/TooLarge files are listed but never diffed textually.
	Binary   bool
	TooLarge bool
}

// TurnTracker is the per-turn hashmap: path -> first-seen snapshot.
// It is the "incoming changes" area while the turn runs.
type TurnTracker struct {
	mu    sync.Mutex
	files map[string]*TrackedFile
}

func NewTurnTracker() *TurnTracker {
	return &TurnTracker{files: make(map[string]*TrackedFile)}
}

func cleanPath(p string) string {
	return filepath.Clean(p)
}

// has returns true when the path is already tracked.
func (t *TurnTracker) has(path string) bool {
	_, ok := t.files[cleanPath(path)]
	return ok
}

// NoteRead records the content of a file seen via read. First sighting only.
func (t *TurnTracker) NoteRead(absPath, content string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := cleanPath(absPath)
	if _, ok := t.files[p]; ok {
		return
	}
	t.files[p] = &TrackedFile{Path: p, Before: content, HasBefore: true}
}

// NoteWrite records a write. First sighting only:
//   - file existed on disk -> snapshot oldContent, not created with write.
//   - file did not exist   -> mark as new (no content stored; the final
//     content is read at end of turn if the file still exists).
func (t *TurnTracker) NoteWrite(absPath string, existed bool, oldContent string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := cleanPath(absPath)
	if _, ok := t.files[p]; ok {
		return
	}
	if !existed {
		t.files[p] = &TrackedFile{Path: p, HasBefore: false, CreatedWithWrite: true}
		return
	}
	t.files[p] = &TrackedFile{Path: p, Before: oldContent, HasBefore: true}
}

// NoteEditBefore records the content of a file right before an edit.
// First sighting only.
func (t *TurnTracker) NoteEditBefore(absPath, beforeContent string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := cleanPath(absPath)
	if _, ok := t.files[p]; ok {
		return
	}
	t.files[p] = &TrackedFile{Path: p, Before: beforeContent, HasBefore: true}
}

// NoteBinaryNew marks a newly created non-text file (no content stored).
func (t *TurnTracker) NoteBinaryNew(absPath string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := cleanPath(absPath)
	if _, ok := t.files[p]; ok {
		return
	}
	t.files[p] = &TrackedFile{Path: p, HasBefore: false, CreatedWithWrite: true, Binary: true}
}

// Snapshot returns a copy of the tracked files for changed computation.
func (t *TurnTracker) Snapshot() []TrackedFile {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]TrackedFile, 0, len(t.files))
	for _, f := range t.files {
		out = append(out, *f)
	}
	return out
}

// Count returns the number of tracked paths.
func (t *TurnTracker) Count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.files)
}

// Reset clears the incoming changes (called after the final changed is built).
func (t *TurnTracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.files = make(map[string]*TrackedFile)
}

// CapContent truncates snapshot content beyond MaxSnapshotBytes and flags it.
func CapContent(content string) (string, bool) {
	if len(content) > MaxSnapshotBytes {
		return "", true
	}
	return content, false
}



// ReadTextSnapshot reads a file for snapshotting. Binary files return
// ok=false so callers can mark them instead of storing bytes.
func ReadTextSnapshot(absPath string) (content string, ok bool, err error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", false, err
	}
	if isBinaryBytes(data) {
		return "", false, nil
	}
	capped, tooLarge := CapContent(string(data))
	if tooLarge {
		return "", false, nil
	}
	return capped, true, nil
}

func isBinaryBytes(data []byte) bool {
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	return strings.IndexByte(string(data[:n]), 0) >= 0
}
