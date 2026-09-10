package filetrack

import (
	"fmt"
	"sort"
	"strings"

	"github.com/sergi/go-diff/diffmatchpatch"
)

// ChangedFile is one entry of the per-turn balloon (the "changed" view).
// It is persisted in the session record, so balloons survive restarts.
type ChangedFile struct {
	// Path is the absolute, cleaned path.
	Path string `json:"path"`
	// Rel is the workspace-relative display path.
	Rel string `json:"rel"`
	// Status is one of: new | modified | deleted | binary | too_large.
	Status string `json:"status"`
	// Diff is the unified -/+ text for the UI. Empty for binary/too_large.
	Diff string `json:"diff,omitempty"`
	// Additions/Deletions count diff lines (not hunks).
	Additions int `json:"additions"`
	Deletions  int `json:"deletions"`
	// Before is the snapshot content (undo source). Empty for new files.
	Before string `json:"before,omitempty"`
	// After is the content at end of turn (verification for undo of new files).
	After string `json:"after,omitempty"`
	// ReversePatch is the diff-match-patch text that maps After -> Before.
	// Applied to the current disk content on undo (fuzzy, may partially fail).
	ReversePatch string `json:"reverse_patch,omitempty"`
	// Undone is set once an undo has been applied for this file.
	Undone bool `json:"undone,omitempty"`
}

// TurnChanges is the persistent balloon of one finished turn.
type TurnChanges struct {
	TurnIndex int           `json:"turn_index"`
	At        int64         `json:"at"`
	Files     []ChangedFile `json:"files"`
	// MessageIndex is len(messages) when the turn finished: the balloon
	// renders right after that message. Clamped by the frontend when the
	// transcript was truncated/edited afterwards.
	MessageIndex int `json:"message_index,omitempty"`
}

// dmp is shared; diffmatchpatch has no mutable global state per instance use.
func newDMP() *diffmatchpatch.DiffMatchPatch {
	return diffmatchpatch.New()
}

// UnifiedDiff renders a unified-style -/+ diff with 3 lines of context,
// using sergi/go-diff for the underlying diff computation.
//
// The diff runs in LINE mode (DiffLinesToChars): a mid-line edit renders
// as a full old-line del row plus a full new-line add row, like git.
// Char mode would instead split the changed line into fragment rows
// ("+ word,") that look like independent lines and corrupt hunk headers.
func UnifiedDiff(path, before, after string) (diff string, additions, deletions int) {
	dmp := newDMP()
	chars1, chars2, lineArray := dmp.DiffLinesToChars(before, after)
	diffs := dmp.DiffMain(chars1, chars2, false)
	// No DiffCleanupSemantic here: in line mode every line is a single
	// encoded char, so the semantic pass mistakes real common lines for
	// "trivial equalities" and merges them into the edit. DiffMain on
	// line symbols is already exact.
	diffs = dmp.DiffCharsToLines(diffs, lineArray)
	return unifiedFromDiffs(path, diffs)
}

// unifiedFromDiffs converts char-level diffs into a line-oriented unified diff.
func unifiedFromDiffs(path string, diffs []diffmatchpatch.Diff) (string, int, int) {
	type line struct {
		kind int // -1 del, 0 ctx, +1 add
		text string
	}
	var lines []line
	for _, d := range diffs {
		parts := strings.Split(d.Text, "\n")
		for i, p := range parts {
			if i == len(parts)-1 && p == "" {
				continue // trailing split artifact, not a real line
			}
			switch d.Type {
			case diffmatchpatch.DiffDelete:
				lines = append(lines, line{-1, p})
			case diffmatchpatch.DiffInsert:
				lines = append(lines, line{1, p})
			default:
				lines = append(lines, line{0, p})
			}
		}
		if !strings.HasSuffix(d.Text, "\n") {
			// The split above already handled the last partial line.
		}
	}
	// Mark changed regions with 3 lines of context.
	const ctx = 3
	keep := make([]bool, len(lines))
	for i, l := range lines {
		if l.kind == 0 {
			continue
		}
		for d := -ctx; d <= ctx; d++ {
			if j := i + d; j >= 0 && j < len(lines) {
				keep[j] = true
			}
		}
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "--- %s\n+++ %s\n", path, path)
	additions, deletions := 0, 0
	// Line numbers for hunk headers.
	oldLine, newLine := 1, 1
	i := 0
	for i < len(lines) {
		if !keep[i] {
			if lines[i].kind == -1 {
				oldLine++
			} else if lines[i].kind == 1 {
				newLine++
			} else {
				oldLine++
				newLine++
			}
			i++
			continue
		}
		// Start a hunk.
		j := i
		for j < len(lines) && keep[j] {
			j++
		}
		hunk := lines[i:j]
		oldCount, newCount := 0, 0
		for _, l := range hunk {
			if l.kind <= 0 {
				oldCount++
			}
			if l.kind >= 0 {
				newCount++
			}
		}
		fmt.Fprintf(&sb, "@@ -%d,%d +%d,%d @@\n", oldLine, oldCount, newLine, newCount)
		for _, l := range hunk {
			switch l.kind {
			case -1:
				sb.WriteString("-" + l.text + "\n")
				deletions++
				oldLine++
			case 1:
				sb.WriteString("+" + l.text + "\n")
				additions++
				newLine++
			default:
				sb.WriteString(" " + l.text + "\n")
				oldLine++
				newLine++
			}
		}
		i = j
	}
	return sb.String(), additions, deletions
}

// MakeReversePatch builds the diff-match-patch text mapping after -> before,
// used by undo. Empty when both sides are equal.
func MakeReversePatch(after, before string) string {
	if after == before {
		return ""
	}
	dmp := newDMP()
	return dmp.PatchToText(dmp.PatchMake(after, before))
}

// ApplyReversePatch applies a reverse patch to the current content.
// Returns the restored text and per-hunk applied flags.
func ApplyReversePatch(reversePatch, current string) (string, []bool, error) {
	dmp := newDMP()
	patches, err := dmp.PatchFromText(reversePatch)
	if err != nil {
		return "", nil, err
	}
	out, applied := dmp.PatchApply(patches, current)
	return out, applied, nil
}

// currentState describes what is on disk right now for a tracked path.
type currentState struct {
	exists   bool
	binary    bool
	tooLarge  bool
	content   string
}

func statCurrent(absPath string) currentState {
	data, err := readFileBytes(absPath)
	if err != nil {
		return currentState{}
	}
	if isBinaryBytes(data) {
		return currentState{exists: true, binary: true}
	}
	capped, tooLarge := CapContent(string(data))
	if tooLarge {
		return currentState{exists: true, tooLarge: true}
	}
	return currentState{exists: true, content: capped}
}

// BuildChanged compares first-seen snapshots with the current disk state and
// produces the final "changed" list for the balloon:
//   - not on disk anymore and never had a snapshot -> skipped (created then
//     deleted within the turn).
//   - not on disk anymore but had a snapshot -> deleted.
//   - on disk, marked new -> new (full content as + diff when textual).
//   - on disk, binary/too_large -> listed without textual diff.
//   - on disk, textual, identical to snapshot -> skipped (merely read).
//   - on disk, textual, different -> modified with unified diff + reverse
//     patch for undo.
func BuildChanged(tracked []TrackedFile, cwd string) []ChangedFile {
	out := []ChangedFile{}
	for _, tf := range tracked {
		rel := tf.Path
		if r, err := filepathRel(cwd, tf.Path); err == nil {
			rel = r
		}
		cur := statCurrent(tf.Path)
		if !cur.exists {
			if !tf.HasBefore {
				continue
			}
			diff, _, dels := UnifiedDiff(rel, tf.Before, "")
			out = append(out, ChangedFile{
				Path: tf.Path, Rel: rel, Status: "deleted",
				Diff: diff, Deletions: dels,
				Before: tf.Before,
			})
			continue
		}
		if !tf.HasBefore {
			if cur.binary || cur.tooLarge {
				status := "binary"
				if cur.tooLarge {
					status = "too_large"
				}
				out = append(out, ChangedFile{Path: tf.Path, Rel: rel, Status: status})
				continue
			}
			diff, adds, _ := UnifiedDiff(rel, "", cur.content)
			out = append(out, ChangedFile{
				Path: tf.Path, Rel: rel, Status: "new",
				Diff: diff, Additions: adds,
				After: cur.content,
			})
			continue
		}
		if cur.binary || cur.tooLarge {
			status := "binary"
			if cur.tooLarge {
				status = "too_large"
			}
			out = append(out, ChangedFile{
				Path: tf.Path, Rel: rel, Status: status,
				Before: tf.Before,
			})
			continue
		}
		if cur.content == tf.Before {
			continue
		}
		diff, adds, dels := UnifiedDiff(rel, tf.Before, cur.content)
		out = append(out, ChangedFile{
			Path: tf.Path, Rel: rel, Status: "modified",
			Diff: diff, Additions: adds, Deletions: dels,
			Before: tf.Before, After: cur.content,
			ReversePatch: MakeReversePatch(cur.content, tf.Before),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// PreviewChanged is BuildChanged over a live snapshot (used for the
// incoming-changes preview while the turn runs).
func PreviewChanged(snapshot []TrackedFile, cwd string) []ChangedFile {
	return BuildChanged(snapshot, cwd)
}
