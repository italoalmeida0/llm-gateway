package core

import (
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Session persistence: SessionStore.
//
// SessionStore defines the contract needed by the Agent/daemon:
//
//	AppendMessage / AppendUsage / AppendCompaction / UpdateModel /
//	ReadTranscript / CompactionState / Close
//
// Implementations:
//   - JSONLSessionStore (session_store_jsonl.go): JSONL format,
//     byte-compatible with existing sessions.
//   - SQLiteSessionStore (session_store_sqlite.go): SQLite backend
//     (sessions + events), with append-only semantics.
//
// The Agent accepts a SessionStore via AttachStore and persists through it.
// Hosts choose the backend by path extension (.jsonl -> JSONL,
// .db/.sqlite* -> SQLite) via OpenSessionStore.

// SessionStore is the persistence contract for a conversation
// transcript. All writes are append-only:
// message rows accumulate and compaction checkpoints only advance the
// chain head. History is never rewritten — readers replay the full
// history and derive the effective context by projection
// (projectMessages over CompactionState).
type SessionStore interface {
	// Path returns the backing file path (for logging/display).
	Path() string
	// Meta returns the session metadata (id, cwd, model...).
	Meta() SessionMeta
	// AppendMessage persists one transcript message.
	AppendMessage(m provider.Message) error
	// AppendUsage persists a usage row.
	AppendUsage(u, cum provider.Usage) error
	// AppendCompaction persists a compaction checkpoint: the chain
	// head (summary + file ops + KeepFrom anchor) appended as one
	// row. History rows are NOT rewritten: the
	// compaction is just another entry in the append-only log and
	// context is derived by projection at read time.
	AppendCompaction(state *CompactionState) error
	// UpdateModel records a provider/model switch.
	UpdateModel(providerName, model string) error
	// ReadTranscript replays the full append-only history from
	// oldest to newest, with orphan tool_use
	// repaired. The effective model context is the projection of
	// this history over CompactionState — see projectMessages.
	ReadTranscript() ([]provider.Message, error)
	// CompactionState returns the incremental chain head, or nil.
	CompactionState() *CompactionState
	// SetCompactionState replaces the in-memory chain head without
	// writing (hydration path).
	SetCompactionState(state *CompactionState)
	// Usage replays usage rows (for cost display on resume).
	Usage() (cumulative, lastTurn provider.Usage, err error)
	// Close flushes and closes the store. Fresh empty stores may
	// delete their backing file (same policy as Session.Close).
	Close() error
}

// OpenSessionStore opens (or creates) the store backing path,
// dispatching on extension like the daemon's session loader:
//
//	.db, .sqlite, .sqlite3 -> SQLiteSessionStore
//	anything else          -> JSONLSessionStore (legacy default)
//
// meta is used only when creating a new store (first line /
// sessions row). Reopening an existing path ignores meta except
// for CWD fallback.
func OpenSessionStore(path, cwd string, meta SessionMeta) (SessionStore, error) {
	if IsSQLitePath(path) {
		return OpenSQLiteSessionStore(path, cwd, meta)
	}
	return OpenJSONLSessionStore(path, cwd, meta)
}

// MustJSONLPathForSQLite reports whether path looks like a SQLite
// backing file. Exported for hosts that list/route session files.
func IsSQLitePath(path string) bool {
	return isSQLitePath(path)
}
