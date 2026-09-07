package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/patriceckhart/zot/packages/provider"
)

func TestWorkspaceDeletionAndRecreation(t *testing.T) {
	d := testDaemon(t)
	path := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	rec := &SessionRecord{ID: "missing", CWD: path, Status: "idle"}
	act := &ActiveSession{record: rec}
	d.sessions[rec.ID] = act
	if inspectWorkspace(path).Status != "available" {
		t.Fatal("existing folder unavailable")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if projectPayload(ProjectEntry{Path: path})["folderStatus"] != "missing" {
		t.Fatal("project mirror hides missing folder")
	}
	if sessionPayload(rec)["workspace"].(workspaceStatus).Status != "missing" {
		t.Fatal("session snapshot hides missing folder")
	}
	d.runAgentTurn(act, "Do work", "model", true, nil)
	if rec.Turn != nil || len(rec.Messages) != 0 || rec.Status != "idle" {
		t.Fatal("started a turn in a deleted workspace")
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if inspectWorkspace(path).Status != "available" {
		t.Fatal("recreated directory stays unavailable")
	}
}

func TestFinalReviewDetectsRemovedFilesAndKeepsTheirHistory(t *testing.T) {
	d, j, sb := reviewFixture(t)
	reviewedWrite(t, j, sb, "created.txt", "new contents")
	path := filepath.Join(j.cwd, "created.txt")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	j.finalize()
	data, err := os.ReadFile(d.reviewPath(j.sessionID))
	if err != nil {
		t.Fatal(err)
	}
	var review taskReview
	if json.Unmarshal(data, &review) != nil || review.CheckedAt == 0 {
		t.Fatal("final review was not persisted")
	}
	entry := review.public(true)["files"].([]map[string]any)[0]
	if entry["state"] != "deleted" || entry["kind"] != "created then deleted" || entry["canUndo"] != false {
		t.Fatalf("wrong deleted-file presentation: %+v", entry)
	}
	undoReview(d, j, "")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("Undo recreated a transient file")
	}
}

func TestAssistantMessagesCannotBeEditedOrDeleted(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "immutable-assistant", Messages: []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "Request"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "Answer"}}},
	}}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	d.handleMessage([]byte(`{"type":"edit_message","sessionId":"immutable-assistant","index":1,"text":"Replaced"}`))
	d.handleMessage([]byte(`{"type":"delete_message","sessionId":"immutable-assistant","index":1}`))
	got, err := d.loadSession(rec.ID)
	if err != nil || len(got.Messages) != 2 || got.Messages[1].Content[0].(provider.TextBlock).Text != "Answer" {
		t.Fatal("assistant transcript was changed")
	}
	d.handleMessage([]byte(`{"type":"delete_message","sessionId":"immutable-assistant","index":0}`))
	got, err = d.loadSession(rec.ID)
	if err != nil || len(got.Messages) != 1 || got.Messages[0].Role != provider.RoleAssistant {
		t.Fatal("user message deletion no longer works")
	}
}
