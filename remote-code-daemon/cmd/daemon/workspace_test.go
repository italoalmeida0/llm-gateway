package main

import (
	"os"
	"path/filepath"
	"testing"
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
