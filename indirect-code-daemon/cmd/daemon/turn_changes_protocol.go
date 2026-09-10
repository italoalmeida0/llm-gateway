package main

import (
	"encoding/json"
	"path/filepath"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
)

// Snapshot-based turn changes protocol (no git):
//   - get_turn_changes  -> returns the persistent balloons of the session
//     plus, when a turn is running, the current live view under "live".
//     Incoming is daemon-internal; the frontend only reads changes.
//   - undo_turn_changes -> applies reverse patches for one balloon (or one
//     file of it). Partial failures are reported per file. The balloon is
//     never deleted.

func (d *DaemonServer) handleGetTurnChanges(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		TurnIndex *int   `json:"turnIndex,omitempty"`
	}
	if json.Unmarshal(raw, &req) != nil || filepath.Base(req.SessionID) != req.SessionID {
		return
	}
	response := map[string]any{"type": "turn_changes", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID}
	defer func() { _ = d.sendWS(response) }()

	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		response["error"] = "This conversation is no longer available on the host."
		return
	}
	act.mu.Lock()
	var balloons []map[string]any
	if act.record != nil {
		for _, b := range act.record.FileBalloons {
			if req.TurnIndex != nil && b.TurnIndex != *req.TurnIndex {
				continue
			}
			balloons = append(balloons, map[string]any{
				"turnIndex": b.TurnIndex, "at": b.At, "files": b.Files,
				"messageIndex": b.MessageIndex,
			})
		}
	}
	// Live view of the running turn, computed from the incoming snapshot.
	// Same shape as a balloon; the frontend renders it above the composer.
	// When the tracker is not in memory (fresh boot, turn not yet resumed),
	// rebuild the same view from the persisted crash journal: the frontend
	// always receives changes, never daemon-internal incoming.
	var live any
	journal, _ := d.readTurnJournal(req.SessionID)
	if act.fileChanges != nil && act.fileChanges.tracker.Count() > 0 {
		if files := previewIncoming(act.fileChanges); len(files) > 0 {
			live = map[string]any{
				"turnIndex": act.fileChanges.turnIndex,
				"files":     files,
			}
		}
	}
	if live == nil && journal != nil && len(journal.Incoming) > 0 {
		if files := filetrack.PreviewChanged(journal.Incoming, act.record.CWD); len(files) > 0 {
			live = map[string]any{
				"turnIndex": journal.TurnIndex,
				"files":     files,
			}
		}
	}
	act.mu.Unlock()
	response["balloons"] = balloons
	if live != nil {
		response["live"] = live
	}
}

func (d *DaemonServer) handleUndoTurnChanges(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		TurnIndex int    `json:"turnIndex"`
		Path      string `json:"path,omitempty"`
	}
	if json.Unmarshal(raw, &req) != nil || filepath.Base(req.SessionID) != req.SessionID {
		return
	}
	response := map[string]any{"type": "turn_changes_undone", "hostId": d.config.HostID, "sessionId": req.SessionID, "requestId": req.RequestID, "turnIndex": req.TurnIndex}
	defer func() { _ = d.sendWS(response) }()

	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		response["error"] = "This conversation is no longer available on the host."
		return
	}
	act.mu.Lock()
	running := act.record != nil && act.record.Status == "running"
	act.mu.Unlock()
	if running {
		response["error"] = "Wait for the turn to finish before undoing its changes."
		return
	}
	results, complete := d.undoTurnChanges(act, req.TurnIndex, req.Path)
	response["results"] = results
	response["complete"] = complete
	if !complete {
		response["warning"] = "Could not apply the complete undo; some files were left unchanged. See per-file results."
	}
	// Push the refreshed session (Undone flags are persisted on balloons).
	act.mu.Lock()
	payload := sessionPayload(act.record)
	act.mu.Unlock()
	_ = d.sendWS(map[string]any{"type": "session_data", "hostId": d.config.HostID, "session": payload})
}
