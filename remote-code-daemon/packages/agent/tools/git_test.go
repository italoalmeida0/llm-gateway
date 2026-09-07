package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func initGitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary missing")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t"}
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init")
	run("commit", "--allow-empty", "-m", "init")
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v1\n"), 0o644)
	run("add", "a.txt")
	return dir
}

func TestGitStatusAndDiff(t *testing.T) {
	dir := initGitRepo(t)
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v2\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0o644)
	tool := &GitTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "status"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := toolResultText(t, res)
	if !strings.Contains(got, "branch") || !strings.Contains(got, "unstaged") || !strings.Contains(got, "untracked") {
		t.Fatalf("status shape wrong, got:\n%s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "diff", "statOnly": true}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "a.txt") {
		t.Fatalf("diff stat should mention a.txt, got:\n%s", got)
	}
}

func TestGitLogAndStash(t *testing.T) {
	dir := initGitRepo(t)
	tool := &GitTool{CWD: dir, Sandbox: NewSandbox(dir)}
	res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "log", "n": 3}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "init") {
		t.Fatalf("log should show init commit, got:\n%s", got)
	}
	// Stash flow: modify, stash via CLI, list/show/restore via tool.
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("stashed\n"), 0o644)
	cmd := exec.Command("git", "stash", "push", "-m", "wip")
	cmd.Dir = dir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t"}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("stash push: %v\n%s", err, out)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "stash_list"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "stash@{0}") {
		t.Fatalf("expected stash entry, got:\n%s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "stash_show", "ref": "stash@{0}"}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := toolResultText(t, res); !strings.Contains(got, "a.txt") {
		t.Fatalf("stash show should list a.txt, got:\n%s", got)
	}
	res, err = tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "stash_restore", "ref": "stash@{0}", "paths": []string{"a.txt"}}), nil)
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(data) != "stashed\n" {
		t.Fatalf("stash_restore failed: %q", data)
	}
}

func TestGitNotARepo(t *testing.T) {
	dir := t.TempDir()
	tool := &GitTool{CWD: dir, Sandbox: NewSandbox(dir)}
	if _, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"op": "status"}), nil); err == nil {
		t.Fatal("expected not-a-repo error")
	}
}
