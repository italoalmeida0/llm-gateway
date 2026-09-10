package main

import (
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Turn ids must survive the disk round-trip — including across a daemon
// restart (fresh load) and across load→save cycles (edit/delete/pin all
// reload the record before saving). Regression test: loadSession used to
// drop TurnSeq and FileBalloons, resetting turn numbering and wiping the
// persistent per-turn file-change balloons.
func TestTurnIndexPersistsAcrossSaveLoad(t *testing.T) {
	d := testDaemon(t)
	msg := func(role provider.Role, text string, turn int) provider.Message {
		return provider.Message{
			Role:      role,
			Content:   []provider.Content{provider.TextBlock{Text: text}},
			Time:      time.Now(),
			TurnIndex: turn,
		}
	}
	rec := &SessionRecord{
		ID:        "sess_turnids",
		CWD:       t.TempDir(),
		Title:     "turns",
		Model:     "m",
		Status:    "idle",
		CreatedAt: time.Now().UnixMilli(),
		UpdatedAt: time.Now().UnixMilli(),
		TurnSeq:   3,
		Messages: []provider.Message{
			msg(provider.RoleUser, "first", 1),
			msg(provider.RoleAssistant, "answer one", 1),
			msg(provider.RoleUser, "second", 3),
			msg(provider.RoleAssistant, "answer three", 3),
		},
		FileBalloons: []filetrack.TurnChanges{
			{TurnIndex: 1, At: 111, Files: []filetrack.ChangedFile{{Path: "/a", Status: "new"}}},
		},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatalf("saveSession: %v", err)
	}
	// Fresh load, as after a daemon restart.
	loaded, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatalf("loadSession: %v", err)
	}
	if loaded.TurnSeq != 3 {
		t.Fatalf("TurnSeq = %d; want 3 (numbering must continue after restart)", loaded.TurnSeq)
	}
	if len(loaded.FileBalloons) != 1 || loaded.FileBalloons[0].TurnIndex != 1 {
		t.Fatalf("FileBalloons lost on load: %+v", loaded.FileBalloons)
	}
	if len(loaded.Messages) != 4 {
		t.Fatalf("messages = %d; want 4", len(loaded.Messages))
	}
	for i, want := range []int{1, 1, 3, 3} {
		if loaded.Messages[i].TurnIndex != want {
			t.Fatalf("message %d TurnIndex = %d; want %d", i, loaded.Messages[i].TurnIndex, want)
		}
	}
	// A second load→save cycle (edit/delete/pin path) must not wipe them.
	if err := d.saveSession(loaded); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	reloaded, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatalf("re-load: %v", err)
	}
	if reloaded.TurnSeq != 3 || len(reloaded.FileBalloons) != 1 || reloaded.Messages[3].TurnIndex != 3 {
		t.Fatalf("round-trip lost turn metadata: seq=%d balloons=%d lastTurn=%d",
			reloaded.TurnSeq, len(reloaded.FileBalloons), reloaded.Messages[3].TurnIndex)
	}
}
