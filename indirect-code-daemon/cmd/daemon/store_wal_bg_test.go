package main

// Regression tests for the WAL/meta projection: background task state must
// survive EVERY meta rewrite (commitWAL fast path, full commit, rewriteMetaOnly)
// and the commit fast path must only skip a rewrite when the turn line content
// actually matches (not just the message count).

import (
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func bgTestStore(t *testing.T) *diskStore {
	t.Helper()
	return newDiskStore(t.TempDir())
}

func bgTestMsg(role provider.Role, text string, turn int) provider.Message {
	return provider.Message{
		ID:        text,
		Role:      role,
		Content:   []provider.Content{provider.TextBlock{Text: text}},
		Time:      time.Unix(1700000000, 0),
		TurnIndex: turn,
	}
}

func bgTestRec(id string) *SessionRecord {
	rec := &SessionRecord{ID: id, TurnSeq: 1}
	rec.Messages = append(rec.Messages, bgTestMsg(provider.RoleUser, "hello", 1))
	return rec
}

func bgTestTask() BgTask {
	return BgTask{
		ID: "job1", Kind: "bash", Label: "build", Status: BgStatusRunning,
		Content: "partial output", TotalBytes: 14,
	}
}

// commitWAL must not drop BgTasks from the frozen meta tail.
func TestCommitWALKeepsBgTasks(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-bg-commit")
	rec.BgTasks = []BgTask{bgTestTask()}
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix()}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	rec.TurnSeq = 2
	rec.Messages = append(rec.Messages, bgTestMsg(provider.RoleAssistant, "hi", 2))
	if err := appendWALEvent(wal, walMsgEvent(rec.Messages[len(rec.Messages)-1])); err != nil {
		t.Fatal(err)
	}
	if err := s.commitWAL(rec.ID, rec, wal); err != nil {
		t.Fatal(err)
	}
	got, err := s.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.BgTasks) != 1 || got.BgTasks[0].ID != "job1" || got.BgTasks[0].Content != "partial output" {
		t.Fatalf("BgTasks lost/corrupted after commitWAL: %+v", got.BgTasks)
	}
}

// The commit fast path (turn line already on disk) must also keep BgTasks.
func TestCommitWALFastPathKeepsBgTasks(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-bg-fast")
	rec.BgTasks = []BgTask{bgTestTask()}
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// Commit twice: the second commit takes the "already present" fast path.
	for i := 0; i < 2; i++ {
		h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix()}
		wal, err := s.openWAL(rec.ID, h)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.commitWAL(rec.ID, rec, wal); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.BgTasks) != 1 {
		t.Fatalf("BgTasks lost after fast-path commit: %+v", got.BgTasks)
	}
}

// rewriteMetaOnly (meta-only changes) must keep BgTasks.
func TestRewriteMetaOnlyKeepsBgTasks(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-bg-meta")
	rec.BgTasks = []BgTask{bgTestTask()}
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	if err := s.rewriteMetaOnly(rec.ID, recordMeta(rec)); err != nil {
		t.Fatal(err)
	}
	got, err := s.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.BgTasks) != 1 {
		t.Fatalf("BgTasks lost after rewriteMetaOnly: %+v", got.BgTasks)
	}
}

// The commit fast path must NOT skip the message rewrite when the turn line on
// disk has the same message COUNT but different content (regenerate/edit re-run
// of the same turn number).
func TestCommitWALRewritesOnSameCountDifferentContent(t *testing.T) {
	s := bgTestStore(t)
	rec := bgTestRec("sess-bg-content")
	if err := s.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// First commit writes turn 1 with "hello".
	h := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix()}
	wal, err := s.openWAL(rec.ID, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.commitWAL(rec.ID, rec, wal); err != nil {
		t.Fatal(err)
	}
	// Re-run of turn 1: same count (1 message), different content.
	rec2 := &SessionRecord{ID: rec.ID, TurnSeq: 1}
	rec2.Messages = append(rec2.Messages, bgTestMsg(provider.RoleUser, "CHANGED", 1))
	h2 := &walHeader{TurnIndex: 1, StartedAt: time.Now().Unix()}
	wal2, err := s.openWAL(rec.ID, h2)
	if err != nil {
		t.Fatal(err)
	}
	if err := appendWALEvent(wal2, walMsgEvent(rec2.Messages[0])); err != nil {
		t.Fatal(err)
	}
	if err := s.commitWAL(rec.ID, rec2, wal2); err != nil {
		t.Fatal(err)
	}
	got, err := s.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != 1 {
		t.Fatalf("message count changed: %d", len(got.Messages))
	}
	if got.Messages[0].Content[0].(provider.TextBlock).Text != "CHANGED" {
		t.Fatalf("stale turn line kept (fast path skipped rewrite): %q",
			got.Messages[0].Content[0].(provider.TextBlock).Text)
	}
}
