package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeletingParentProjectPreservesNestedProjectConversations(t *testing.T) {
	d := testDaemon(t)
	parent := filepath.Join(t.TempDir(), "workspace")
	child := filepath.Join(parent, "TAP")
	projects := []ProjectEntry{{ID: "parent", Path: parent}, {ID: "child", Path: child}}
	if err := d.saveProjects(projects); err != nil {
		t.Fatal(err)
	}
	for _, s := range []*SessionRecord{{ID: "parent-session", CWD: parent}, {ID: "child-session", CWD: filepath.Join(child, "src")}, {ID: "sibling-session", CWD: parent + "-other"}} {
		if err := d.saveSession(s); err != nil {
			t.Fatal(err)
		}
	}
	d.handleMessage([]byte(`{"type":"delete_project","projectId":"parent"}`))
	if _, err := d.loadSession("parent-session"); !os.IsNotExist(err) {
		t.Fatal("parent session was not deleted")
	}
	for _, id := range []string{"child-session", "sibling-session"} {
		if _, err := d.loadSession(id); err != nil {
			t.Fatalf("deleted another project's session %s: %v", id, err)
		}
	}
	if got := d.loadProjects(); len(got) != 1 || got[0].ID != "child" {
		t.Fatal("nested project was removed")
	}
}
