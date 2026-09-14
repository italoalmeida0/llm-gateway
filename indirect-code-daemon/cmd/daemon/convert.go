package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"time"
)

// Browser-assisted file conversion: when the read tool hits a file it cannot
// parse natively (PDF, docx, odt, epub, rtf, rst, ipynb), the daemon asks a
// connected browser to convert it with the same pipeline used for attachments
// (pdf2md / pandoc.wasm in web/src/office.ts). No browser (or no answer in
// time) falls back to the plain binary error — the turn never hangs.
//
// The handshake mirrors question.go: one pending request per session, the
// first valid response wins, stale replies cannot answer a later request.

const convertTimeout = 60 * time.Second

type pendingConvert struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	result   chan convertResult
}

type convertResult struct {
	Text string
	Err  string
}

func (d *DaemonServer) requestFileConvert(ctx context.Context, act *ActiveSession, gen int, hostID, filename, b64data string) (string, error) {
	pending := &pendingConvert{ID: fmt.Sprintf("%x", randomConvertID()), Filename: filename, result: make(chan convertResult, 1)}
	act.mu.Lock()
	if act.gen != gen || ctx.Err() != nil {
		act.mu.Unlock()
		return "", context.Canceled
	}
	act.convert = pending
	sessionID := act.record.ID
	_ = d.sendWS(map[string]any{"type": "convert_request", "hostId": hostID, "sessionId": sessionID, "requestId": pending.ID, "filename": filename, "data": b64data})
	act.mu.Unlock()
	defer func() {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.convert == pending {
			act.convert = nil
			_ = d.sendWS(map[string]any{"type": "convert_resolved", "hostId": hostID, "sessionId": sessionID, "requestId": pending.ID})
		}
	}()
	timer := time.NewTimer(convertTimeout)
	defer timer.Stop()
	select {
	case res := <-pending.result:
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if res.Err != "" {
			return "", fmt.Errorf("%s", res.Err)
		}
		return res.Text, nil
	case <-timer.C:
		return "", fmt.Errorf("no browser available for conversion")
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func randomConvertID() []byte {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		panic(err)
	}
	return id
}

// Called by the command dispatcher. The first valid response wins; stale
// replies cannot answer a later conversion or a different turn.
func (d *DaemonServer) answerFileConvert(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		Text      string `json:"text"`
		Error     string `json:"error"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	d.sessionsMu.RLock()
	act := d.sessions[req.SessionID]
	d.sessionsMu.RUnlock()
	if act == nil {
		return
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	pending := act.convert
	if pending == nil || pending.ID != req.RequestID {
		return
	}
	select {
	case pending.result <- convertResult{Text: req.Text, Err: req.Error}:
		act.convert = nil
		_ = d.sendWS(map[string]any{"type": "convert_resolved", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": pending.ID})
	default:
	}
}
