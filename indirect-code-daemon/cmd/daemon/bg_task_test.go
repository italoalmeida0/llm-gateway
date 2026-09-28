package main

import (
	"strings"
	"testing"
)

func testBgRec() *SessionRecord {
	return &SessionRecord{ID: "s1"}
}

func registerBg(rec *SessionRecord, id, kind, label string) {
	upsertBgTask(rec, &BgTask{ID: id, Kind: kind, Label: label, Status: BgStatusRunning, StartedAt: 1})
}

func TestBgChunkAppendAndCounters(t *testing.T) {
	rec := testBgRec()
	registerBg(rec, "bg_1", "bash", "echo hi")
	applyBgChunk(rec, "bg_1", "a\nb\nc", bgLiveCap)
	task := rec.BgTasks[0]
	if task.TotalLines != 3 || task.TotalBytes != 5 {
		t.Fatalf("counters: %+v", task)
	}
	if task.Content != "a\nb\nc" {
		t.Fatalf("content: %q", task.Content)
	}
	text, from, to, trunc := bgReadPage(&task, 0, 50)
	if text != "a\nb\nc" || from != 1 || to != 3 || trunc {
		t.Fatalf("tail page: %q %d-%d trunc=%v", text, from, to, trunc)
	}
}

func TestBgChunkTrimsHeadWithStableLines(t *testing.T) {
	rec := testBgRec()
	registerBg(rec, "bg_1", "bash", "seq")
	// 200 lines of "x\n" = 400 bytes; cap 100 keeps ~50 lines.
	applyBgChunk(rec, "bg_1", strings.Repeat("x\n", 200), 100)
	task := rec.BgTasks[0]
	if task.TotalLines != 200 {
		t.Fatalf("total must count every line: %d", task.TotalLines)
	}
	if task.DroppedLines == 0 {
		t.Fatal("head must be dropped")
	}
	if len(task.Content) > 100 {
		t.Fatalf("tail exceeds cap: %d", len(task.Content))
	}
	if strings.HasPrefix(task.Content, "x") == false {
		t.Fatalf("tail must start at a line boundary: %q", task.Content[:10])
	}
	text, from, to, trunc := bgReadPage(&task, 0, 10)
	if !trunc {
		t.Fatal("truncated must be true after head drop")
	}
	lines := strings.Split(text, "\n")
	if len(lines) != 10 {
		t.Fatalf("want 10 lines, got %d", len(lines))
	}
	// Stable numbering: last 10 of 200.
	if from != 191 || to != 200 {
		t.Fatalf("range: %d-%d, want 191-200", from, to)
	}
	// Absolute offset into dropped region clamps to first retained.
	text2, from2, _, _ := bgReadPage(&task, 1, 5)
	if from2 <= 1 {
		t.Fatalf("offset 1 must clamp past dropped head, got from=%d", from2)
	}
	_ = text2
}

func TestBgFinishTrimsToFinalCap(t *testing.T) {
	rec := testBgRec()
	registerBg(rec, "bg_1", "python", "code")
	applyBgChunk(rec, "bg_1", strings.Repeat("y\n", 50000), bgLiveCap)
	applyBgFinish(rec, &BgFinish{JobID: "bg_1", Status: BgStatusDone, ExitCode: 0, EndedAt: 9})
	task := rec.BgTasks[0]
	if task.Status != BgStatusDone || task.EndedAt != 9 {
		t.Fatalf("finish: %+v", task)
	}
	if len(task.Content) > bgFinalCap {
		t.Fatalf("final tail exceeds cap: %d", len(task.Content))
	}
	if task.TotalLines != 50000 {
		t.Fatalf("total preserved: %d", task.TotalLines)
	}
}

func TestBgChunkUnknownJobIgnored(t *testing.T) {
	rec := testBgRec()
	applyBgChunk(rec, "bg_nope", "x", bgLiveCap)
	if len(rec.BgTasks) != 0 {
		t.Fatal("must never invent a task")
	}
	applyBgFinish(rec, &BgFinish{JobID: "bg_nope", Status: BgStatusDone})
	if len(rec.BgTasks) != 0 {
		t.Fatal("must never invent a task on finish")
	}
}

func TestBgReadPageEmpty(t *testing.T) {
	rec := testBgRec()
	registerBg(rec, "bg_1", "bash", "quiet")
	text, from, to, _ := bgReadPage(&rec.BgTasks[0], 0, 50)
	if text != "" || from != 0 || to != 0 {
		t.Fatalf("empty: %q %d-%d", text, from, to)
	}
}

func TestBgWALReplayPreservesTail(t *testing.T) {
	rec := testBgRec()
	upsertBgTask(rec, &BgTask{ID: "bg_1", Kind: "bash", Label: "cmd", Status: BgStatusRunning})
	for i := 0; i < 50; i++ {
		applyBgChunk(rec, "bg_1", "line\n", bgLiveCap)
	}
	// Replay the same events onto a fresh record (crash recovery path).
	replayed := testBgRec()
	upsertBgTask(replayed, &BgTask{ID: "bg_1", Kind: "bash", Label: "cmd", Status: BgStatusRunning})
	for i := 0; i < 50; i++ {
		applyBgChunk(replayed, "bg_1", "line\n", bgLiveCap)
	}
	a, b := rec.BgTasks[0], replayed.BgTasks[0]
	if a.Content != b.Content || a.TotalLines != b.TotalLines || a.DroppedLines != b.DroppedLines {
		t.Fatalf("replay diverged:\n%+v\n%+v", a, b)
	}
}
