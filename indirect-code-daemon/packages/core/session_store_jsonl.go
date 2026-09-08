package core

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// JSONLSessionStore is the legacy JSONL file backend behind the
// SessionStore interface. Byte-compatible with existing sessions:
// same sessionLine rows, same append-only compaction checkpoints,
// same fresh-empty-file cleanup on Close.
//
// This is the default backend (any non-SQLite path). It wraps the
// existing Session type so behavior cannot drift: every method
// delegates.

// JSONLSessionStore wraps *Session as a SessionStore.
type JSONLSessionStore struct {
	s *Session
}

// OpenJSONLSessionStore opens (or creates) the JSONL store at path.
// When the file exists it replays it (OpenSession); otherwise it
// creates it with meta (NewSessionAtPath).
func OpenJSONLSessionStore(path, cwd string, meta SessionMeta) (*JSONLSessionStore, error) {
	if _, err := os.Stat(path); err == nil {
		s, _, err := OpenSession(path)
		if err != nil {
			return nil, err
		}
		return &JSONLSessionStore{s: s}, nil
	}
	if meta.ID == "" {
		meta.ID = "ses_" + uuid.New().String()[:8]
	}
	s, err := NewSessionAtPath(path, cwd, meta.Provider, meta.Model, meta.Version)
	if err != nil {
		return nil, err
	}
	if meta.Title != "" {
		s.Meta.Title = meta.Title
	}
	if meta.Parent != "" {
		s.Meta.Parent = meta.Parent
		s.Meta.ForkPoint = meta.ForkPoint
		s.Meta.HideFromSessions = meta.HideFromSessions
	}
	return &JSONLSessionStore{s: s}, nil
}

func (j *JSONLSessionStore) Path() string {
	if j == nil || j.s == nil {
		return ""
	}
	return j.s.Path
}

func (j *JSONLSessionStore) Meta() SessionMeta {
	if j == nil || j.s == nil {
		return SessionMeta{}
	}
	return j.s.Meta
}

func (j *JSONLSessionStore) AppendMessage(m provider.Message) error {
	return j.s.AppendMessage(m)
}

func (j *JSONLSessionStore) AppendUsage(u, cum provider.Usage) error {
	return j.s.AppendUsage(u, cum)
}

func (j *JSONLSessionStore) AppendCompaction(messages []provider.Message, state *CompactionState) error {
	return j.s.AppendCompaction(messages, state)
}

func (j *JSONLSessionStore) UpdateModel(providerName, model string) error {
	return j.s.UpdateModel(providerName, model)
}

func (j *JSONLSessionStore) ReadTranscript() ([]provider.Message, error) {
	if j == nil || j.s == nil {
		return nil, nil
	}
	_, msgs, err := OpenSession(j.s.Path)
	if err != nil {
		return nil, err
	}
	return msgs, nil
}

func (j *JSONLSessionStore) CompactionState() *CompactionState {
	return j.s.CompactionState()
}

func (j *JSONLSessionStore) SetCompactionState(state *CompactionState) {
	j.s.SetCompactionState(state)
}

func (j *JSONLSessionStore) Usage() (provider.Usage, provider.Usage, error) {
	if j == nil || j.s == nil {
		return provider.Usage{}, provider.Usage{}, nil
	}
	return SessionUsageDetail(j.s.Path)
}

func (j *JSONLSessionStore) Close() error {
	return j.s.Close()
}

// isSQLitePath reports whether path selects the SQLite backend.
func isSQLitePath(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".db", ".sqlite", ".sqlite3":
		return true
	}
	return false
}

// readJSONLMessages is a backend-agnostic replay helper shared with
// the SQLite importer: returns the effective transcript for a JSONL
// file (latest compaction wins, orphan tool_use repaired).
func readJSONLMessages(path string) ([]provider.Message, *CompactionState, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	var msgs []provider.Message
	var compaction []provider.Message
	var state *CompactionState
	hasCompaction := false
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		var head sessionLineHead
		if err := json.Unmarshal(line, &head); err != nil {
			continue
		}
		switch head.Type {
		case "message":
			m, err := hydrateMessage(line)
			if err != nil {
				continue
			}
			msgs = append(msgs, m)
		case "compaction":
			cm, st, err := hydrateCompactionWithState(line)
			if err != nil {
				continue
			}
			compaction = cm
			state = st
			hasCompaction = true
		}
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	if hasCompaction {
		return repairToolUseResultPairs(compaction), state, nil
	}
	return repairToolUseResultPairs(msgs), state, nil
}
