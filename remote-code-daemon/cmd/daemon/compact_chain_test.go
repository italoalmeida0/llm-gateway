package main

import (
	"testing"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

func TestCompactionChainSurvivesSaveLoad(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{
		ID:     "chain",
		Model:  "alias",
		Status: "idle",
		Compaction: &core.CompactionState{
			PreviousSummary: "did stuff",
			ReadFiles:       []string{"a.ts"},
			ModifiedFiles:   []string{"b.ts"},
			Count:           2,
		},
		Messages: []provider.Message{
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hi"}}},
		},
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	loaded, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Compaction == nil || loaded.Compaction.PreviousSummary != "did stuff" || loaded.Compaction.Count != 2 {
		t.Fatalf("chain head lost: %+v", loaded.Compaction)
	}
	if len(loaded.Compaction.ReadFiles) != 1 || len(loaded.Compaction.ModifiedFiles) != 1 {
		t.Fatalf("file ops lost: %+v", loaded.Compaction)
	}
}
