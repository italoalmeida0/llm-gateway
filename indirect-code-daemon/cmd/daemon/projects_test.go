package main

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestRootProjectNotTreatedAsHome(t *testing.T) {
	d := testDaemon(t)
	root := "/"
	if runtime.GOOS == "windows" {
		root = "C:\\"
	}
	d.handleMessage([]byte(`{"type":"create_project","path":"` + root + `","requestId":"req-root"}`))
	projects := d.loadProjects()
	var rootProj *ProjectEntry
	for i := range projects {
		if filepath.Clean(projects[i].Path) == filepath.Clean(root) {
			rootProj = &projects[i]
			break
		}
	}
	if rootProj == nil {
		t.Fatalf("root project was not created")
	}
	if rootProj.Name == "Home" {
		t.Fatalf("root project was mistakenly named 'Home': got %q", rootProj.Name)
	}
	if rootProj.Protected {
		t.Fatalf("root project was mistakenly marked Protected")
	}
}

func TestLoadProjectsRepairsCorruptedRootProject(t *testing.T) {
	d := testDaemon(t)
	root := "/"
	if runtime.GOOS == "windows" {
		root = "C:\\"
	}
	corrupted := []ProjectEntry{
		{ID: "proj_root", Name: "Home", Path: root, Protected: true},
	}
	if err := d.saveProjects(corrupted); err != nil {
		t.Fatal(err)
	}
	repaired := d.loadProjects()
	var rootProj *ProjectEntry
	for i := range repaired {
		if filepath.Clean(repaired[i].Path) == filepath.Clean(root) {
			rootProj = &repaired[i]
			break
		}
	}
	if rootProj == nil {
		t.Fatal("root project not found")
	}
	if rootProj.Name == "Home" {
		t.Fatalf("corrupted root project name was not repaired: got %q", rootProj.Name)
	}
	if rootProj.Protected {
		t.Fatal("corrupted root project protected flag was not cleared")
	}
}

