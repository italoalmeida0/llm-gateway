package main

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Attachments: upload/get/validate/prune. v2: actor-local (no locks).
// Uploads apply to the live record; running turns persist via WAL attach
// event, idle turns save directly (v1 semantics).

const (
	maxAttachmentBytes       = 4 << 20
	maxAttachmentTextRunes   = 512 * 1024
	maxAttachmentsPerMessage = 30
)

func validateAttachmentIDs(rec *SessionRecord, ids []string) error {
	if len(ids) > maxAttachmentsPerMessage {
		return fmt.Errorf("Max %d attachments per message", maxAttachmentsPerMessage)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			return fmt.Errorf("Duplicate attachment")
		}
		seen[id] = true
		found := false
		for _, a := range rec.Attachments {
			if a.ID != id {
				continue
			}
			found = true
			f, err := os.Open(a.Path)
			if err != nil {
				return fmt.Errorf("Attachment '%s' is unavailable; attach it again", a.Name)
			}
			info, err := f.Stat()
			f.Close()
			if err != nil || !info.Mode().IsRegular() || info.Size() > maxAttachmentBytes {
				return fmt.Errorf("Attachment '%s' is unavailable", a.Name)
			}
			break
		}
		if !found {
			return fmt.Errorf("Attachment does not belong to this conversation")
		}
	}
	return nil
}

// pruneOrphanAttachments drops refs (and files) no longer referenced.
func pruneOrphanAttachments(rec *SessionRecord, keepExtra []string) {
	keep := map[string]bool{}
	for _, id := range keepExtra {
		keep[id] = true
	}
	for _, m := range rec.Messages {
		for _, id := range messageAttachmentIDs(m, rec.Attachments) {
			keep[id] = true
		}
	}
	if len(keep) == len(rec.Attachments) {
		return
	}
	live := rec.Attachments[:0]
	for _, a := range rec.Attachments {
		if !keep[a.ID] {
			os.Remove(a.Path)
			if a.TextPath != "" {
				os.Remove(a.TextPath)
			}
			continue
		}
		live = append(live, a)
	}
	if len(live) == 0 {
		rec.Attachments = nil
	} else {
		rec.Attachments = live
	}
}

func (a *sessionActor) onAttachUpload(m attachUploadMsg) attachUploadResult {
	fail := func(msg string) attachUploadResult { return attachUploadResult{Error: msg} }
	if strings.TrimSpace(m.Name) == "" {
		return fail("Attachment needs a session, name and data")
	}
	if len(m.Data) > base64.StdEncoding.EncodedLen(maxAttachmentBytes) {
		return fail("Attachment too large (max 4MB)")
	}
	data, err := base64.StdEncoding.DecodeString(m.Data)
	if err != nil {
		return fail("Attachment data is not valid base64")
	}
	if len(data) > maxAttachmentBytes {
		return fail("Attachment too large (max 4MB)")
	}
	mime := strings.ToLower(strings.TrimSpace(m.Mime))
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		mime = detected
	}
	if strings.HasPrefix(mime, "image/") {
		switch mime {
		case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
		default:
			return fail("Unsupported image. Use PNG, JPEG, GIF, WebP or BMP.")
		}
		if detected != mime && mime != "image/bmp" {
			return fail("Image data does not match its format")
		}
		if len(data) > 5*1024*1024/2 {
			return fail("Image too large (max 2.5MB)")
		}
	}
	if mime == "" {
		mime = detected
	}
	// Idempotent retry: same upload twice returns the first ref.
	for _, at := range a.rec.Attachments {
		if at.UploadKey == m.Name+m.Mime {
			return attachUploadResult{Attachment: messageAttachment{at.ID, at.Name, at.Mime, at.Size}}
		}
	}
	dir := filepath.Join(a.store.sessionsDir(), a.id, "attachments")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail("Could not store attachment")
	}
	file, err := os.CreateTemp(dir, "att-*")
	if err != nil {
		return fail("Could not store attachment")
	}
	path := file.Name()
	committed := false
	textPath := ""
	defer func() {
		if !committed {
			os.Remove(path)
			if textPath != "" {
				os.Remove(textPath)
			}
		}
	}()
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fail("Could not store attachment")
	}
	if err := file.Close(); err != nil {
		return fail("Could not store attachment")
	}
	ref := AttachmentRef{ID: filepath.Base(path), UploadKey: m.Name + m.Mime, Name: filepath.Base(strings.ReplaceAll(strings.TrimSpace(m.Name), "\\", "/")), Mime: mime, Size: int64(len(data)), Path: path}
	if m.Text != "" {
		text := []rune(m.Text)
		if len(text) > maxAttachmentTextRunes {
			text = text[:maxAttachmentTextRunes]
		}
		textPath = path + "_extracted.md"
		if err := os.WriteFile(textPath, []byte(string(text)), 0o600); err != nil {
			return fail("Could not store extracted text")
		}
		ref.TextPath, ref.TextChars = textPath, len(text)
	}
	previous := a.rec.Attachments
	a.rec.Attachments = append(append([]AttachmentRef{}, previous...), ref)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	a.touch()
	if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ {
		appendWALEvent(a.wal, walEvent{Type: walTypeAttach, Attachments: append([]AttachmentRef{}, a.rec.Attachments...)})
	} else if err := a.store.saveSessionSync(a.rec); err != nil {
		a.rec.Attachments = previous
		return fail("Could not save attachment")
	}
	committed = true
	a.pingChange()
	return attachUploadResult{Attachment: messageAttachment{ref.ID, ref.Name, ref.Mime, ref.Size}}
}

// onQueueSendNow moves the item to the head and, if idle, promotes it;
// if running, cancels the turn so the finalizer path promotes it
// (v1 queue_send_now semantics).
func (a *sessionActor) onQueueSendNow(m queueSendNowMsg) {
	idx := -1
	for i, q := range a.rec.Queue {
		if q.ID == m.QueueID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	item := a.rec.Queue[idx]
	rest := append([]QueuedMessage(nil), a.rec.Queue[:idx]...)
	rest = append(rest, a.rec.Queue[idx+1:]...)
	a.rec.Queue = append([]QueuedMessage{item}, rest...)
	if err := a.saveOrAppend(walEvent{Type: walTypeQueue, Queue: a.rec.Queue}); err != nil {
		return
	}
	if a.state == stateIdle {
		head := a.rec.Queue[0]
		a.rec.Queue = a.rec.Queue[1:]
		if err := a.startTurn(head.Text, head.AttachmentIDs, head.Model, head.YOLO, nil); err != nil {
			a.rec.Queue = append([]QueuedMessage{head}, a.rec.Queue...)
		}
		return
	}
	// Running: flag send-now and cancel; the finalizer (the single
	// running→idle transition) promotes the head after cancelling, so
	// there is no race with "Turn already in flight" (v1 parity).
	a.sendNow = true
	a.doCancel("queue_send_now")
}

// onEditApply applies a saved (non-regen) edit. Runs on the actor; caller
// guarantees idle (ws_server checks state first).
func (a *sessionActor) onEditApply(m editApplyMsg) editApplyResult {
	if a.state != stateIdle || a.persistErr != nil {
		return editApplyResult{Error: "Stop the current turn before editing"}
	}
	previous := cloneRecord(a.rec)
	if m.Index < 0 || m.Index >= len(a.rec.Messages) {
		return editApplyResult{Error: "bad index"}
	}
	msg := a.rec.Messages[m.Index]
	if msg.Role != provider.RoleUser {
		return editApplyResult{Error: "only user messages can be edited"}
	}
	text := core.SanitizeUserText(m.Text)
	ids := m.AttachmentIDs
	if ids == nil {
		ids = messageAttachmentIDs(msg, a.rec.Attachments)
	}
	if err := validateAttachmentIDs(a.rec, ids); err != nil {
		return editApplyResult{Error: err.Error()}
	}
	if strings.TrimSpace(text) == "" && len(ids) == 0 {
		return editApplyResult{Error: "Message cannot be empty"}
	}
	fullText, images := buildTurnPrompt(a.rec.Attachments, text, ids, normalizedOptions(a.rec.Options).Mode)
	msg.Content = []provider.Content{provider.TextBlock{Text: fullText}}
	for _, img := range images {
		msg.Content = append(msg.Content, img)
	}
	msg.Meta = attachmentMessageMeta(text, ids, a.rec.Attachments)
	before := len(a.rec.Messages)
	a.rec.Messages[m.Index] = msg
	a.rec.Messages = append([]provider.Message(nil), a.rec.Messages[:m.Index+1]...)
	a.rec.FileBalloons = dropBalloonsAbove(a.rec.FileBalloons, m.Index+1)
	a.rec.Messages = provider.RepairOrphanedToolResults(a.rec.Messages)
	pruneOrphanAttachments(a.rec, nil)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	removed := before - len(a.rec.Messages)
	if removed < 0 {
		removed = 0
	}
	// Turn-granular persist (v1 edit_message semantics).
	firstDirty := 0
	for _, mm := range a.rec.Messages[m.Index:] {
		if mm.TurnIndex > 0 {
			firstDirty = mm.TurnIndex
			break
		}
	}
	st := a.store
	var persistErr error
	if firstDirty <= 0 {
		lines, _ := splitRecord(a.rec)
		persistErr = st.writeSessionFile(a.rec.ID, lines, recordMeta(a.rec))
	} else {
		start := len(a.rec.Messages)
		for i, mm := range a.rec.Messages {
			if mm.TurnIndex >= firstDirty {
				start = i
				break
			}
		}
		for start > 0 && a.rec.Messages[start-1].TurnIndex <= 0 {
			start--
		}
		var sbal []filetrack.TurnChanges
		for _, b := range a.rec.FileBalloons {
			if b.TurnIndex >= firstDirty {
				sbal = append(sbal, b)
			}
		}
		persistErr = st.persistEdited(a.rec.ID, firstDirty, append([]provider.Message{}, a.rec.Messages[start:]...), sbal, recordMeta(a.rec))
	}
	if persistErr != nil {
		a.rec = previous
		return editApplyResult{Error: persistErr.Error()}
	}
	a.emit(map[string]any{"type": "session_truncated", "sessionId": a.id, "keepIndex": m.Index})
	a.emit(tailContentEvent("", a.id, "session_content", a.rec, 0, nil))
	a.pingChange()
	return editApplyResult{}
}

// onCompactNow starts a compaction-only turn when idle.
func (a *sessionActor) onCompactNow() {
	if a.state != stateIdle {
		return
	}
	a.touch()
	if len(a.rec.Messages) < 4 {
		a.emit(map[string]any{"type": "notice", "sessionId": a.id, "message": "Not enough history to compact"})
		return
	}
	_ = a.startTurnWithMeta("", nil, "", map[string]string{"operation": "compact"})
}

// onSlashReply appends a deterministic user/assistant pair (a slash command
// and its canned reply) with no model call — v1 /help parity. The record
// stays single-writer: only the actor touches a.rec.
func (a *sessionActor) onSlashReply(m slashReplyMsg) {
	a.touch()
	a.rec.TurnSeq++
	turn := a.rec.TurnSeq
	userMsg := provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: m.Command}}, TurnIndex: turn}
	asstMsg := provider.Message{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: m.Reply}}, TurnIndex: turn}
	a.rec.Messages = append(a.rec.Messages, userMsg, asstMsg)
	a.rec.UpdatedAt = time.Now().UnixMilli()
	// Mirror saveOrAppend's rule (plus stateCancel, where the worker is
	// exiting but the WAL is still open): while a WAL is open the messages
	// must be journaled, never written to disk directly — a direct save
	// would race the pending commitWAL and duplicate the turn.
	if a.wal != nil {
		appendWALEvent(a.wal, walMsgEvent(userMsg))
		appendWALEvent(a.wal, walMsgEvent(asstMsg))
	} else {
		_ = a.store.saveSessionSync(a.rec)
	}
	a.pingChange()
	a.emit(tailContentEvent("", a.id, "session_content", a.rec, 0, nil))
	if m.Ack != nil {
		select {
		case m.Ack <- struct{}{}:
		default:
		}
	}
}

func jailNotice(jailed bool) string {
	if jailed {
		return "Sandbox locked for future turns."
	}
	return "Sandbox unlocked for future turns."
}

// onUndo runs undo of turn changes (actor-local disk ops).
func (a *sessionActor) onUndo(m undoMsg) undoResult {
	rec := a.rec
	if a.state != stateIdle {
		return undoResult{Error: "Stop the current turn first"}
	}
	var target *filetrack.TurnChanges
	for i := range rec.FileBalloons {
		if rec.FileBalloons[i].TurnIndex == m.TurnIndex {
			target = &rec.FileBalloons[i]
			break
		}
	}
	if target == nil {
		return undoResult{Error: "Turn has no file changes"}
	}
	results, complete := undoTurnBalloon(rec.CWD, target, m.Path)
	if err := a.store.saveSessionSync(rec); err != nil {
		a.storageError(err)
		return undoResult{Error: err.Error(), Results: undoPayloads(results)}
	}
	a.pingChange()
	return undoResult{Results: undoPayloads(results), Complete: complete}
}

func undoPayloads(results []undoFileResult) []any {
	out := make([]any, 0, len(results))
	for _, r := range results {
		out = append(out, map[string]any{"path": r.Path, "rel": r.Rel, "ok": r.OK, "message": r.Message})
	}
	return out
}
