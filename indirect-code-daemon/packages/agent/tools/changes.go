package tools

// maxSnapshotBytes mirrors filetrack.MaxSnapshotBytes (2MB). Snapshot
// content beyond this is not stored; the file is only listed.
const maxSnapshotBytes = 2 << 20

func cappedSnapshot(data []byte) (string, bool) {
	if len(data) > maxSnapshotBytes {
		return "", true
	}
	return string(data), false
}

// ChangeTracker is the per-turn file snapshot area (incoming changes).
// Tools call it with first-sighting snapshots; nil disables tracking.
// Implemented by filetrack.TurnTracker; kept as an interface here so the
// tools package does not import daemon-level packages.
type ChangeTracker interface {
	NoteRead(absPath, content string)
	NoteWrite(absPath string, existed bool, oldContent string)
	NoteEditBefore(absPath, beforeContent string)
	NoteBinaryNew(absPath string)
}

// IsBrainPath reports whether abs lives under the per-session private
// workspace (brainDir). Scratch-space files are never user-facing
// changes, so tools skip change tracking for them. Empty brainDir never
// matches.
func IsBrainPath(brainDir, abs string) bool {
	if brainDir == "" || abs == "" {
		return false
	}
	target, err := canonicalOrParent(abs)
	if err != nil {
		return false
	}
	brain, err := canonicalOrParent(brainDir)
	if err != nil {
		return false
	}
	return isUnder(brain, target)
}
