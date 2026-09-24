package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
)

// Turn file-change tracking: snapshot-based, no git. One TurnTracker per
// turn (the "incoming changes" area); at end of turn the snapshots are
// compared with the disk state to build the persistent balloon ("changed").

// turnFileChanges is stored on ActiveSession while a turn runs.
type turnFileChanges struct {
	tracker   *filetrack.TurnTracker
	turnIndex int
	cwd       string
	// brainDir is the per-session private workspace: scratch-space files
	// are never user-facing changes, so preview/finish filter them out.
	// This is defense-in-depth on top of the tools skipping brain paths
	// at tracking time.
	brainDir string
}

// beginTurnTracking creates the per-turn incoming-changes area.
// v2: no session binding — the worker owns the tfc for the turn.
func beginTurnTracking(cwd string, turnIndex int, brainDir string) *turnFileChanges {
	return &turnFileChanges{
		tracker:   filetrack.NewTurnTracker(),
		turnIndex: turnIndex,
		cwd:       cwd,
		brainDir:  brainDir,
	}
}

// dropBrainTracked removes tracked paths living under the per-session
// private workspace. Tools already skip brain paths at tracking time;
// this is defense-in-depth for snapshots taken before the skip
// existed (or restored from disk). Empty brainDir never matches.
func dropBrainTracked(in []filetrack.TrackedFile, brainDir string) []filetrack.TrackedFile {
	if brainDir == "" || len(in) == 0 {
		return in
	}
	out := in[:0]
	for _, tf := range in {
		if tools.IsBrainPath(brainDir, tf.Path) {
			continue
		}
		out = append(out, tf)
	}
	// Zero the tail so retained backing-array elements don't pin content.
	for i := len(out); i < len(in); i++ {
		in[i] = filetrack.TrackedFile{}
	}
	return out
}

// stripBrainBalloonFiles drops balloon files living under the per-session
// private workspace and removes balloons left empty. Old sessions may
// persist brain files from before tools skipped them; the brain is
// session memory, never user-facing file changes.
func stripBrainBalloonFiles(in []filetrack.TurnChanges, brainDir string) []filetrack.TurnChanges {
	if brainDir == "" || len(in) == 0 {
		return in
	}
	out := make([]filetrack.TurnChanges, 0, len(in))
	for _, b := range in {
		kept := make([]filetrack.ChangedFile, 0, len(b.Files))
		for _, f := range b.Files {
			if tools.IsBrainPath(brainDir, f.Path) {
				continue
			}
			kept = append(kept, f)
		}
		if len(kept) == 0 {
			continue
		}
		b.Files = kept
		out = append(out, b)
	}
	return out
}

// previewIncoming builds the live "changed" preview from the current
// incoming snapshot (used while the turn runs).
func previewIncoming(tfc *turnFileChanges) []filetrack.ChangedFile {
	if tfc == nil {
		return nil
	}
	return filetrack.PreviewChanged(dropBrainTracked(tfc.tracker.Snapshot(), tfc.brainDir), tfc.cwd)
}

// finishTurnTracking builds the final changed list and resets incoming.
// v2: the caller (turn worker) appends the balloon to the record via the
// actor mailbox; this helper only computes it. messageIndex is supplied by
// the caller (len(rec.Messages) at finish time).
func finishTurnTracking(tfc *turnFileChanges, messageIndex int) *filetrack.TurnChanges {
	if tfc == nil {
		return nil
	}
	files := filetrack.BuildChanged(dropBrainTracked(tfc.tracker.Snapshot(), tfc.brainDir), tfc.cwd)
	tfc.tracker.Reset()
	if len(files) == 0 {
		return nil
	}
	return &filetrack.TurnChanges{
		TurnIndex:    tfc.turnIndex,
		At:           time.Now().UnixMilli(),
		Files:        files,
		MessageIndex: messageIndex,
	}
}

// broadcastFileBalloon emits the persistent per-turn balloon to the frontend.
// The frontend only knows "changes": live=true while the turn runs (the
// balloon floats above the composer), live=false once the turn finished
// (the balloon sits below its turn, persistently).
func broadcastFileBalloon(emit func(any), hostID, sessionID string, balloon *filetrack.TurnChanges) {
	if balloon == nil || emit == nil {
		return
	}
	emit(map[string]any{
		"type":      "turn_file_changes",
		"hostId":    hostID,
		"sessionId": sessionID,
		"live":      false,
		"balloon":   fileBalloonPayload(*balloon),
	})
}

// broadcastLiveChanges emits the live view while the turn runs: the same
// turn_file_changes event with live=true, computed from the incoming
// snapshot. Incoming is a daemon-internal detail; the frontend never sees
// it — it only reads the changes field either way.
func broadcastLiveChanges(emit func(any), hostID, sessionID string, tfc *turnFileChanges) {
	if tfc == nil || tfc.tracker.Count() == 0 || emit == nil {
		return
	}
	emit(map[string]any{
		"type":      "turn_file_changes",
		"hostId":    hostID,
		"sessionId": sessionID,
		"live":      true,
		"balloon": map[string]any{
			"turnIndex": tfc.turnIndex,
			"files":     previewIncoming(tfc),
		},
	})
}

// undoTurnChanges applies reverse patches for one balloon (or a single file
// of it). Returns per-file results; partial failures are reported, never
// silent. The balloon itself is never deleted.
type undoFileResult struct {
	Path    string `json:"path"`
	Rel     string `json:"rel"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

// undoTurnChanges is re-wired in V2.3 (WS command path).


func undoOneFile(cwd string, f *filetrack.ChangedFile) undoFileResult {
	res := undoFileResult{Path: f.Path, Rel: f.Rel, OK: true}
	switch f.Status {
	case "new":
		// New file: remove it only if the current content still matches what
		// the turn left behind (never delete user changes made afterwards).
		data, err := os.ReadFile(f.Path)
		if err != nil {
			if os.IsNotExist(err) {
				res.Message = "already gone"
				return res
			}
			res.OK = false
			res.Message = fmt.Sprintf("read failed: %s", err)
			return res
		}
		if string(data) != f.After {
			res.OK = false
			res.Message = "file changed after the turn; not removed"
			return res
		}
		if err := os.Remove(f.Path); err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("remove failed: %s", err)
			return res
		}
		res.Message = "removed"
		return res
	case "deleted":
		// Restore the snapshot content (parent dirs may be gone too).
		if err := os.MkdirAll(filepath.Dir(f.Path), 0o755); err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("mkdir failed: %s", err)
			return res
		}
		if err := os.WriteFile(f.Path, []byte(f.Before), 0o644); err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("write failed: %s", err)
			return res
		}
		res.Message = "restored"
		return res
	case "modified":
		if f.ReversePatch == "" {
			res.OK = false
			res.Message = "no reverse patch stored"
			return res
		}
		data, err := os.ReadFile(f.Path)
		if err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("read failed: %s", err)
			return res
		}
		restored, applied, err := filetrack.ApplyReversePatch(f.ReversePatch, string(data))
		if err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("patch failed: %s", err)
			return res
		}
		failed := 0
		for _, ok := range applied {
			if !ok {
				failed++
			}
		}
		if failed > 0 {
			res.OK = false
			res.Message = fmt.Sprintf("could not apply the complete undo (%d of %d hunks applied); file left unchanged", len(applied)-failed, len(applied))
			return res
		}
		if err := os.WriteFile(f.Path, []byte(restored), 0o644); err != nil {
			res.OK = false
			res.Message = fmt.Sprintf("write failed: %s", err)
			return res
		}
		res.Message = "restored"
		return res
	default:
		res.OK = false
		res.Message = fmt.Sprintf("status %q cannot be undone", f.Status)
		return res
	}
}

// Disk uses historical snake_case keys; all foreground surfaces use camelCase.
// "at" is disk-only (ordering/forensics); the wire omits it — no surface reads it.
func fileBalloonPayload(b filetrack.TurnChanges) map[string]any {
	return map[string]any{"turnIndex": b.TurnIndex, "files": b.Files, "messageIndex": b.MessageIndex}
}
// lastBalloon returns the finished turn's balloon (the one finishTurn just
// appended), or nil when the turn touched no files.
func lastBalloon(rec *SessionRecord) *filetrack.TurnChanges {
	if rec == nil || len(rec.FileBalloons) == 0 {
		return nil
	}
	b := rec.FileBalloons[len(rec.FileBalloons)-1]
	return &b
}

func fileBalloonPayloads(balloons []filetrack.TurnChanges) []map[string]any {
	out := make([]map[string]any, 0, len(balloons))
	for _, b := range balloons {
		out = append(out, fileBalloonPayload(b))
	}
	return out
}
