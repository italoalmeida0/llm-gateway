package main

import (
	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// HarnessSettings stores user-tunable agent behavior and runtime flags.
// v2: Skills/MCP removed (never used, no legacy). Unknown JSON keys from v1
// config files are ignored on load, so old config.json files keep parsing.
type HarnessSettings struct {
	Model                string  `json:"model,omitempty"`
	Reasoning            string  `json:"reasoning,omitempty"` // "off" | "low" | "medium" | "high"
	Temperature          float32 `json:"temperature,omitempty"`
	AutoCompactThreshold int     `json:"auto_compact_threshold"` // 0=off, 80, 85, 90, 95
	NoAutoTitle          bool    `json:"no_auto_title,omitempty"`
	JailByDefault        bool    `json:"jail_by_default"`
	ToolRender           string  `json:"tool_render,omitempty"` // "box" | "flat"
	CompactInput         bool    `json:"compact_input"`
	CompactMode          bool    `json:"compact_mode"`
	RecursiveFileSuggest bool    `json:"recursive_file_suggest"`
	RespectGitignore     bool    `json:"respect_gitignore"`
	Insecure             bool    `json:"insecure"`
	HTTPProxy            string  `json:"http_proxy,omitempty"`
}

// DaemonConfig holds credentials and gateway connection details.
// v2: MCPServers/Skills removed. v1 files with those keys still parse
// (encoding/json ignores unknown fields).
type DaemonConfig struct {
	AutoUpdate    *bool           `json:"auto_update,omitempty"`
	LastSelection *ModelSelection `json:"last_selection,omitempty"`
	GatewayURL    string          `json:"gateway_url"`
	DaemonToken   string          `json:"daemon_token"`
	APIKey        string          `json:"api_key"`
	HostID        string          `json:"host_id"`
	Name          string          `json:"name"`
	Settings      HarnessSettings `json:"settings"`
}

// AttachmentRef is a file the user attached to a session. The bytes live on
// the host (the daemon's disk) so transcripts stay replayable locally.
type AttachmentRef struct {
	ID        string `json:"id"`
	UploadKey string `json:"uploadKey,omitempty"`
	Name      string `json:"name"`
	Mime      string `json:"mime"`
	Size      int64  `json:"size"`
	Path      string `json:"path"`
	TextPath  string `json:"textPath,omitempty"`
	TextChars int    `json:"textChars,omitempty"`
}

// ProjectEntry groups sessions by host folder. Stored in projects.json next
// to the sessions dir — the daemon is the source of truth, the web client
// only mirrors it as a cache. The default (home) project is protected: it
// can never be deleted and the frontend hides its delete button.
type ProjectEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	CreatedAt int64  `json:"created_at"`
	Protected bool   `json:"protected,omitempty"`
	Collapsed bool   `json:"collapsed,omitempty"`
}

// TurnActivity tracks the currently running (or last) turn.
type TurnActivity struct {
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Status    string `json:"status"`
}

// SessionContext is a usage snapshot for the context window display.
type SessionContext struct {
	UsedTokens   int    `json:"usedTokens"`
	WindowTokens int    `json:"windowTokens"`
	Model        string `json:"model"`
	Estimated    bool   `json:"estimated"`
}

// ModelSelection remembers the last model + options choice.
type ModelSelection struct {
	Model string `json:"model"`
	SessionOptions
}

// SessionOptions are per-session agent behavior flags.
// v2: Skills wiring removed, but the field stays in the WIRE envelope
// (always []) because the frontend and the frozen WS protocol expect it
// (see docs/actor-migration-plan.md §1.1).
type SessionOptions struct {
	Effort string   `json:"effort"`
	Mode   string   `json:"mode"`
	Skills []string `json:"skills"`
	Access string   `json:"access"`
}

// QueuedMessage is one user message waiting for the running turn to finish.
type QueuedMessage struct {
	ID            string   `json:"id"`
	Text          string   `json:"text"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
	Model         string   `json:"model,omitempty"`
	YOLO          bool     `json:"yolo,omitempty"`
	CreatedAt     int64    `json:"createdAt"`
}

// SessionRecord is the on-disk format for each local session.
// Byte-compatible with v1 (same JSON keys) so existing data dirs open
// in v2 with zero migration.
type SessionRecord struct {
	Turn        *TurnActivity      `json:"turn,omitempty"`
	Todos       []tools.TodoItem   `json:"todos,omitempty"`
	TodosOpen   *bool              `json:"todosOpen,omitempty"`
	Options     SessionOptions     `json:"options"`
	ID          string             `json:"id"`
	CWD         string             `json:"cwd"`
	Title       string             `json:"title"`
	TitleSource string             `json:"titleSource,omitempty"`
	Usage       provider.Usage     `json:"usage"`
	Context     *SessionContext    `json:"context,omitempty"`
	Model       string             `json:"model"`
	Status      string             `json:"status"` // "idle" | "running"
	Pinned      bool               `json:"pinned,omitempty"`
	Jailed      bool               `json:"jailed,omitempty"`
	CreatedAt   int64              `json:"createdAt"`
	UpdatedAt   int64              `json:"updatedAt"`
	Messages    []provider.Message `json:"messages"`
	Attachments []AttachmentRef    `json:"attachments,omitempty"`
	LastDate    string             `json:"lastDate,omitempty"`
	LastMode    string             `json:"lastMode,omitempty"`
	// Compaction is the incremental chain head (previous summary +
	// file ops + cut anchor + count). Persisted on every compaction so the
	// next summarization — even after a daemon restart — builds an update
	// prompt instead of re-summarizing from scratch.
	Compaction *core.CompactionState `json:"compaction,omitempty"`
	// TurnSeq counts started turns (monotonic per session). It indexes the
	// per-turn file-change balloons below.
	TurnSeq int `json:"turnSeq,omitempty"`
	// FileBalloons holds one persistent file-changes balloon per finished
	// turn that touched files (snapshot-based, no git).
	FileBalloons []filetrack.TurnChanges `json:"fileBalloons,omitempty"`
	// Queue holds user messages waiting for the running turn to finish.
	// Drained FIFO: when a turn completes normally, the head is promoted
	// to a new turn. A cancelled turn never drains the queue.
	Queue []QueuedMessage `json:"queue,omitempty"`
	// ApprovalDeadlineUnix bounds a pending human approval/question
	// (15 min per request). Persisted so a respawn recomputes the remainder
	// instead of resetting the timer — a restart never bypasses the timeout.
	ApprovalDeadlineUnix int64 `json:"approvalDeadlineUnix,omitempty"`
}

// SessionSummary is returned to the web client for listing.
type SessionSummary struct {
	ID        string          `json:"id"`
	CWD       string          `json:"cwd"`
	Title     string          `json:"title"`
	Model     string          `json:"model"`
	Status    string          `json:"status"`
	Pinned    bool            `json:"pinned"`
	CreatedAt int64           `json:"createdAt"`
	UpdatedAt int64           `json:"updatedAt"`
	TodosOpen *bool           `json:"todosOpen,omitempty"`
	Options   *SessionOptions `json:"options,omitempty"`
}
