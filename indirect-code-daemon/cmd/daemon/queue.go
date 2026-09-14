package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
)

// Message queue: while a turn is running, new user messages wait here
// instead of being refused. When a turn completes normally, the queue head
// is promoted to a new turn automatically. A cancelled turn never drains
// the queue. Queue items persist in the session file like everything else.

const maxQueueItems = 30

// QueuedMessage is one waiting user message with its turn options.
type QueuedMessage struct {
	ID            string   `json:"id"`
	Text          string   `json:"text"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
	Model         string   `json:"model,omitempty"`
	YOLO          bool     `json:"yolo,omitempty"`
	CreatedAt     int64    `json:"createdAt"`
}

func randomQueueID() string {
	id := make([]byte, 8)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", id)
}

func queuePayload(queue []QueuedMessage) []any {
	out := make([]any, 0, len(queue))
	for _, q := range queue {
		out = append(out, map[string]any{
			"id": q.ID, "text": q.Text, "attachmentIds": q.AttachmentIDs,
			"model": q.Model, "yolo": q.YOLO, "createdAt": q.CreatedAt,
		})
	}
	return out
}

func (d *DaemonServer) broadcastQueue(rec *SessionRecord) {
	_ = d.sendWS(map[string]any{
		"type": "session_queue", "hostId": d.config.HostID,
		"sessionId": rec.ID, "queue": queuePayload(rec.Queue),
	})
}

func (d *DaemonServer) handleQueueAdd(raw []byte) {
	var req struct {
		SessionID     string   `json:"sessionId"`
		Text          string   `json:"text"`
		AttachmentIDs []string `json:"attachmentIds"`
		Model         string   `json:"model"`
		YOLO          bool     `json:"yolo"`
	}
	_ = json.Unmarshal(raw, &req)
	rec, err := d.loadSession(req.SessionID)
	if err != nil {
		return
	}
	req.Text = core.SanitizeUserText(req.Text)
	if err := validateAttachmentIDs(rec, req.AttachmentIDs); err != nil {
		d.attachmentError("", req.SessionID, err.Error())
		return
	}
	if len(rec.Queue) >= maxQueueItems {
		d.attachmentError("", req.SessionID, fmt.Sprintf("Queue is full (max %d messages)", maxQueueItems))
		return
	}
	if len(req.AttachmentIDs) == 0 {
		req.AttachmentIDs = nil
	}
	rec.Queue = append(rec.Queue, QueuedMessage{
		ID: randomQueueID(), Text: req.Text, AttachmentIDs: req.AttachmentIDs,
		Model: req.Model, YOLO: req.YOLO, CreatedAt: time.Now().UnixMilli(),
	})
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	d.syncActiveRecord(rec)
	d.broadcastQueue(rec)
}

func (d *DaemonServer) handleQueueUpdate(raw []byte) {
	var req struct {
		SessionID     string   `json:"sessionId"`
		QueueID       string   `json:"queueId"`
		Text          string   `json:"text"`
		AttachmentIDs []string `json:"attachmentIds"`
	}
	_ = json.Unmarshal(raw, &req)
	rec, err := d.loadSession(req.SessionID)
	if err != nil {
		return
	}
	req.Text = core.SanitizeUserText(req.Text)
	if err := validateAttachmentIDs(rec, req.AttachmentIDs); err != nil {
		d.attachmentError("", req.SessionID, err.Error())
		return
	}
	if len(req.AttachmentIDs) == 0 {
		req.AttachmentIDs = nil
	}
	found := false
	for i, q := range rec.Queue {
		if q.ID != req.QueueID {
			continue
		}
		rec.Queue[i].Text = req.Text
		rec.Queue[i].AttachmentIDs = req.AttachmentIDs
		found = true
		break
	}
	if !found {
		return
	}
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	d.syncActiveRecord(rec)
	d.broadcastQueue(rec)
}

func (d *DaemonServer) handleQueueRemove(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		QueueID   string `json:"queueId"`
	}
	_ = json.Unmarshal(raw, &req)
	rec, err := d.loadSession(req.SessionID)
	if err != nil {
		return
	}
	kept := rec.Queue[:0]
	for _, q := range rec.Queue {
		if q.ID != req.QueueID {
			kept = append(kept, q)
		}
	}
	if len(kept) == len(rec.Queue) {
		return
	}
	if len(kept) == 0 {
		rec.Queue = nil
	} else {
		rec.Queue = kept
	}
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	d.syncActiveRecord(rec)
	d.broadcastQueue(rec)
}

// handleQueueSendNow cancels the running turn (if any) and promotes the
// queued item next. With no turn running it starts immediately. The item
// is moved to the queue head and a send-now flag is set: the turn
// finalizer — the single running→idle transition — promotes the head
// after cancelling, so there is no race with "Turn already in flight".
func (d *DaemonServer) handleQueueSendNow(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		QueueID   string `json:"queueId"`
	}
	_ = json.Unmarshal(raw, &req)
	rec, err := d.loadSession(req.SessionID)
	if err != nil {
		return
	}
	idx := -1
	for i, q := range rec.Queue {
		if q.ID == req.QueueID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}
	item := rec.Queue[idx]
	rest := append([]QueuedMessage(nil), rec.Queue[:idx]...)
	rest = append(rest, rec.Queue[idx+1:]...)
	rec.Queue = append([]QueuedMessage{item}, rest...)
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	d.syncActiveRecord(rec)
	d.broadcastQueue(rec)
	if !d.sessionRunning(req.SessionID) {
		d.promoteQueueHead(req.SessionID)
		return
	}
	d.sessionsMu.RLock()
	act := d.sessions[req.SessionID]
	d.sessionsMu.RUnlock()
	if act == nil {
		return
	}
	act.mu.Lock()
	act.sendNow = true
	act.mu.Unlock()
	d.cancelTurn(req.SessionID)
}

// promoteQueueHead shifts the head item and starts it as a new turn.
// No-op when the queue is empty or a turn is already running.
func (d *DaemonServer) promoteQueueHead(sessionID string) {
	rec, err := d.loadSession(sessionID)
	if err != nil || len(rec.Queue) == 0 {
		return
	}
	d.sessionsMu.RLock()
	act := d.sessions[sessionID]
	d.sessionsMu.RUnlock()
	if act != nil {
		act.mu.Lock()
		running := act.record.Status == "running"
		act.mu.Unlock()
		if running {
			return
		}
	} else if rec.Status == "running" {
		return
	}
	head, ok := shiftQueue(rec)
	if !ok {
		return
	}
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	d.syncActiveRecord(rec)
	d.broadcastQueue(rec)
	d.startPrompt(sessionID, head.Text, head.AttachmentIDs, head.Model, head.YOLO, nil)
}

// syncActiveRecord points the live session at the freshly saved record.
func (d *DaemonServer) syncActiveRecord(rec *SessionRecord) {
	d.sessionsMu.RLock()
	defer d.sessionsMu.RUnlock()
	if act, ok := d.sessions[rec.ID]; ok && act != nil {
		act.mu.Lock()
		act.record = rec
		act.mu.Unlock()
	}
}

// shiftQueue removes and returns the head item. Returns false when empty.
func shiftQueue(rec *SessionRecord) (QueuedMessage, bool) {
	if len(rec.Queue) == 0 {
		return QueuedMessage{}, false
	}
	head := rec.Queue[0]
	rec.Queue = append([]QueuedMessage(nil), rec.Queue[1:]...)
	if len(rec.Queue) == 0 {
		rec.Queue = nil
	}
	return head, true
}
