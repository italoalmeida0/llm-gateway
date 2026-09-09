package core

import (
	"testing"
)

func TestSessionCompactionStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenSQLiteSessionStore(dir+"/s.db", dir, SessionMeta{Provider: "openai", Model: "m", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	state := &CompactionState{
		PreviousSummary:  "did stuff",
		ReadFiles:        []string{"a.ts"},
		ModifiedFiles:   []string{"b.ts"},
		FirstKeptEntryID: "h2",
		KeepFrom:         2,
		Count:            3,
	}
	if err := s.AppendCompaction(state); err != nil {
		t.Fatal(err)
	}
	if s.CompactionState() == nil || s.CompactionState().Count != 3 {
		t.Fatalf("in-memory chain head lost: %+v", s.CompactionState())
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	opened, err := OpenSQLiteSessionStore(dir+"/s.db", dir, SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	got := opened.CompactionState()
	if got == nil || got.PreviousSummary != "did stuff" || got.Count != 3 || got.FirstKeptEntryID != "h2" {
		t.Fatalf("chain head lost across reopen: %+v", got)
	}
	if got.KeepFrom != 2 {
		t.Fatalf("projection anchor lost across reopen: %+v", got)
	}
	if len(got.ReadFiles) != 1 || len(got.ModifiedFiles) != 1 {
		t.Fatalf("file ops lost across reopen: %+v", got)
	}
}
