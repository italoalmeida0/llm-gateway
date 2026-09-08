package core

import (
	"testing"
)

func TestSessionCompactionStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewSessionAtPath(dir+"/s.jsonl", dir, "openai", "m", "test")
	if err != nil {
		t.Fatal(err)
	}
	state := &CompactionState{
		Version:          CompactionProjectionVersion,
		PreviousSummary:  "did stuff",
		ReadFiles:        []string{"a.ts"},
		ModifiedFiles:    []string{"b.ts"},
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
	opened, _, err := OpenSession(dir + "/s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	got := opened.CompactionState()
	if got == nil || got.PreviousSummary != "did stuff" || got.Count != 3 || got.FirstKeptEntryID != "h2" {
		t.Fatalf("chain head lost across reopen: %+v", got)
	}
	if got.Version != CompactionProjectionVersion || got.KeepFrom != 2 {
		t.Fatalf("projection anchor lost across reopen: %+v", got)
	}
	if len(got.ReadFiles) != 1 || len(got.ModifiedFiles) != 1 {
		t.Fatalf("file ops lost across reopen: %+v", got)
	}
}
