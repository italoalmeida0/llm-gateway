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

// mutateQueue runs fn against the live record when the session is in
// memory, else against a fused disk load. In WAL mode (running turn)
// the mutation goes to memory + WAL append; idle sessions save
// directly. Returns the updated record (nil when not found).
func (d *DaemonServer) mutateQueue(sessionID string, fn func(rec *SessionRecord) bool) *SessionRecord {
	d.sessionsMu.RLock()
	act := d.sessions[sessionID]
	d.sessionsMu.RUnlock()
	if act != nil {
		act.mu.Lock()
		defer act.mu.Unlock()
		if !fn(act.record) {
			return nil
		}
		act.record.UpdatedAt = time.Now().UnixMilli()
		if act.record.Status == "running" && act.wal != nil {
			d.appendWALEvent(act, walEvent{Type: walTypeQueue, Queue: append([]QueuedMessage{}, act.record.Queue...)})
		} else {
			_ = d.saveSession(act.record)
		}
		touchSession(act)
		return act.record
	}
	rec, _, err := d.loadSessionFused(sessionID)
	if err != nil {
		return nil
	}
	if !fn(rec) {
		return nil
	}
	rec.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(rec)
	return rec
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
	req.Text = core.SanitizeUserText(req.Text)
	if len(req.AttachmentIDs) == 0 {
		req.AttachmentIDs = nil
	}
	item := QueuedMessage{
		ID: randomQueueID(), Text: req.Text, AttachmentIDs: req.AttachmentIDs,
		Model: req.Model, YOLO: req.YOLO, CreatedAt: time.Now().UnixMilli(),
	}
	// Validate against the fused record (frozen JSON + WAL replay).
	fused, _, ferr := d.loadSessionFused(req.SessionID)
	if ferr != nil {
		return
	}
	if err := validateAttachmentIDs(fused, req.AttachmentIDs); err != nil {
		d.attachmentError("", req.SessionID, err.Error())
		return
	}
	if len(fused.Queue) >= maxQueueItems {
		d.attachmentError("", req.SessionID, fmt.Sprintf("Queue is full (max %d messages)", maxQueueItems))
		return
	}
	rec := d.mutateQueue(req.SessionID, func(r *SessionRecord) bool {
		r.Queue = append(r.Queue, item)
		return true
	})
	if rec == nil {
		return
	}
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
	req.Text = core.SanitizeUserText(req.Text)
	if len(req.AttachmentIDs) == 0 {
		req.AttachmentIDs = nil
	}
	fused, _, err := d.loadSessionFused(req.SessionID)
	if err != nil {
		return
	}
	if err := validateAttachmentIDs(fused, req.AttachmentIDs); err != nil {
		d.attachmentError("", req.SessionID, err.Error())
		return
	}
	rec := d.mutateQueue(req.SessionID, func(r *SessionRecord) bool {
		found := false
		for i, q := range r.Queue {
			if q.ID != req.QueueID {
				continue
			}
			r.Queue[i].Text = req.Text
			r.Queue[i].AttachmentIDs = req.AttachmentIDs
			found = true
			break
		}
		return found
	})
	if rec == nil {
		return
	}
	d.broadcastQueue(rec)
}

func (d *DaemonServer) handleQueueRemove(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		QueueID   string `json:"queueId"`
	}
	_ = json.Unmarshal(raw, &req)
	rec := d.mutateQueue(req.SessionID, func(r *SessionRecord) bool {
		kept := r.Queue[:0]
		for _, q := range r.Queue {
			if q.ID != req.QueueID {
				kept = append(kept, q)
			}
		}
		if len(kept) == len(r.Queue) {
			return false
		}
		if len(kept) == 0 {
			r.Queue = nil
		} else {
			r.Queue = kept
		}
		return true
	})
	if rec == nil {
		return
	}
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
	rec := d.mutateQueue(req.SessionID, func(r *SessionRecord) bool {
		idx := -1
		for i, q := range r.Queue {
			if q.ID == req.QueueID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return false
		}
		item := r.Queue[idx]
		rest := append([]QueuedMessage(nil), r.Queue[:idx]...)
		rest = append(rest, r.Queue[idx+1:]...)
		r.Queue = append([]QueuedMessage{item}, rest...)
		return true
	})
	if rec == nil {
		return
	}
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
	fused, _, err := d.loadSessionFused(sessionID)
	if err != nil || len(fused.Queue) == 0 {
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
	} else if fused.Status == "running" {
		return
	}
	var head QueuedMessage
	rec := d.mutateQueue(sessionID, func(r *SessionRecord) bool {
		h, ok := shiftQueue(r)
		if !ok {
			return false
		}
		head = h
		return true
	})
	if rec == nil {
		return
	}
	d.broadcastQueue(rec)
	d.startPrompt(sessionID, head.Text, head.AttachmentIDs, head.Model, head.YOLO, nil)
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
