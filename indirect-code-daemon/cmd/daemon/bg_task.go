package main

import (
	"fmt"
	"strings"
	"time"
)

// Session-global background task log store.
//
// Logs live in the session, not in files. Each task keeps a tail buffer:
//   - live (RAM): last bgLiveCap bytes while running
//   - persisted: last bgFinalCap bytes at terminal
//
// Total/Dropped counters give bg_check stable line ranges even after the
// head was discarded ("lines X–Y of N, Z dropped above").

const (
	// bgLiveCap bounds the live RAM tail per running task.
	bgLiveCap = 100 * 1024
	// bgFinalCap bounds the persisted tail at terminal.
	bgFinalCap = 50 * 1024
)

// bgBuffer is the live RAM deque for one task: a chunk list with a byte
// budget, so appends never rebuild the whole string.
type bgBuffer struct {
	chunks []string
	bytes  int
}

func (b *bgBuffer) append(text string, capBytes int) (droppedBytes int64, droppedLines int64) {
	if text == "" {
		return 0, 0
	}
	b.chunks = append(b.chunks, text)
	b.bytes += len(text)
	for b.bytes > capBytes && len(b.chunks) > 0 {
		head := b.chunks[0]
		over := b.bytes - capBytes
		if over >= len(head) {
			b.chunks = b.chunks[1:]
			b.bytes -= len(head)
			droppedBytes += int64(len(head))
			droppedLines += int64(countLines(head))
		} else {
			// Partial head trim: drop whole lines only, so the retained
			// tail always starts at a line boundary.
			cut := strings.Index(head[over:], "\n")
			var drop string
			if cut < 0 {
				drop = head
				b.chunks = b.chunks[1:]
				b.bytes -= len(head)
			} else {
				drop = head[:over+cut+1]
				b.chunks[0] = head[over+cut+1:]
				b.bytes -= len(drop)
			}
			droppedBytes += int64(len(drop))
			droppedLines += int64(countLines(drop))
		}
	}
	return droppedBytes, droppedLines
}

func (b *bgBuffer) String() string {
	if len(b.chunks) == 0 {
		return ""
	}
	if len(b.chunks) == 1 {
		return b.chunks[0]
	}
	return strings.Join(b.chunks, "")
}

func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := strings.Count(s, "\n")
	if !strings.HasSuffix(s, "\n") {
		n++
	}
	return n
}

// findBgTask returns the task index, or -1.
func findBgTask(rec *SessionRecord, jobID string) int {
	for i := range rec.BgTasks {
		if rec.BgTasks[i].ID == jobID {
			return i
		}
	}
	return -1
}

// listBgTaskIDs renders this session's known background tasks for an
// unknown-id error, so the model can recover with the right job_id
// instead of inventing another one. Newest first, capped.
func listBgTaskIDs(rec *SessionRecord) string {
	if rec == nil || len(rec.BgTasks) == 0 {
		return " This session has no background tasks — the job_id was invented; use the exact job_id from the detached command's placeholder."
	}
	const max = 8
	var sb strings.Builder
	sb.WriteString(" This session's background tasks:")
	start := 0
	if len(rec.BgTasks) > max {
		start = len(rec.BgTasks) - max
		sb.WriteString(fmt.Sprintf(" (last %d of %d)", max, len(rec.BgTasks)))
	}
	for _, t := range rec.BgTasks[start:] {
		label := strings.TrimSpace(strings.SplitN(t.Label, "\n", 2)[0])
		if len(label) > 60 {
			label = label[:60] + "…"
		}
		fmt.Fprintf(&sb, "\n  %s [%s] %s", t.ID, t.Status, label)
	}
	sb.WriteString("\nPass one of these job_ids verbatim.")
	return sb.String()
}

// upsertBgTask registers a task (or refreshes its label/status on replay).
func upsertBgTask(rec *SessionRecord, task *BgTask) {
	cp := *task
	if i := findBgTask(rec, cp.ID); i >= 0 {
		keep := rec.BgTasks[i]
		// Replay guard: never lose content/counters to a stale register.
		if keep.TotalBytes > cp.TotalBytes {
			cp.Content = keep.Content
			cp.TotalBytes = keep.TotalBytes
			cp.TotalLines = keep.TotalLines
			cp.DroppedBytes = keep.DroppedBytes
			cp.DroppedLines = keep.DroppedLines
			cp.Seq = keep.Seq
		}
		if cp.Status == "" {
			cp.Status = keep.Status
		}
		rec.BgTasks[i] = cp
		return
	}
	rec.BgTasks = append(rec.BgTasks, cp)
}

// applyBgChunk appends output to a task, trimming the tail to capBytes.
// Unknown job IDs are ignored (fail-closed: never invent a task).
//
// Line accounting carries across chunk boundaries: the pump hands us byte
// windows that can cut a line in half ("a\nb" + "\nc" is THREE lines, not
// four). A chunk that continues a partial line adds one fewer line; the
// partial flag is derived from the retained content, so replay rebuilds
// the exact same counters.
//
// Every append bumps Seq (a per-task monotonic chunk counter): snapshots
// and live chunks share one ordering, so the client joins tail + live by
// sequence — no line arithmetic, no overlap, no gaps.
func applyBgChunk(rec *SessionRecord, jobID, text string, capBytes int) {
	i := findBgTask(rec, jobID)
	if i < 0 || text == "" {
		return
	}
	t := &rec.BgTasks[i]
	partial := t.Content != "" && !strings.HasSuffix(t.Content, "\n")
	added := int64(countLines(text))
	if partial {
		added--
	}
	t.TotalBytes += int64(len(text))
	t.TotalLines += added
	t.Seq++
	buf := &bgBuffer{chunks: splitContent(t.Content)}
	buf.bytes = len(t.Content)
	db, dl := buf.append(text, capBytes)
	t.Content = buf.String()
	t.DroppedBytes += db
	t.DroppedLines += dl
	rec.UpdatedAt = time.Now().UnixMilli()
}

// applyBgFinish marks a task terminal and trims the tail to bgFinalCap.
func applyBgFinish(rec *SessionRecord, fin *BgFinish) {
	i := findBgTask(rec, fin.JobID)
	if i < 0 {
		return
	}
	t := &rec.BgTasks[i]
	t.Status = fin.Status
	t.ExitCode = fin.ExitCode
	t.EndedAt = fin.EndedAt
	if t.EndedAt == 0 {
		t.EndedAt = time.Now().UnixMilli()
	}
	if len(t.Content) > bgFinalCap {
		buf := &bgBuffer{}
		db, dl := buf.append(t.Content, bgFinalCap)
		t.Content = buf.String()
		t.DroppedBytes += db
		t.DroppedLines += dl
	}
	rec.UpdatedAt = time.Now().UnixMilli()
}

func splitContent(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}

// bgReadPage pages a task's content by lines (1-indexed, like read).
// offset<=0 means tail: the last limit lines. Returns the page text,
// the 1-indexed from/to range over TotalLines, and whether the head
// was truncated (DroppedLines > 0 or page smaller than total).
func bgReadPage(t *BgTask, offset, limit int) (text string, from, to int64, truncated bool) {
	total := t.TotalLines
	if total == 0 {
		return "", 0, 0, t.DroppedLines > 0
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	lines := strings.Split(t.Content, "\n")
	// Drop the phantom line after a trailing newline (same as read).
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	// First retained line number (1-indexed over TotalLines).
	firstRetained := total - int64(len(lines)) + 1
	if firstRetained < 1 {
		firstRetained = 1
	}
	var start, end int // indexes into lines
	if offset <= 0 {
		// Tail: last `limit` lines of the retained tail.
		if len(lines) > limit {
			start = len(lines) - limit
		}
		end = len(lines)
	} else {
		// Absolute line numbers over TotalLines.
		lo := int64(offset)
		if lo < firstRetained {
			lo = firstRetained
		}
		hi := lo + int64(limit)
		maxLine := firstRetained + int64(len(lines))
		if hi > maxLine {
			hi = maxLine
		}
		if lo >= maxLine {
			return "", total + 1, total, true
		}
		start = int(lo - firstRetained)
		end = int(hi - firstRetained)
	}
	if start >= end {
		return "", total + 1, total, true
	}
	page := lines[start:end]
	from = firstRetained + int64(start)
	to = firstRetained + int64(end) - 1
	truncated = t.DroppedLines > 0 || firstRetained > 1
	return strings.Join(page, "\n"), from, to, truncated
}
