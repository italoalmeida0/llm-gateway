package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
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
	PromptMeta    map[string]string       `json:"promptMeta,omitempty"`
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
	// ApprovalDeadlineUnix persists the 15-min decision deadline inside the
	// WAL (plan §8): a respawn recomputes the remainder instead of
	// restarting the timer.
	ApprovalDeadlineUnix int64  `json:"approvalDeadlineUnix,omitempty"`
	ClearApprovalDeadline bool `json:"clearApprovalDeadline,omitempty"`
	Pinned               *bool  `json:"pinned,omitempty"`
	Jailed               *bool  `json:"jailed,omitempty"`
	TodosOpen            *bool  `json:"todosOpen,omitempty"`
	LastDate             string `json:"lastDate,omitempty"`
	LastMode             string `json:"lastMode,omitempty"`
}

// walWriter is the buffered append handle for one running turn.
type walWriter struct {
	mu       sync.Mutex
	file     *os.File
	w        *bufio.Writer
	path     string
	closed   bool
	closeErr error
}

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.

// walPath resolves <id>.wal.jsonl, refusing traversal.

// openWAL creates (or truncates) the WAL and writes the header line.

// openWALAppend reopens an existing WAL for append (resume path): the
// valid prefix stays intact; a damaged final event is removed before new
// events are appended. Interior corruption fails without changing the file.

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.
func (s *diskStore) ensureBrainDir(sessionID string) string {
	dir := s.brainDir(sessionID)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// openWAL creates (or truncates) the WAL and writes the header line.
func (s *diskStore) openWAL(sessionID string, h *walHeader) (*walWriter, error) {
	p := s.walPath(sessionID)
	if p == "" {
		return nil, fmt.Errorf("invalid session id")
	}
	if err := os.MkdirAll(s.sessionsDir(), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
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

// openWALAppend reopens an existing WAL for append (resume path): the
// valid prefix stays intact; a damaged final event is removed before new
// events are appended. Interior corruption fails without changing the file.
func (s *diskStore) openWALAppend(sessionID string) (*walWriter, error) {
	p := s.walPath(sessionID)
	if p == "" {
		return nil, fmt.Errorf("invalid session id")
	}
	// Windows append handles omit FILE_WRITE_DATA and cannot truncate. The
	// session actor owns this writer exclusively, so seek after tail repair.
	f, err := os.OpenFile(p, os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	_, _, validEnd, err := replayWALPrefix(&SessionRecord{ID: sessionID}, data)
	if err != nil {
		f.Close()
		return nil, err
	}
	if validEnd < len(data) {
		if err := f.Truncate(int64(validEnd)); err != nil {
			f.Close()
			return nil, err
		}
	}
	if _, err := f.Seek(int64(validEnd), io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	needsNewline := validEnd > 0 && data[validEnd-1] != '\n'
	if needsNewline {
		if _, err := f.WriteString("\n"); err != nil {
			f.Close()
			return nil, err
		}
	}
	if validEnd < len(data) || needsNewline {
		if err := f.Sync(); err != nil {
			f.Close()
			return nil, err
		}
	}
	return &walWriter{file: f, w: bufio.NewWriterSize(f, 64*1024), path: p}, nil
}

// readWALHeader returns the header (line 1) without replaying the body.
// Nil when no WAL exists.
func (s *diskStore) readWALHeader(sessionID string) (*walHeader, error) {
	p := s.walPath(sessionID)
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
	if ww.closed {
		return ww.closeErr
	}
	ww.closed = true
	err := ww.w.Flush()
	if syncErr := ww.file.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := ww.file.Close(); err == nil {
		err = closeErr
	}
	ww.closeErr = err
	return err
}

// readWALHeader returns the header (line 1) without replaying the body.
// Nil when no WAL exists.

// replayWAL applies every event after the header onto base (which must be
// the frozen JSON record) and returns the fused record. A truncated final
// line (crash mid-write) is ignored; a corrupt middle line aborts the
// replay with an error (fail-closed: never half-apply).
func replayWAL(base *SessionRecord, data []byte) (*SessionRecord, *walHeader, error) {
	rec, header, _, err := replayWALPrefix(base, data)
	return rec, header, err
}

// validEnd is the byte boundary shared by read recovery and append repair.
// Never skip corrupt interior events or discard a valid prefix for a bad tail.
func replayWALPrefix(base *SessionRecord, data []byte) (*SessionRecord, *walHeader, int, error) {
	rec := base
	var header *walHeader
	lines := bytes.Split(data, []byte{'\n'})
	last := len(lines) - 1
	for last >= 0 && len(bytes.TrimSpace(lines[last])) == 0 {
		last--
	}
	offset, validEnd := 0, 0
	for i, line := range lines {
		offset = min(offset+len(line)+1, len(data))
		line = bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			validEnd = offset
			continue
		}
		var ev walEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			// Tolerate only a torn tail write: the last non-empty line
			// may be a partial append from a killed process.
			if i == last && header != nil {
				break
			}
			return nil, nil, 0, fmt.Errorf("wal line %d: %w", i+1, err)
		}
		if i == 0 {
			if ev.Type != walTypeHeader || ev.Header == nil {
				return nil, nil, 0, fmt.Errorf("wal: missing header")
			}
			header = ev.Header
			validEnd = offset
			continue
		}
		if err := applyWALEvent(rec, &ev); err != nil {
			if i == last {
				break
			}
			return nil, nil, 0, fmt.Errorf("wal line %d: %w", i+1, err)
		}
		validEnd = offset
	}
	if header == nil {
		return nil, nil, 0, fmt.Errorf("wal: empty")
	}
	return rec, header, validEnd, nil
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
		if ev.Pinned != nil {
			rec.Pinned = *ev.Pinned
		}
		if ev.Jailed != nil {
			rec.Jailed = *ev.Jailed
		}
		if ev.TodosOpen != nil {
			v := *ev.TodosOpen
			rec.TodosOpen = &v
		}
		if ev.UpdatedAt > 0 {
			rec.UpdatedAt = ev.UpdatedAt
		}
		if ev.ClearApprovalDeadline { rec.ApprovalDeadlineUnix = 0 }
		if ev.ApprovalDeadlineUnix > 0 {
			rec.ApprovalDeadlineUnix = ev.ApprovalDeadlineUnix
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

// commitWAL appends the just-finished turn as ONE line + rewrites the meta
// tail, then deletes the WAL. Callers must hold act.mu; the in-memory
// record is the complete post-turn state. Old turn lines are never
// touched (immutability). Idempotent: a re-commit after a crash in the
// commit window skips turn lines already on disk (same turn number +
// same message count) and only rewrites meta.
func (s *diskStore) commitWAL(id string, rec *SessionRecord, wal *walWriter) error {
	if rec == nil {
		return fmt.Errorf("nil session")
	}
	var walErr error
	if wal != nil {
		walErr = wal.close()
	}
	rec.UpdatedAt = time.Now().UnixMilli()
	// Fast path: does the disk already have this turn line?
	lines, _, rerr := s.readSessionFile(id)
	if rerr != nil && !os.IsNotExist(rerr) {
		return rerr
	}
	if walErr != nil {
		// The buffered writer retains its first I/O error. Once storage is
		// writable again, checkpoint the owner's complete record atomically
		// instead of retrying that permanently failed buffer.
		if err := s.saveSessionSync(rec); err != nil {
			return err
		}
		if err := os.Remove(s.walPath(id)); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	turnIdx := rec.TurnSeq
	// Messages of the finished turn (in-memory, includes WAL replay).
	// Mirrors splitRecord: leading TurnIndex-0 notices attach to turn 1.
	var turnMsgs []provider.Message
	for _, m := range rec.Messages {
		if m.TurnIndex == turnIdx || (turnIdx == 1 && m.TurnIndex <= 0) {
			// Leading zeros only: stop attaching zeros once turn 1's
			// own messages started... simpler: attach ALL zero-index
			// messages that appear BEFORE the first turn-1 message.
			// (Trailing zeros after the last turn attach to the last
			// line via splitRecord; in-memory commit of the final turn
			// includes them below.)
			turnMsgs = append(turnMsgs, m)
		}
	}
	// Refine: only leading zeros (before first turnIdx message) + the
	// turn's own messages + trailing zeros after the LAST message when
	// this is the newest turn on disk.
	turnMsgs = sliceTurnMessages(rec.Messages, turnIdx)
	// Zero-index notices at the very head belong to turn 1's line.
	already := false
	for _, tl := range lines {
		if tl.Turn == turnIdx && len(tl.Messages) == len(turnMsgs) {
			already = true
			break
		}
	}
	if !already && (len(turnMsgs) > 0 || turnIdx > 0) {
		raw := make([]json.RawMessage, 0, len(turnMsgs))
		for _, m := range turnMsgs {
			data, err := json.Marshal(m)
			if err != nil {
				return err
			}
			raw = append(raw, data)
		}
		var balloon *filetrack.TurnChanges
		for i := range rec.FileBalloons {
			if rec.FileBalloons[i].TurnIndex == turnIdx {
				cp := rec.FileBalloons[i]
				balloon = &cp
				break
			}
		}
		tl := turnLine{V: storeVersion, Kind: "turn", Turn: turnIdx, Messages: raw, Balloon: balloon, Usage: rec.Usage, Context: rec.Context}
		if err := s.appendTurnLine(id, tl, recordMeta(rec)); err != nil {
			return err
		}
	} else {
		// Turn line present (commit-window retry) or nothing to append:
		// just rewrite meta.
		if err := s.rewriteMetaOnly(id, recordMeta(rec)); err != nil {
			// Fresh session with no lines yet (turn produced no messages):
			// full write.
			if os.IsNotExist(err) {
				if werr := s.saveSessionSync(rec); werr != nil {
					return werr
				}
			} else {
				return err
			}
		}
	}
	if p := s.walPath(id); p != "" {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// sliceTurnMessages extracts one turn's messages with splitRecord's
// zero-index attachment rules: leading zeros attach to the first
// non-zero turn at/after them; trailing zeros attach to the last turn.
func sliceTurnMessages(msgs []provider.Message, turnIdx int) []provider.Message {
	// Find first index with TurnIndex == turnIdx.
	first := -1
	for i, m := range msgs {
		if m.TurnIndex == turnIdx {
			first = i
			break
		}
	}
	if first < 0 {
		return nil
	}
	// Leading zeros: zeros immediately before `first` back to the previous
	// non-zero turn (exclusive).
	start := first
	for start > 0 && msgs[start-1].TurnIndex <= 0 {
		start--
	}
	// End: next non-zero turn that is NOT turnIdx (exclusive).
	end := len(msgs)
	for i := first; i < len(msgs); i++ {
		if msgs[i].TurnIndex > 0 && msgs[i].TurnIndex != turnIdx {
			end = i
			break
		}
	}
	return msgs[start:end]
}

// recordMeta projects a record onto its meta line.
func recordMeta(rec *SessionRecord) metaLine {
	return metaLine{
		V: storeVersion, Kind: "meta",
		Turn: rec.Turn, Todos: rec.Todos, TodosOpen: rec.TodosOpen,
		Options: rec.Options, ID: rec.ID, CWD: rec.CWD,
		Title: rec.Title, TitleSource: rec.TitleSource,
		Usage: rec.Usage, Context: rec.Context, Model: rec.Model,
		Status: rec.Status, Pinned: rec.Pinned, Jailed: rec.Jailed,
		CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt,
		Attachments: rec.Attachments, LastDate: rec.LastDate, LastMode: rec.LastMode,
		Compaction: rec.Compaction, TurnSeq: rec.TurnSeq, Queue: rec.Queue, ApprovalDeadlineUnix: rec.ApprovalDeadlineUnix,
	}
}

// discardWAL closes and removes the WAL without committing (purge path).
func closeWAL(wal **walWriter) {
	if wal != nil && *wal != nil {
		_ = (*wal).close()
		*wal = nil
	}
}

// saveSessionSync writes the record atomically (tmp + rename + fsync)
// without emitting a change ping. The WAL commit path batches its own
// single ping after the write.

// scanWALs lists session IDs with a WAL file on disk.

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
// once at commit. A nil handle means no turn is in WAL mode and the event
// is dropped (callers fall back to a direct save in that case).
func appendWALEvent(wal *walWriter, ev walEvent) error {
	if wal == nil {
		return nil
	}
	if ev.UpdatedAt == 0 {
		switch ev.Type {
		case walTypeMsg, walTypeUsage, walTypeCompaction, walTypeTodos,
			walTypeQueue, walTypeTitle, walTypeModel, walTypeOptions,
			walTypeTurnState, walTypeMeta, walTypeAttach:
			ev.UpdatedAt = time.Now().UnixMilli()
		}
	}
	if err := wal.append(ev); err != nil {
		return err
	}
	return wal.flush()
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
