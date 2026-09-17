package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Session WAL (write-ahead log): during a turn the session JSON stays
// FROZEN on disk and every small mutation is appended as one JSON line to
// <id>.wal.jsonl. When the turn truly ends, the in-memory record is saved
// once (single full rewrite) and the WAL is deleted.
//
// On-disk rule: with Status=running, the truth is frozen-JSON + WAL.
// With Status=idle, the truth is the JSON alone (no WAL file exists).
//
// Durability: appends are buffered (one open file handle per running
// session) with flush on every turn-index boundary and fsync on commit.
// A daemon crash loses at most the unflushed tail; the frozen JSON plus
// the flushed prefix always replay to a consistent record.

const walVersion = 1

// WAL event types. Small, append-only, replayed in order.
const (
	walTypeHeader     = "header"      // first line: turn identity + recovery prompt
	walTypeMsg        = "msg"         // one appended transcript message
	walTypeUsage      = "usage"       // usage + context snapshot
	walTypeCompaction = "compaction"  // compaction chain head
	walTypeTodos      = "todos"       // todo list replace
	walTypeIncoming   = "incoming"    // file-tracker snapshot
	walTypeQueue      = "queue"       // queue replace (add/update/remove/shift)
	walTypeTitle      = "title"       // title + source
	walTypeModel      = "model"       // model switch
	walTypeOptions    = "options"     // options replace
	walTypeTurnState  = "turn_state"  // turn activity status flip
	walTypeMeta       = "meta"        // updatedAt / lastDate / lastMode / turn_ms stamps
	walTypeAttach     = "attachments" // attachment list replace (upload)
)

// walHeader is always line 1: the turn's recovery record (prompt,
// tracker seed) plus the turn identity needed to detect a
// commit-window crash.
type walHeader struct {
	TurnIndex     int                     `json:"turnIndex"`
	StartedAt     int64                   `json:"startedAt"`
	Model         string                  `json:"model,omitempty"`
	Prompt        string                  `json:"prompt,omitempty"`
	AttachmentIDs []string                `json:"attachmentIds,omitempty"`
	Incoming      []filetrack.TrackedFile `json:"incoming,omitempty"`
}

// walEvent is one JSONL line. Only the fields for its Type are set.
//
// Msg is raw JSON (not provider.Message): message Content blocks are an
// interface and only rehydrate through core.HydrateMessageObject, the
// same path disk loads use. Replay hydrates it back.
type walEvent struct {
	V           int                     `json:"v"`
	Type        string                  `json:"type"`
	Header      *walHeader              `json:"header,omitempty"`
	Msg         json.RawMessage         `json:"msg,omitempty"`
	Usage       *provider.Usage         `json:"usage,omitempty"`
	Context     *SessionContext         `json:"context,omitempty"`
	Compaction  *core.CompactionState   `json:"compaction,omitempty"`
	Todos       []tools.TodoItem        `json:"todos,omitempty"`
	Incoming    []filetrack.TrackedFile `json:"incoming,omitempty"`
	Queue       []QueuedMessage         `json:"queue,omitempty"`
	Title       string                  `json:"title,omitempty"`
	TitleSource string                  `json:"titleSource,omitempty"`
	Model       string                  `json:"model,omitempty"`
	Options     *SessionOptions         `json:"options,omitempty"`
	TurnStatus  string                  `json:"turnStatus,omitempty"`
	Attachments []AttachmentRef         `json:"attachments,omitempty"`
	UpdatedAt   int64                   `json:"updatedAt,omitempty"`
	LastDate    string                  `json:"lastDate,omitempty"`
	LastMode    string                  `json:"lastMode,omitempty"`
}

// walWriter is the buffered append handle for one running turn.
type walWriter struct {
	mu   sync.Mutex
	file *os.File
	w    *bufio.Writer
	path string
}

// brainDir resolves the per-session private scratch space
// (<dataDir>/brain/<sessionID>), refusing traversal. It is created lazily
// and allowed through the jail so the model always has somewhere to put
// temporary files, test scripts and experiment output.
func (d *DaemonServer) brainDir(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(d.dataDir, "brain", sessionID)
}

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.
func (d *DaemonServer) ensureBrainDir(sessionID string) string {
	dir := d.brainDir(sessionID)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// walPath resolves <id>.wal.jsonl, refusing traversal.
func (d *DaemonServer) walPath(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(d.sessionsDir(), sessionID+".wal.jsonl")
}

// openWAL creates (or truncates) the WAL and writes the header line.
func (d *DaemonServer) openWAL(sessionID string, h *walHeader) (*walWriter, error) {
	p := d.walPath(sessionID)
	if p == "" {
		return nil, fmt.Errorf("invalid session id")
	}
	if err := os.MkdirAll(d.sessionsDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	ww := &walWriter{file: f, w: bufio.NewWriterSize(f, 64*1024), path: p}
	if err := ww.append(walEvent{V: walVersion, Type: walTypeHeader, Header: h}); err != nil {
		f.Close()
		_ = os.Remove(p)
		return nil, err
	}
	if err := ww.flush(); err != nil {
		f.Close()
		_ = os.Remove(p)
		return nil, err
	}
	return ww, nil
}

func (ww *walWriter) append(ev walEvent) error {
	if ww == nil {
		return fmt.Errorf("nil wal writer")
	}
	ev.V = walVersion
	data, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	if _, err := ww.w.Write(data); err != nil {
		return err
	}
	if err := ww.w.WriteByte('\n'); err != nil {
		return err
	}
	return nil
}

func (ww *walWriter) flush() error {
	if ww == nil {
		return nil
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	return ww.w.Flush()
}

// close flushes, fsyncs and closes the handle. The file itself stays on
// disk until commitWAL removes it.
func (ww *walWriter) close() error {
	if ww == nil {
		return nil
	}
	ww.mu.Lock()
	defer ww.mu.Unlock()
	err := ww.w.Flush()
	if syncErr := ww.file.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := ww.file.Close(); err == nil {
		err = closeErr
	}
	return err
}

// readWALHeader returns the header (line 1) without replaying the body.
// Nil when no WAL exists.
func (d *DaemonServer) readWALHeader(sessionID string) (*walHeader, error) {
	p := d.walPath(sessionID)
	if p == "" {
		return nil, nil
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	if !sc.Scan() {
		return nil, nil
	}
	var ev walEvent
	if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
		return nil, err
	}
	if ev.Type != walTypeHeader || ev.Header == nil {
		return nil, fmt.Errorf("wal %s: missing header", sessionID)
	}
	return ev.Header, nil
}

// replayWAL applies every event after the header onto base (which must be
// the frozen JSON record) and returns the fused record. A truncated final
// line (crash mid-write) is ignored; a corrupt middle line aborts the
// replay with an error (fail-closed: never half-apply).
func replayWAL(base *SessionRecord, data []byte) (*SessionRecord, *walHeader, error) {
	rec := base
	var header *walHeader
	lines := bytes.Split(data, []byte{'\n'})
	for i, line := range lines {
		line = bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var ev walEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			// Tolerate only a torn tail write: the last non-empty line
			// may be a partial append from a killed process.
			if i == len(lines)-1 || (i == len(lines)-2 && len(bytes.TrimSpace(lines[len(lines)-1])) == 0) {
				break
			}
			return nil, nil, fmt.Errorf("wal line %d: %w", i+1, err)
		}
		if i == 0 {
			if ev.Type != walTypeHeader || ev.Header == nil {
				return nil, nil, fmt.Errorf("wal: missing header")
			}
			header = ev.Header
			continue
		}
		if err := applyWALEvent(rec, &ev); err != nil {
			return nil, nil, fmt.Errorf("wal line %d: %w", i+1, err)
		}
	}
	if header == nil {
		return nil, nil, fmt.Errorf("wal: empty")
	}
	return rec, header, nil
}

func applyWALEvent(rec *SessionRecord, ev *walEvent) error {
	switch ev.Type {
	case walTypeHeader:
		return nil // identity only, already consumed
	case walTypeMsg:
		if len(ev.Msg) == 0 {
			return fmt.Errorf("msg event without message")
		}
		m, err := core.HydrateMessageObject(ev.Msg)
		if err != nil {
			return err
		}
		rec.Messages = append(rec.Messages, m)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeUsage:
		if ev.Usage != nil {
			rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			rec.Context = ev.Context
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeCompaction:
		if ev.Compaction != nil {
			rec.Compaction = ev.Compaction
		}
		if ev.Usage != nil {
			rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			rec.Context = ev.Context
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTodos:
		rec.Todos = append([]tools.TodoItem{}, ev.Todos...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeIncoming:
		// Incoming tracker snapshots are replayed by the caller into the
		// live turnFileChanges; the record itself carries no incoming.
		return nil
	case walTypeQueue:
		rec.Queue = append([]QueuedMessage{}, ev.Queue...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTitle:
		rec.Title = ev.Title
		rec.TitleSource = ev.TitleSource
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeModel:
		rec.Model = ev.Model
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeOptions:
		if ev.Options != nil {
			rec.Options = *ev.Options
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeTurnState:
		if rec.Turn != nil {
			rec.Turn.Status = ev.TurnStatus
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeAttach:
		rec.Attachments = append([]AttachmentRef{}, ev.Attachments...)
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
	case walTypeMeta:
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
		if ev.LastDate != "" {
			rec.LastDate = ev.LastDate
		}
		if ev.LastMode != "" {
			rec.LastMode = ev.LastMode
		}
	default:
		return fmt.Errorf("unknown wal event %q", ev.Type)
	}
	return nil
}

// loadSessionFused loads the frozen JSON and, when a WAL exists, replays
// it on top. This is the read path mirrors and history pulls use during
// a running turn: always current, never a mid-turn rewrite.
func (d *DaemonServer) loadSessionFused(id string) (*SessionRecord, *walHeader, error) {
	rec, err := d.loadSession(id)
	if err != nil {
		return nil, nil, err
	}
	p := d.walPath(id)
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

// commitWAL performs the single full JSON rewrite at turn end and deletes
// the WAL. Callers must hold act.mu; the in-memory record is already the
// complete post-turn state. The WAL is removed only after the JSON commit
// is durable, so a crash in between replays idempotently (commit-window
// detection in scanWALs/resume drops the already-committed log).
func (d *DaemonServer) commitWAL(act *ActiveSession) error {
	if act == nil || act.record == nil {
		return fmt.Errorf("nil session")
	}
	id := act.record.ID
	if act.wal != nil {
		_ = act.wal.close()
		act.wal = nil
	}
	act.record.UpdatedAt = time.Now().UnixMilli()
	if err := d.saveSessionSync(act.record); err != nil {
		return err
	}
	if p := d.walPath(id); p != "" {
		_ = os.Remove(p)
	}
	return nil
}

// discardWAL closes and removes the WAL without committing (purge path).
func (d *DaemonServer) discardWAL(act *ActiveSession) {
	if act != nil && act.wal != nil {
		_ = act.wal.close()
		act.wal = nil
	}
}

// saveSessionSync writes the record atomically (tmp + rename + fsync)
// without emitting a change ping. The WAL commit path batches its own
// single ping after the write.
func (d *DaemonServer) saveSessionSync(rec *SessionRecord) error {
	dir := d.sessionsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	filePath := filepath.Join(dir, rec.ID+".json")
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".session-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmpName, filePath); err != nil {
		return err
	}
	// Fsync the directory entry so the rename survives a power loss.
	if df, err := os.Open(dir); err == nil {
		_ = df.Sync()
		df.Close()
	}
	return nil
}

// scanWALs lists session IDs with a WAL file on disk.
func (d *DaemonServer) scanWALs() []string {
	entries, err := os.ReadDir(d.sessionsDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".wal.jsonl") {
			continue
		}
		out = append(out, strings.TrimSuffix(name, ".wal.jsonl"))
	}
	return out
}

// walMsgEvent builds a msg event from a live message, serializing it in
// the same raw shape disk loads hydrate back.
func walMsgEvent(m provider.Message) walEvent {
	data, err := json.Marshal(m)
	if err != nil {
		return walEvent{Type: walTypeMsg}
	}
	return walEvent{Type: walTypeMsg, Msg: data}
}

// appendWALEvent appends one event to the session's open WAL handle and
// flushes it to the OS (write syscall, no fsync). A SIGKILL loses
// nothing; only an OS/power crash loses the tail. The fsync happens
// once at commit. Callers hold act.mu; a nil handle means no turn is in
// WAL mode and the event is dropped (callers fall back to a direct save
// in that case).
func (d *DaemonServer) appendWALEvent(act *ActiveSession, ev walEvent) {
	if act == nil || act.wal == nil {
		return
	}
	if ev.UpdatedAt == 0 {
		switch ev.Type {
		case walTypeMsg, walTypeUsage, walTypeCompaction, walTypeTodos,
			walTypeQueue, walTypeTitle, walTypeModel, walTypeOptions,
			walTypeTurnState, walTypeMeta, walTypeAttach:
			ev.UpdatedAt = time.Now().UnixMilli()
		}
	}
	_ = act.wal.append(ev)
	_ = act.wal.flush()
}


// cloneWALHeader deep-copies a header so resume can overlay the latest
// body snapshots without mutating the caller's copy.
func cloneWALHeader(h *walHeader) *walHeader {
	if h == nil {
		return nil
	}
	cp := *h
	cp.AttachmentIDs = append([]string{}, h.AttachmentIDs...)
	cp.Incoming = append([]filetrack.TrackedFile{}, h.Incoming...)
	return &cp
}
