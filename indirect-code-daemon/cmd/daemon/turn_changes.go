package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

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
}

// beginTurnTracking creates the per-turn incoming-changes area.
// The caller must hold act.mu (runAgentTurn does at this point).
func beginTurnTracking(act *ActiveSession, cwd string, turnIndex int) *turnFileChanges {
	tfc := &turnFileChanges{
		tracker:   filetrack.NewTurnTracker(),
		turnIndex: turnIndex,
		cwd:       cwd,
	}
	act.fileChanges = tfc
	return tfc
}

// previewIncoming builds the live "changed" preview from the current
// incoming snapshot (used while the turn runs).
func previewIncoming(tfc *turnFileChanges) []filetrack.ChangedFile {
	if tfc == nil {
		return nil
	}
	return filetrack.PreviewChanged(tfc.tracker.Snapshot(), tfc.cwd)
}

// finishTurnTracking builds the final changed list, resets incoming, appends
// the persistent balloon to the session record, and returns it for broadcast.
func (d *DaemonServer) finishTurnTracking(act *ActiveSession, tfc *turnFileChanges) *filetrack.TurnChanges {
	if tfc == nil {
		return nil
	}
	files := filetrack.BuildChanged(tfc.tracker.Snapshot(), tfc.cwd)
	tfc.tracker.Reset()
	if len(files) == 0 {
		return nil
	}
	balloon := &filetrack.TurnChanges{
		TurnIndex: tfc.turnIndex,
		At:        time.Now().UnixMilli(),
		Files:     files,
	}
	act.mu.Lock()
	if act.record != nil {
		balloon.MessageIndex = len(act.record.Messages)
		act.record.FileBalloons = append(act.record.FileBalloons, *balloon)
		act.record.UpdatedAt = time.Now().UnixMilli()
		_ = d.saveSession(act.record)
	}
	act.mu.Unlock()
	return balloon
}

// broadcastFileBalloon emits the persistent per-turn balloon to the frontend.
// The frontend only knows "changes": live=true while the turn runs (the
// balloon floats above the composer), live=false once the turn finished
// (the balloon sits below its turn, persistently).
func (d *DaemonServer) broadcastFileBalloon(hostID, sessionID string, balloon *filetrack.TurnChanges) {
	if balloon == nil {
		return
	}
	_ = d.sendWS(map[string]any{
		"type":      "turn_file_changes",
		"hostId":    hostID,
		"sessionId": sessionID,
		"live":      false,
		"balloon":   balloon,
	})
}

// broadcastLiveChanges emits the live view while the turn runs: the same
// turn_file_changes event with live=true, computed from the incoming
// snapshot. Incoming is a daemon-internal detail; the frontend never sees
// it — it only reads the changes field either way.
func (d *DaemonServer) broadcastLiveChanges(hostID, sessionID string, tfc *turnFileChanges) {
	if tfc == nil || tfc.tracker.Count() == 0 {
		return
	}
	_ = d.sendWS(map[string]any{
		"type":      "turn_file_changes",
		"hostId":    hostID,
		"sessionId": sessionID,
		"live":      true,
		"balloon": map[string]any{
			"turnIndex": tfc.turnIndex,
			"at":        time.Now().UnixMilli(),
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

func (d *DaemonServer) undoTurnChanges(act *ActiveSession, turnIndex int, onlyPath string) (results []undoFileResult, complete bool) {
	act.mu.Lock()
	var balloons []filetrack.TurnChanges
	cwd := ""
	if act.record != nil {
		balloons = append([]filetrack.TurnChanges{}, act.record.FileBalloons...)
		cwd = act.record.CWD
	}
	act.mu.Unlock()

	complete = true
	for bi := range balloons {
		if balloons[bi].TurnIndex != turnIndex {
			continue
		}
		for fi := range balloons[bi].Files {
			f := &balloons[bi].Files[fi]
			if onlyPath != "" && f.Path != onlyPath && f.Rel != onlyPath {
				continue
			}
			res := undoOneFile(cwd, f)
			results = append(results, res)
			if !res.OK {
				complete = false
				continue
			}
			// Mark undone in the persisted balloon (record only, never delete).
			act.mu.Lock()
			if act.record != nil {
				for bj := range act.record.FileBalloons {
					if act.record.FileBalloons[bj].TurnIndex != turnIndex {
						continue
					}
					for fj := range act.record.FileBalloons[bj].Files {
						if act.record.FileBalloons[bj].Files[fj].Path == f.Path {
							act.record.FileBalloons[bj].Files[fj].Undone = true
						}
					}
				}
				act.record.UpdatedAt = time.Now().UnixMilli()
				_ = d.saveSession(act.record)
			}
			act.mu.Unlock()
		}
	}
	return results, complete
}

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
