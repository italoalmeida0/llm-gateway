package main

import (
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// The WAL contract: while a turn runs the session file on disk stays
// frozen; every mutation appends one WAL line; the turn end commits the
// turn line + meta once and removes the WAL.
func TestWALFreezesJSONUntilCommit(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "walfreeze", CWD: t.TempDir(), Model: "m", Status: "idle", Options: SessionOptions{Mode: "build"}}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	frozen, err := os.ReadFile(filepath.Join(d.sessionsDir(), "walfreeze.jsonl"))
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a running turn: freeze + header + appends, no JSON writes.
	act := &ActiveSession{record: rec}
	rec.Status = "running"
	rec.TurnSeq = 1
	rec.Turn = &TurnActivity{StartedAt: 7, Status: "running"}
	ww, err := d.openWAL(rec.ID, &walHeader{TurnIndex: 1, StartedAt: 7, Model: "m", Prompt: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	act.wal = ww
	if err := d.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	d.appendWALEvent(act, walMsgEvent(provider.Message{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hello"}}}))
	rec.Messages = append(rec.Messages, provider.Message{Role: provider.RoleUser, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hello"}}})
	d.appendWALEvent(act, walMsgEvent(provider.Message{Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hi"}}}))
	rec.Messages = append(rec.Messages, provider.Message{Role: provider.RoleAssistant, TurnIndex: 1, Content: []provider.Content{provider.TextBlock{Text: "hi"}}})
	rec.Title, rec.TitleSource = "T", "manual"
	d.appendWALEvent(act, walEvent{Type: walTypeTitle, Title: "T", TitleSource: "manual"})

	// The frozen file must carry zero turn deltas (only the running flip).
	raw, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.Messages) != 0 || raw.Title != "" {
		t.Fatalf("frozen file mutated mid-turn: %+v", raw)
	}
	_ = frozen

	// Fused read sees everything.
	fused, h, err := d.loadSessionFused(rec.ID)
	if err != nil || h == nil || h.Prompt != "hello" {
		t.Fatalf("fused read: %v %+v", err, h)
	}
	if len(fused.Messages) != 2 || fused.Title != "T" {
		t.Fatalf("fused replay lost deltas: %+v", fused)
	}

	// Commit: single rewrite + WAL removal.
	act.record.Turn.Status = "completed"
	act.record.Status = "idle"
	if err := d.commitWAL(act); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.walPath(rec.ID)); !os.IsNotExist(err) {
		t.Fatal("commit left the WAL behind")
	}
	after, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Messages) != 2 || after.Title != "T" || after.Status != "idle" {
		t.Fatalf("commit lost state: %+v", after)
	}
}

// A torn tail write (crash mid-append) is ignored; a corrupt middle line
// aborts the replay fail-closed.
func TestWALToleratesTornTail(t *testing.T) {
	d := testDaemon(t)
	ww, err := d.openWAL("torn", &walHeader{TurnIndex: 1, Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if err := ww.append(walMsgEvent(provider.Message{Role: provider.RoleUser, TurnIndex: 1})); err != nil {
		t.Fatal(err)
	}
	if err := ww.flush(); err != nil {
		t.Fatal(err)
	}
	// Simulate a torn write: partial line without newline.
	ww.mu.Lock()
	_, _ = ww.file.WriteString(`{"v":1,"type":"msg","msg":{"role":"user"`)
	ww.mu.Unlock()
	_ = ww.close()

	data, err := os.ReadFile(d.walPath("torn"))
	if err != nil {
		t.Fatal(err)
	}
	fused, _, err := replayWAL(&SessionRecord{ID: "torn"}, data)
	if err != nil {
		t.Fatalf("torn tail aborted replay: %v", err)
	}
	if len(fused.Messages) != 1 {
		t.Fatalf("replay lost prefix: %d", len(fused.Messages))
	}
}

// Commit-window crash: JSON already carries the finished turn but the WAL
// removal never ran. Resume must drop the stale log, never re-run.
func TestWALCommitWindowDropsStaleLog(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "commitwin", CWD: t.TempDir(), Model: "m",
		Status: "idle", TurnSeq: 3,
		Turn:     &TurnActivity{StartedAt: 9, EndedAt: 10, Status: "completed"},
		Messages: []provider.Message{{Role: provider.RoleUser, TurnIndex: 3}},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	ww, err := d.openWAL(rec.ID, &walHeader{TurnIndex: 3, StartedAt: 9, Prompt: "old"})
	if err != nil {
		t.Fatal(err)
	}
	_ = ww.close()
	d.resumeInterruptedTurns()
	if h, _ := d.readWALHeader(rec.ID); h != nil {
		t.Fatal("stale WAL survived resume")
	}
	after, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if after.TurnSeq != 3 || after.Turn.Status != "completed" {
		t.Fatalf("resume rewrote committed state: %+v", after.Turn)
	}
}
