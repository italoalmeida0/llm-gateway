package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// diskStore is the v2 session/WAL disk layer. It owns NO locks and NO
// goroutines: every method is a pure disk operation called by exactly one
// actor at a time (single ownership ⇒ no synchronization needed).
//
// On-disk format is byte-compatible with v1:
//   - sessions/<id>.jsonl — one line per finished turn + meta last line
//   - sessions/<id>.wal.jsonl — running-turn write-ahead log
//   - <root>/brain/<sessionID> — per-session private scratch space
type diskStore struct {
	dataDir string
}

func newDiskStore(dataDir string) *diskStore {
	return &diskStore{dataDir: dataDir}
}

// sessionsDir: the daemon ALWAYS runs with dataDir = the slot dir
// (<root>/slots/slot-a|b), so sessions live at <slot>/sessions.
func (s *diskStore) sessionsDir() string {
	return filepath.Join(s.dataDir, "sessions")
}

func (s *diskStore) sessionFile(id string) string {
	return filepath.Join(s.sessionsDir(), id+".jsonl")
}

// rootDir resolves <root> from the slot dataDir (<root>/slots/slot-x).
func (s *diskStore) rootDir() string {
	if filepath.Base(filepath.Dir(s.dataDir)) == "slots" {
		return filepath.Dir(filepath.Dir(s.dataDir))
	}
	return s.dataDir
}

// brainDir resolves the per-session private scratch space
// (<root>/brain/<sessionID>), refusing traversal.
func (s *diskStore) brainDir(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(s.rootDir(), "brain", sessionID)
}

// walPath resolves <id>.wal.jsonl, refusing traversal.
func (s *diskStore) walPath(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(s.sessionsDir(), sessionID+".wal.jsonl")
}

// loadSession loads a session record (frozen JSON only, no WAL replay).
func (s *diskStore) loadSession(id string) (*SessionRecord, error) {
	if !validSessionID(id) {
		return nil, fmt.Errorf("invalid session id")
	}
	lines, meta, err := s.readSessionFile(id)
	if err != nil {
		return nil, err
	}
	rec := assembleRecord(lines, meta)
	if rec.ID != id || rec.ID == "" {
		return nil, fmt.Errorf("session id mismatch")
	}
	return rec, nil
}

// loadSessionFused loads the frozen JSON and, when a WAL exists, replays
// it on top. The read path during a running turn: always current, never a
// mid-turn rewrite.
func (s *diskStore) loadSessionFused(id string) (*SessionRecord, *walHeader, error) {
	rec, err := s.loadSession(id)
	if err != nil {
		return nil, nil, err
	}
	p := s.walPath(id)
	if p == "" {
		return rec, nil, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return rec, nil, nil
		}
		return nil, nil, err
	}
	fused, header, err := replayWAL(rec, data)
	if err != nil {
		return nil, nil, err
	}
	return fused, header, nil
}

// saveSessionSync writes the record atomically (tmp + rename + fsync).
func (s *diskStore) saveSessionSync(rec *SessionRecord) error {
	lines, meta := splitRecord(rec)
	return s.writeSessionFile(rec.ID, lines, meta)
}

// scanWALs lists session IDs with a WAL file on disk.
func (s *diskStore) scanWALs() []string {
	entries, err := os.ReadDir(s.sessionsDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || len(name) < 10 || name[len(name)-10:] != ".wal.jsonl" {
			continue
		}
		out = append(out, name[:len(name)-10])
	}
	return out
}
