package main

import (
	"llm-gateway/indirect-code-daemon/packages/filetrack"
)

// undoTurnBalloon runs undo over one balloon (actor-local; marks undone in
// the passed balloon copy — the actor persists via saveOrAppend).
func undoTurnBalloon(cwd string, b *filetrack.TurnChanges, onlyPath string) ([]undoFileResult, bool) {
	complete := true
	var results []undoFileResult
	for fi := range b.Files {
		f := &b.Files[fi]
		if onlyPath != "" && f.Path != onlyPath && f.Rel != onlyPath {
			continue
		}
		res := undoOneFile(cwd, f)
		results = append(results, res)
		if !res.OK {
			complete = false
		}
	}
	return results, complete
}

// dropBalloonsAbove keeps balloons anchored at/below keep (message index).
func dropBalloonsAbove(in []filetrack.TurnChanges, keep int) []filetrack.TurnChanges {
	if len(in) == 0 {
		return in
	}
	out := make([]filetrack.TurnChanges, 0, len(in))
	for _, b := range in {
		if b.MessageIndex > keep {
			continue
		}
		out = append(out, b)
	}
	return out
}
