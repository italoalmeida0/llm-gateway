package core

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"llm-gateway/indirect-code-daemon/packages/provider"
	_ "modernc.org/sqlite"
)

// SQLiteSessionStore is a SQLite backend: a `sessions` row plus
// an append-only `events` log (message / usage / compaction / meta).
//
// Same semantics as the JSONL backend: readers see the latest
// compaction checkpoint plus rows after it; older rows stay for
// audit. A session can be moved between backends with
// ImportJSONL (jsonl -> sqlite) without transcript changes.

// SQLiteSessionStore persists a session in SQLite.
type SQLiteSessionStore struct {
	db   *sql.DB
	path string
	meta SessionMeta

	freshFile        bool
	messagesAppended int
	compaction       *CompactionState
}

const sqliteSchema = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	cwd TEXT NOT NULL DEFAULT '',
	provider TEXT NOT NULL DEFAULT '',
	model TEXT NOT NULL DEFAULT '',
	version TEXT NOT NULL DEFAULT '',
	title TEXT NOT NULL DEFAULT '',
	parent TEXT NOT NULL DEFAULT '',
	fork_point INTEGER NOT NULL DEFAULT 0,
	hide_from_sessions INTEGER NOT NULL DEFAULT 0,
	started TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL REFERENCES sessions(id),
	seq INTEGER NOT NULL,
	type TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);
`

// OpenSQLiteSessionStore opens (or creates) the SQLite store at path.
// Reopening replays the events log into the effective transcript.
func OpenSQLiteSessionStore(path, cwd string, meta SessionMeta) (*SQLiteSessionStore, error) {
	fresh := false
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
		fresh = true
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(sqliteSchema); err != nil {
		db.Close()
		return nil, err
	}
	s := &SQLiteSessionStore{db: db, path: path, freshFile: fresh}
	if fresh {
		if meta.ID == "" {
			meta.ID = "ses_" + uuid.New().String()[:8]
		}
		if meta.Started.IsZero() {
			meta.Started = time.Now()
		}
		if cwd != "" {
			meta.CWD = cwd
		}
		if err := s.insertSession(meta); err != nil {
			db.Close()
			return nil, err
		}
		s.meta = meta
		return s, nil
	}
	m, err := s.loadSession()
	if err != nil {
		db.Close()
		return nil, err
	}
	s.meta = m
	// Restore the in-memory compaction chain head so the next
	// compaction builds an update prompt.
	if _, st, err := s.readLocked(); err == nil {
		s.compaction = st
	}
	return s, nil
}

func (s *SQLiteSessionStore) insertSession(m SessionMeta) error {
	hide := 0
	if m.HideFromSessions {
		hide = 1
	}
	_, err := s.db.Exec(`INSERT INTO sessions(id,cwd,provider,model,version,title,parent,fork_point,hide_from_sessions,started)
		VALUES(?,?,?,?,?,?,?,?,?,?)`,
		m.ID, m.CWD, m.Provider, m.Model, m.Version, m.Title, m.Parent, m.ForkPoint, hide, m.Started.Format(time.RFC3339Nano))
	return err
}

func (s *SQLiteSessionStore) loadSession() (SessionMeta, error) {
	var m SessionMeta
	var hide int
	var started string
	err := s.db.QueryRow(`SELECT id,cwd,provider,model,version,title,parent,fork_point,hide_from_sessions,started
		FROM sessions LIMIT 1`).Scan(
		&m.ID, &m.CWD, &m.Provider, &m.Model, &m.Version, &m.Title, &m.Parent, &m.ForkPoint, &hide, &started)
	if err != nil {
		return m, err
	}
	m.HideFromSessions = hide != 0
	if started != "" {
		if t, err := time.Parse(time.RFC3339Nano, started); err == nil {
			m.Started = t
		}
	}
	// Count message events for the fresh-empty cleanup policy.
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM events WHERE session_id=? AND type='message'`, m.ID).Scan(&n)
	s.messagesAppended = n
	return m, nil
}

func (s *SQLiteSessionStore) nextSeq() (int, error) {
	var seq sql.NullInt64
	err := s.db.QueryRow(`SELECT MAX(seq) FROM events WHERE session_id=?`, s.meta.ID).Scan(&seq)
	if err != nil {
		return 0, err
	}
	if !seq.Valid {
		return 1, nil
	}
	return int(seq.Int64) + 1, nil
}

func (s *SQLiteSessionStore) appendEvent(typ, body string) error {
	seq, err := s.nextSeq()
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO events(session_id,seq,type,body,created_at) VALUES(?,?,?,?,?)`,
		s.meta.ID, seq, typ, body, time.Now().Format(time.RFC3339Nano))
	return err
}

func (s *SQLiteSessionStore) Path() string { return s.path }

func (s *SQLiteSessionStore) Meta() SessionMeta { return s.meta }

func (s *SQLiteSessionStore) AppendMessage(m provider.Message) error {
	if s == nil {
		return nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := s.appendEvent("message", string(b)); err != nil {
		return err
	}
	s.messagesAppended++
	return nil
}

func (s *SQLiteSessionStore) AppendUsage(u, cum provider.Usage) error {
	if s == nil {
		return nil
	}
	b, err := json.Marshal(map[string]provider.Usage{"usage": u, "cumulative": cum})
	if err != nil {
		return err
	}
	return s.appendEvent("usage", string(b))
}

func (s *SQLiteSessionStore) AppendCompaction(state *CompactionState) error {
	if s == nil {
		return nil
	}
	b, err := json.Marshal(map[string]any{"compaction": state})
	if err != nil {
		return err
	}
	if err := s.appendEvent("compaction", string(b)); err != nil {
		return err
	}
	// A checkpoint is durable content: counts toward Close()'s
	// "keep non-empty sessions" policy.
	s.messagesAppended++
	s.compaction = state
	return nil
}

func (s *SQLiteSessionStore) UpdateModel(providerName, model string) error {
	if s == nil {
		return nil
	}
	s.meta.Provider = providerName
	s.meta.Model = model
	if _, err := s.db.Exec(`UPDATE sessions SET provider=?, model=? WHERE id=?`, providerName, model, s.meta.ID); err != nil {
		return err
	}
	b, err := json.Marshal(s.meta)
	if err != nil {
		return err
	}
	return s.appendEvent("meta", string(b))
}

func (s *SQLiteSessionStore) ReadTranscript() ([]provider.Message, error) {
	if s == nil {
		return nil, nil
	}
	msgs, _, err := s.readLocked()
	return msgs, err
}

func (s *SQLiteSessionStore) readLocked() ([]provider.Message, *CompactionState, error) {
	rows, err := s.db.Query(`SELECT type,body FROM events WHERE session_id=? ORDER BY seq ASC`, s.meta.ID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var effective []provider.Message
	var state *CompactionState
	for rows.Next() {
		var typ, body string
		if err := rows.Scan(&typ, &body); err != nil {
			continue
		}
		switch typ {
		case "message":
			var raw json.RawMessage
			if err := json.Unmarshal([]byte(body), &raw); err != nil {
				continue
			}
			m, err := HydrateMessageObject(raw)
			if err != nil {
				continue
			}
			effective = append(effective, m)
		case "compaction":
			var row struct {
				Compaction *CompactionState `json:"compaction"`
			}
			if err := json.Unmarshal([]byte(body), &row); err != nil {
				continue
			}
			// Append-only checkpoint: history stays,
			// only the chain head advances.
			state = row.Compaction
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return repairToolUseResultPairs(effective), state, nil
}

func (s *SQLiteSessionStore) CompactionState() *CompactionState {
	if s == nil {
		return nil
	}
	return s.compaction
}

func (s *SQLiteSessionStore) SetCompactionState(state *CompactionState) {
	if s == nil {
		return
	}
	s.compaction = state
}

func (s *SQLiteSessionStore) Usage() (cumulative, lastTurn provider.Usage, err error) {
	if s == nil {
		return provider.Usage{}, provider.Usage{}, nil
	}
	rows, err := s.db.Query(`SELECT body FROM events WHERE session_id=? AND type='usage' ORDER BY seq ASC`, s.meta.ID)
	if err != nil {
		return provider.Usage{}, provider.Usage{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			continue
		}
		var row struct {
			Usage      provider.Usage `json:"usage"`
			Cumulative provider.Usage `json:"cumulative"`
		}
		if err := json.Unmarshal([]byte(body), &row); err != nil {
			continue
		}
		cumulative = row.Cumulative
		lastTurn = row.Usage
	}
	return cumulative, lastTurn, rows.Err()
}

func (s *SQLiteSessionStore) Close() error {
	if s == nil {
		return nil
	}
	err := s.db.Close()
	if s.freshFile && s.messagesAppended == 0 {
		// Drop empty stubs.
		_ = os.Remove(s.path)
	}
	return err
}

