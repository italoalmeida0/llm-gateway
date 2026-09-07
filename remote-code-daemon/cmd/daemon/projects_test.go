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
	if got := d.loadProjects(); len(got) != 2 || got[0].ID != "child" || !got[1].Protected {
		t.Fatal("nested project was removed")
	}
}

func TestHomeOwnsUnassignedAndHomeAliases(t *testing.T) {
	d := testDaemon(t)
	projects := d.loadProjects()
	if len(projects) != 1 || projects[0].Name != "Home" || !projects[0].Protected {
		t.Fatal("missing default Home")
	}
	home := projects[0].Path
	projects = append(projects, ProjectEntry{ID: "work", Path: filepath.Join(home, "work")})
	for _, path := range []string{"", "~", home, home + string(filepath.Separator), t.TempDir()} {
		if project := projectForDirectory(path, projects); project == nil || project.ID != "home" {
			t.Fatalf("%q did not resolve to Home", path)
		}
	}
	if projectForDirectory(filepath.Join(home, "work", "src"), projects).ID != "work" {
		t.Fatal("Home captured another project")
	}
}
