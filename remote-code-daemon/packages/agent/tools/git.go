package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

type GitArgs struct {
	// Op is one of: status, diff, log, stash_list, stash_show, stash_restore.
	Op string `json:"op"`
	// Paths optionally scopes status/diff/log to files.
	Paths []string `json:"paths,omitempty"`
	// Staged diffs the index instead of the worktree (diff only).
	Staged bool `json:"staged,omitempty"`
	// StatOnly returns --stat instead of full diff.
	StatOnly bool `json:"statOnly,omitempty"`
	// N limits log entries (default 10, max 50).
	N int `json:"n,omitempty"`
	// Ref selects what to show: stash ref (stash_show) or file@stash
	// (stash_restore: "path" or "path1,path2" via Paths).
	Ref string `json:"ref,omitempty"`
	// MaxBytes caps diff output (default 256KB).
	MaxBytes int `json:"maxBytes,omitempty"`
}

// GitTool exposes structured git operations: status (branch, ahead/behind,
// staged/unstaged/untracked), diff (stat or full), log, and stash
// show/restore. The stash_restore op is the one that would have saved the
// migration session: restore named paths from a stash ref without the
// ls-tree/archive/tar dance.
type GitTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *GitTool) Name() string { return "git" }

func (t *GitTool) Description() string {
	return "Structured git: `op` status (branch, ahead/behind, staged/unstaged/untracked), diff (paths?, staged?, statOnly?), log (n?, paths?), stash_list, stash_show (ref), stash_restore (ref + paths). Read-only except stash_restore, which restores listed paths from a stash. Rejects non-repo dirs."
}

const gitSchema = `{"type":"object","required":["op"],"properties":{"op":{"type":"string","enum":["status","diff","log","stash_list","stash_show","stash_restore"]},"paths":{"type":"array","items":{"type":"string"}},"staged":{"type":"boolean"},"statOnly":{"type":"boolean"},"n":{"type":"number"},"ref":{"type":"string"},"maxBytes":{"type":"number"}}}`

func (t *GitTool) Schema() json.RawMessage { return json.RawMessage(gitSchema) }

func (t *GitTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a GitArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	// Gate: must run inside a git repo, and repo root must be within the jail.
	root, err := gitRoot(t.CWD)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("git: not a repository (or git missing)")
	}
	if err := t.Sandbox.CheckPath(root); err != nil {
		return core.ToolResult{}, fmt.Errorf("git: repo outside sandbox: %v", err)
	}
	maxBytes := a.MaxBytes
	if maxBytes <= 0 {
		maxBytes = 256 * 1024
	}

	var text string
	switch a.Op {
	case "status":
		text, err = t.opStatus(a)
	case "diff":
		text, err = t.opDiff(a, maxBytes)
	case "log":
		text, err = t.opLog(a)
	case "stash_list":
		text, err = t.opStashList()
	case "stash_show":
		text, err = t.opStashShow(a, maxBytes)
	case "stash_restore":
		text, err = t.opStashRestore(a)
	default:
		return core.ToolResult{}, fmt.Errorf("git: unknown op %q (status|diff|log|stash_list|stash_show|stash_restore)", a.Op)
	}
	if err != nil {
		return core.ToolResult{}, err
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: text}},
	}, nil
}

func (t *GitTool) opStatus(a GitArgs) (string, error) {
	branch, _ := runGit(t.CWD, "rev-parse", "--abbrev-ref", "HEAD")
	branch = strings.TrimSpace(branch)
	if branch == "" {
		branch = "(detached)"
	}
	ahead, behind := "?", "?"
	if out, err := runGit(t.CWD, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"); err == nil {
		if f := strings.Fields(strings.TrimSpace(out)); len(f) == 2 {
			ahead, behind = f[0], f[1]
		}
	}
	statusArgs := []string{"status", "--porcelain=v1", "--untracked-files=normal", "--"}
	statusArgs = append(statusArgs, a.Paths...)
	out, err := runGit(t.CWD, statusArgs...)
	if err != nil {
		return "", fmt.Errorf("git status failed: %v", err)
	}
	var staged, unstaged, untracked []string
	for _, ln := range strings.Split(out, "\n") {
		if len(ln) < 4 {
			continue
		}
		x, y := ln[0], ln[1]
		path := strings.TrimSpace(ln[3:])
		if x == '?' || y == '?' {
			untracked = append(untracked, path)
			continue
		}
		if x != ' ' {
			staged = append(staged, fmt.Sprintf("%c %s", x, path))
		}
		if y != ' ' {
			unstaged = append(unstaged, fmt.Sprintf("%c %s", y, path))
		}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "branch %s  ahead %s  behind %s\n", branch, ahead, behind)
	fmt.Fprintf(&b, "staged (%d): %s\n", len(staged), strings.Join(staged, ", "))
	fmt.Fprintf(&b, "unstaged (%d): %s\n", len(unstaged), strings.Join(unstaged, ", "))
	fmt.Fprintf(&b, "untracked (%d): %s\n", len(untracked), strings.Join(untracked, ", "))
	if len(staged)+len(unstaged)+len(untracked) == 0 {
		b.WriteString("clean")
	}
	return b.String(), nil
}

func (t *GitTool) opDiff(a GitArgs, maxBytes int) (string, error) {
	args := []string{"diff", "--no-color", "--no-ext-diff"}
	if a.Staged {
		args = append(args, "--cached")
	}
	if a.StatOnly {
		args = append(args, "--stat")
	}
	args = append(args, "--")
	args = append(args, a.Paths...)
	out, err := runGit(t.CWD, args...)
	if err != nil {
		return "", fmt.Errorf("git diff failed: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		return "(no diff)", nil
	}
	return capText(out, maxBytes), nil
}

func (t *GitTool) opLog(a GitArgs) (string, error) {
	n := a.N
	if n <= 0 {
		n = 10
	}
	if n > 50 {
		n = 50
	}
	args := []string{"log", fmt.Sprintf("-%d", n), "--oneline", "--decorate", "--"}
	args = append(args, a.Paths...)
	out, err := runGit(t.CWD, args...)
	if err != nil {
		return "", fmt.Errorf("git log failed: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		return "(no commits)", nil
	}
	return out, nil
}

func (t *GitTool) opStashList() (string, error) {
	out, err := runGit(t.CWD, "stash", "list")
	if err != nil {
		return "", fmt.Errorf("git stash list failed: %v", err)
	}
	if strings.TrimSpace(out) == "" {
		return "(no stashes)", nil
	}
	return out, nil
}

func (t *GitTool) opStashShow(a GitArgs, maxBytes int) (string, error) {
	ref := strings.TrimSpace(a.Ref)
	if ref == "" {
		ref = "stash@{0}"
	}
	if !validStashRef(ref) {
		return "", fmt.Errorf("git: invalid stash ref %q", ref)
	}
	out, err := runGit(t.CWD, "stash", "show", "--name-status", ref)
	if err != nil {
		return "", fmt.Errorf("git stash show failed: %v", err)
	}
	return capText(out, maxBytes), nil
}

func (t *GitTool) opStashRestore(a GitArgs) (string, error) {
	ref := strings.TrimSpace(a.Ref)
	if ref == "" {
		ref = "stash@{0}"
	}
	if !validStashRef(ref) {
		return "", fmt.Errorf("git: invalid stash ref %q", ref)
	}
	if len(a.Paths) == 0 {
		return "", fmt.Errorf("git stash_restore: `paths` required (never restore blindly)")
	}
	// Validate every path against the jail BEFORE touching git.
	for _, p := range a.Paths {
		abs := resolvePath(t.CWD, p)
		if err := t.Sandbox.CheckPath(abs); err != nil {
			return "", fmt.Errorf("git stash_restore: path rejected: %s", p)
		}
	}
	args := append([]string{"checkout", ref, "--"}, a.Paths...)
	out, err := runGit(t.CWD, args...)
	if err != nil {
		return "", fmt.Errorf("git stash_restore failed: %v\n%s", err, out)
	}
	return fmt.Sprintf("restored %d path(s) from %s:\n%s", len(a.Paths), ref, strings.Join(a.Paths, "\n")), nil
}

func validStashRef(ref string) bool {
	if ref == "stash" {
		return true
	}
	if !strings.HasPrefix(ref, "stash@{") || !strings.HasSuffix(ref, "}") {
		return false
	}
	inner := ref[len("stash@{") : len(ref)-1]
	if inner == "" {
		return false
	}
	for _, r := range inner {
		if (r < '0' || r > '9') && r != '^' {
			// Allow stash@{0}^1-style parents for index/untracked commits.
			if r != '^' && r != '1' && r != '2' && r != '3' {
				return false
			}
		}
	}
	return true
}

func gitRoot(cwd string) (string, error) {
	out, err := runGit(cwd, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// runGit executes git with a fixed timeout, no pager, no color, and no
// interactive prompts. GIT_OPTIONAL_LOCKS=0 avoids background maintenance
// from mutating state during reads.
func runGit(cwd string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-c", "color.ui=false", "--no-pager"}, args...)...)
	cmd.Dir = cwd
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "SYSTEMROOT=" + os.Getenv("SYSTEMROOT")}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String() + stderr.String(), err
	}
	return stdout.String(), nil
}

func capText(s string, max int) string {
	if len(s) > max {
		return s[:max] + fmt.Sprintf("\n…(truncated, %d bytes total)", len(s))
	}
	return s
}

// PATH/HOME come from the daemon process env (set at startup).
