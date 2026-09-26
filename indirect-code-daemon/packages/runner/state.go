package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/internal/durable"
)

// Transport is the optional IPC endpoint (absent = file-only mode).
type Transport struct {
	Type  string `json:"type"` // "tcp"
	Host  string `json:"host"` // always 127.0.0.1
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// State is the durable per-task record (decided: written IMMEDIATELY at
// start — durability never waits). Readers MUST ignore unknown fields;
// the schema only grows. `status: done|killed` with ExitCode set IS the
// completion record and also the retained notice source.
type State struct {
	V               int    `json:"v"`
	Proto           int    `json:"proto"`
	RunnerVersion   string `json:"runnerVersion"`
	JobID           string `json:"jobId"`
	SessionID       string `json:"sessionId"`
	Kind            string `json:"kind"`
	Label           string `json:"label"`
	PID             int    `json:"pid"`
	ProcessIdentity string `json:"processIdentity,omitempty"`
	CommandIdentity string `json:"commandIdentity,omitempty"`
	// CmdPID/CmdPgid are the COMMAND's identity (V2R-002): the runner owns
	// the command's lifetime, and this durable identity lets a supervisor
	// reap the command's group after the runner itself is gone.
	CmdPID         int       `json:"cmdPid,omitempty"`
	CmdPgid        int       `json:"cmdPgid,omitempty"`
	StartedAt      int64     `json:"startedAt"`
	LogPath        string    `json:"logPath"`
	BrainPath      string    `json:"brainPath"`
	Transport      Transport `json:"transport"`
	Status         string    `json:"status"`
	ExitCode       *int      `json:"exitCode"`
	EndedAt        *int64    `json:"endedAt"`
	OutputReady    bool      `json:"outputReady,omitempty"`
	OutcomeUnknown bool      `json:"outcomeUnknown,omitempty"`
	HeartbeatAt    int64     `json:"heartbeatAt"`
}

// Terminal reports whether the task reached a final state.
func (s *State) Terminal() bool {
	return s.Status == StatusDone || s.Status == StatusKilled
}

// StatePath is <root>/runners/<jobId>.state.json.
func StatePath(root, jobID string) string {
	return filepath.Join(RunnersDir(root), sanitize(jobID)+".state.json")
}

// RunnersDir is <root>/runners (created on demand).
func RunnersDir(root string) string {
	return filepath.Join(root, "runners")
}

// OutDir is <root>/runners/out — GC-EXEMPT (decided D8).
func OutDir(root string) string {
	return filepath.Join(RunnersDir(root), "out")
}

// WriteState atomically replaces the state file (tmp+rename+fsync).
func WriteState(root string, st *State) error {
	if err := os.MkdirAll(RunnersDir(root), 0o700); err != nil {
		return err
	}
	st.V = 1
	st.Proto = ProtoVersion
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return durable.Write(StatePath(root, st.JobID), raw)
}

// ReadState parses one state file. Unknown fields are ignored (rule 1).
func ReadState(path string) (*State, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, err
	}
	if st.JobID == "" {
		return nil, os.ErrInvalid
	}
	return &st, nil
}

// LoadStates is the compatibility view. Recovery uses ScanStates to expose
// unreadable records rather than silently declaring them absent.
func LoadStates(root string) []*State {
	states, _ := ScanStates(root)
	return states
}

// ScanStates returns valid records and the filenames needing operator review.
// Invalid records remain on disk; no untrusted contents are logged.
func ScanStates(root string) ([]*State, []string) {
	entries, err := os.ReadDir(RunnersDir(root))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{"runners"}
	}
	var out []*State
	var invalid []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".state.json") {
			continue
		}
		st, err := ReadState(filepath.Join(RunnersDir(root), e.Name()))
		if err != nil || e.Name() != filepath.Base(StatePath(root, st.JobID)) {
			invalid = append(invalid, e.Name())
			continue
		}
		out = append(out, st)
	}
	return out, invalid
}

// Touch records a heartbeat timestamp (best-effort, throttled by caller).
func (s *State) Touch() { s.HeartbeatAt = time.Now().UnixMilli() }

// Execution disposition (V2R-001): the durable record of HOW a task's
// outcome was consumed, so recovery never invents a wake-up. Absent file
// = "inline" (a foreground command that returned to the agent directly —
// silent). A sidecar keeps this race-free against the runner's own state
// writes.
const (
	DispBackground = "background" // registered as a background job: notify on terminal
	DispInline     = "inline"     // returned inline to the agent: silent
	DispSuppressed = "suppressed" // cancelled silently (assistant): silent
)

// DispositionPath is <root>/runners/<jobId>.disposition.
func DispositionPath(root, jobID string) string {
	return filepath.Join(RunnersDir(root), sanitize(jobID)+".disposition")
}

// WriteDisposition records the disposition durably (atomic tmp+rename).
func WriteDisposition(root, jobID, disp string) error {
	if jobID == "" {
		return nil
	}
	if err := os.MkdirAll(RunnersDir(root), 0o700); err != nil {
		return err
	}
	return durable.Write(DispositionPath(root, jobID), []byte(disp+"\n"))
}

// ReadDisposition returns the recorded disposition ("" when absent, which
// callers treat as DispInline).
func ReadDisposition(root, jobID string) string {
	raw, err := os.ReadFile(DispositionPath(root, jobID))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
