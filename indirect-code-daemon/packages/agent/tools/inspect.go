package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/ignore"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type InspectArgs struct {
	// Path scopes the listing (workspace-relative file or dir, default ".").
	Path string `json:"path,omitempty"`
	// Depth limits recursion (default 1, max 5).
	Depth int `json:"depth,omitempty"`
	// ShowHidden includes dotfiles (default false).
	ShowHidden bool `json:"showHidden,omitempty"`
	// GitStatus annotates files with git status flags (default true).
	GitStatus *bool `json:"gitStatus,omitempty"`
	// MaxEntries caps returned entries (default 200, max 1000).
	MaxEntries int `json:"maxEntries,omitempty"`
	// Include limits entries by glob(s).
	Include []string `json:"include,omitempty"`
	// Exclude skips entries by glob(s).
	Exclude []string `json:"exclude,omitempty"`
}

type inspectEntry struct {
	rel   string
	isDir bool
	size  int64
}

// InspectTool replaces ls/cat/head/wc -l with one structured call: a tree
// with sizes, line counts for text files, and git status flags (M/A/D/??)
// beside each entry — rendered as a clickable tree in the dashboard.
type InspectTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *InspectTool) Name() string { return "inspect" }

func (t *InspectTool) Description() string {
	return "List a directory tree with sizes, line counts and git status flags. Params: `path` (default '.'), `depth` (default 1, max 5), `showHidden` (default false), `gitStatus` (default true), `maxEntries` (default 200, max 1000), `include`/`exclude` globs. Single files report size + line count + git flag."
}

const inspectSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Directory or file path to inspect (defaults to '.')."},"depth":{"type":"number","description":"Maximum directory recursion depth (default 1, max 5)."},"showHidden":{"type":"boolean","description":"Include hidden files and dotfiles (default false)."},"gitStatus":{"type":"boolean","description":"Annotate files with git status flags (M/A/D/??) (default true)."},"maxEntries":{"type":"number","description":"Maximum entries to return (default 200, max 1000)."},"include":{"type":"array","items":{"type":"string"},"description":"Glob patterns to include."},"exclude":{"type":"array","items":{"type":"string"},"description":"Glob patterns to exclude."}}}`

func (t *InspectTool) Schema() json.RawMessage { return json.RawMessage(inspectSchema) }

func (t *InspectTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a InspectArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	scope := strings.TrimSpace(a.Path)
	if scope == "" {
		scope = "."
	}
	abs := resolvePath(t.CWD, scope)
	if err := t.Sandbox.CheckPath(abs); err != nil {
		return core.ToolResult{}, fmt.Errorf("inspect: invalid path: %v", err)
	}
	depth := a.Depth
	if depth <= 0 {
		depth = 1
	}
	if depth > 5 {
		depth = 5
	}
	maxEntries := a.MaxEntries
	if maxEntries <= 0 {
		maxEntries = 200
	}
	if maxEntries > 1000 {
		maxEntries = 1000
	}
	wantGit := true
	if a.GitStatus != nil {
		wantGit = *a.GitStatus
	}

	st, err := os.Stat(abs)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("inspect: path not found: %s", scope)
	}

	var gitFlags map[string]string
	if wantGit {
		gitFlags = gitStatusMap(t.CWD)
	}

	var b strings.Builder
	if !st.IsDir() {
		rel, _ := filepath.Rel(t.CWD, abs)
		flag := gitFlags[slash(rel)]
		lines := ""
		if data, err := os.ReadFile(abs); err == nil && isText(data) {
			lines = fmt.Sprintf(", %d lines", countLines(data))
		}
		fmt.Fprintf(&b, "%s  %s (%s%s)\n", flagField(flag), slash(rel), humanBytes(st.Size()), lines)
		return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: b.String()}}}, nil
	}

	gi := ignore.Load(abs)
	var entries []inspectEntry
	truncated := false
	rootDepth := strings.Count(filepath.Clean(abs), string(os.PathSeparator))
	err = filepath.WalkDir(abs, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if p == abs {
			return nil
		}
		rel, _ := filepath.Rel(t.CWD, p)
		relSlash := slash(rel)
		base := filepath.Base(p)
		if !a.ShowHidden && strings.HasPrefix(base, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			name := base
			if name == ".git" || name == "node_modules" || name == ".hg" || name == ".svn" {
				return filepath.SkipDir
			}
			if gi != nil && gi.Match(relSlash+"/", true) {
				return filepath.SkipDir
			}
		} else {
			if gi != nil && gi.Match(relSlash, false) {
				return nil
			}
		}
		if !matchAnyGlob(a.Include, relSlash, true) {
			if d.IsDir() {
				// Still descend: children may match.
			} else {
				return nil
			}
		} else if matchAnyGlob(a.Exclude, relSlash, false) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		curDepth := strings.Count(filepath.Clean(p), string(os.PathSeparator)) - rootDepth
		if curDepth > depth {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		var size int64
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				size = info.Size()
			}
		}
		entries = append(entries, inspectEntry{rel: relSlash, isDir: d.IsDir(), size: size})
		if len(entries) >= maxEntries {
			truncated = true
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil && err != filepath.SkipAll {
		return core.ToolResult{}, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].isDir != entries[j].isDir {
			return entries[i].isDir
		}
		return entries[i].rel < entries[j].rel
	})

	scopeSlash := slash(scope)
	if scopeSlash == "." {
		scopeSlash = ""
	}
	fmt.Fprintf(&b, "%s/ (%d entries", scope, len(entries))
	if truncated {
		fmt.Fprintf(&b, ", capped at %d", maxEntries)
	}
	b.WriteString(")\n")
	for _, e := range entries {
		name := e.rel
		if scopeSlash != "" {
			name = strings.TrimPrefix(name, scopeSlash+"/")
		}
		indent := strings.Repeat("  ", strings.Count(name, "/"))
		base := filepath.Base(name)
		flag := gitFlags[e.rel]
		if e.isDir {
			fmt.Fprintf(&b, "%s%s%s/\n", indent, flagField(flag), base)
			continue
		}
		extra := ""
		if e.size < 256*1024 {
			if data, err := os.ReadFile(filepath.Join(t.CWD, filepath.FromSlash(e.rel))); err == nil && isText(data) {
				extra = fmt.Sprintf(", %d lines", countLines(data))
			}
		}
		fmt.Fprintf(&b, "%s%s%s (%s%s)\n", indent, flagField(flag), base, humanBytes(e.size), extra)
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
	}, nil
}

func flagField(flag string) string {
	if flag == "" {
		return "    "
	}
	return fmt.Sprintf("[%s] ", flag)
}

func humanBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%dB", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1fMB", float64(n)/(1024*1024))
	}
}

// gitStatusMap runs `git status --porcelain` once and maps paths to flags.
// Returns nil when not a repo or git is missing (no error — flags just empty).
func gitStatusMap(cwd string) map[string]string {
	out, err := runGit(cwd, "status", "--porcelain=v1", "--untracked-files=normal")
	if err != nil {
		return nil
	}
	m := map[string]string{}
	for _, ln := range strings.Split(out, "\n") {
		if len(ln) < 4 {
			continue
		}
		xy := strings.TrimSpace(ln[:2])
		path := strings.TrimSpace(ln[3:])
		// Renames look like "old -> new"; flag the new path.
		if i := strings.Index(path, " -> "); i >= 0 {
			path = path[i+4:]
		}
		path = strings.Trim(path, `"`)
		flag := "M"
		switch {
		case strings.Contains(xy, "A"):
			flag = "A"
		case strings.Contains(xy, "D"):
			flag = "D"
		case strings.Contains(xy, "?"):
			flag = "??"
		case strings.Contains(xy, "R"):
			flag = "R"
		}
		m[path] = flag
		// Also flag parent dirs so the tree shows where changes live.
		dir := path
		for {
			d := slash(filepath.Dir(dir))
			if d == "." || d == "/" || d == dir {
				break
			}
			if _, ok := m[d]; !ok {
				m[d] = "•"
			}
			dir = d
		}
	}
	return m
}

// countLines counts lines like wc -l plus a final partial line.
func countLines(data []byte) int {
	n := strings.Count(string(data), "\n")
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		n++
	}
	if n == 0 && len(data) > 0 {
		n = 1
	}
	return n
}

// runGit executes git with a fixed timeout, no pager, no color, and no
// interactive prompts. Moved here from the removed git tool — inspect's
// git-status flags are its only remaining user (git ops go via bash).
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
