package core

import (
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Session persistence: SessionStore.
//
// SessionStore defines the contract needed by the Agent/daemon:
//
//	AppendMessage / AppendUsage / AppendCompaction / UpdateModel /
//	ReadTranscript / CompactionState / Close
//
// Implementation: SQLiteSessionStore (session_store_sqlite.go) —
// SQLite backend (sessions + events), with append-only semantics.
//
// The Agent accepts a SessionStore via AttachStore and persists through it.
// Hosts open the backend via OpenSQLiteSessionStore.

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

// SessionMeta identifies a session: written once on creation and
// returned by Meta().
type SessionMeta struct {
	ID       string    `json:"id"`
	CWD      string    `json:"cwd"`
	Model    string    `json:"model"`
	Provider string    `json:"provider"`
	Started  time.Time `json:"started"`
	Version  string    `json:"version"`
	Title    string    `json:"title,omitempty"`

	// Parent is the ID of the session this one was forked from, or
	// empty for top-level sessions.
	Parent string `json:"parent,omitempty"`
	// ForkPoint is the 0-indexed message position within the parent
	// transcript where this branch diverges.
	ForkPoint int `json:"fork_point,omitempty"`
	// HideFromSessions hides internal tree-navigation branches from the
	// flat /sessions picker while keeping them available for the tree.
	HideFromSessions bool `json:"hide_from_sessions,omitempty"`
}
