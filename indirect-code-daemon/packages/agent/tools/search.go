package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/ignore"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type SearchArgs struct {
	// Pattern is a regex (isRegex=true) or literal substring.
	Pattern string `json:"pattern"`
	// Path scopes the search (workspace-relative file or dir, default ".").
	Path string `json:"path,omitempty"`
	// IsRegex enables RE2 regex; default is literal substring search.
	IsRegex bool `json:"isRegex,omitempty"`
	// Include limits files by glob(s), e.g. ["*.ts", "*.tsx"].
	Include []string `json:"include,omitempty"`
	// Exclude skips files by glob(s), e.g. ["dist/**", "*.min.js"].
	Exclude []string `json:"exclude,omitempty"`
	// MaxResults caps returned matches (default 50, max 200).
	MaxResults int `json:"maxResults,omitempty"`
	// ContextLines includes N lines before/after each match (default 0, max 5).
	ContextLines int `json:"contextLines,omitempty"`
	// CaseSensitive enables case-sensitive matching (default false).
	CaseSensitive bool `json:"caseSensitive,omitempty"`
	// RespectGitignore skips gitignored files (default true).
	RespectGitignore *bool `json:"respectGitignore,omitempty"`
	// MaxFileBytes skips files larger than this (default 1MB).
	MaxFileBytes int64 `json:"maxFileBytes,omitempty"`
}

type SearchMatch struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Col     int      `json:"col"`
	Text    string   `json:"text"`
	Context []string `json:"context,omitempty"`
}

// SearchTool is structured content search (grep, but machine-readable).
// Returns [{file, line, col, text}] with optional context lines — the model
// can open exact locations with read instead of re-scanning output text.
type SearchTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *SearchTool) Name() string { return "search" }

func (t *SearchTool) Description() string {
	return "Search file contents with regex or literal match. Params: `pattern` (required), `path` (file/dir scope, default '.'), `isRegex` (default false), `include`/`exclude` globs, `maxResults` (default 50, max 200), `contextLines` (default 0, max 5), `caseSensitive` (default false), `respectGitignore` (default true). Returns structured matches [{file, line, col, text}] — open hits with read."
}

const searchSchema = `{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string","description":"Regex (isRegex=true) or literal substring to find."},"path":{"type":"string","description":"Workspace-relative file or dir scope (default '.')."},"isRegex":{"type":"boolean","description":"Treat pattern as an RE2 regular expression (default false)."},"include":{"type":"array","items":{"type":"string"},"description":"File glob patterns to include (e.g. ['*.ts', '*.tsx'])."},"exclude":{"type":"array","items":{"type":"string"},"description":"File glob patterns to exclude (e.g. ['dist/**', '*.min.js'])."},"maxResults":{"type":"number","description":"Maximum number of matches to return (default 50, max 200)."},"contextLines":{"type":"number","description":"Number of context lines before and after each match (default 0, max 5)."},"caseSensitive":{"type":"boolean","description":"Case-sensitive search (default false)."},"respectGitignore":{"type":"boolean","description":"Skip files ignored by git (default true)."},"maxFileBytes":{"type":"number","description":"Skip files larger than this size in bytes (default 1MB)."}}}`

func (t *SearchTool) Schema() json.RawMessage { return json.RawMessage(searchSchema) }

func (t *SearchTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a SearchArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	pattern := a.Pattern
	if pattern == "" {
		return core.ToolResult{}, fmt.Errorf("search: `pattern` is required")
	}
	maxResults := a.MaxResults
	if maxResults <= 0 {
		maxResults = 50
	}
	if maxResults > 200 {
		maxResults = 200
	}
	ctxLines := a.ContextLines
	if ctxLines < 0 {
		ctxLines = 0
	}
	if ctxLines > 5 {
		ctxLines = 5
	}
	maxBytes := a.MaxFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	respectIgnore := true
	if a.RespectGitignore != nil {
		respectIgnore = *a.RespectGitignore
	}

	// Compile matcher.
	var re *regexp.Regexp
	literal := pattern
	if !a.CaseSensitive {
		literal = strings.ToLower(pattern)
	}
	if a.IsRegex {
		src := pattern
		if !a.CaseSensitive {
			src = "(?i)" + src
		}
		var err error
		re, err = regexp.Compile(src)
		if err != nil {
			return core.ToolResult{}, fmt.Errorf("search: invalid regex: %v", err)
		}
	}

	// Resolve scope.
	scope := "."
	if p := strings.TrimSpace(a.Path); p != "" {
		scope = p
	}
	absScope := resolvePath(t.CWD, scope)
	if err := t.Sandbox.CheckPath(absScope); err != nil {
		return core.ToolResult{}, fmt.Errorf("search: invalid path: %v", err)
	}
	st, err := os.Stat(absScope)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("search: path not found: %s", scope)
	}

	// Collect candidate files.
	var files []string
	if !st.IsDir() {
		files = []string{absScope}
	} else {
		var gi *ignore.Gitignore
		if respectIgnore {
			gi = ignore.Load(absScope)
		}
		err = filepath.WalkDir(absScope, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			rel, _ := filepath.Rel(t.CWD, p)
			if rel == "." {
				return nil
			}
			// Skip well-known heavy dirs early (also covered by gitignore usually).
			base := filepath.Base(p)
			if d.IsDir() {
				if base == ".git" || base == "node_modules" || base == ".hg" || base == ".svn" {
					return filepath.SkipDir
				}
				if respectIgnore && gi != nil && gi.Match(slash(rel)+"/", true) {
					return filepath.SkipDir
				}
				return nil
			}
			if respectIgnore && gi != nil && gi.Match(slash(rel), false) {
				return nil
			}
			if !matchAnyGlob(a.Include, rel, true) {
				return nil
			}
			if matchAnyGlob(a.Exclude, rel, false) {
				return nil
			}
			if info, err := d.Info(); err == nil && info.Size() > maxBytes {
				return nil
			}
			files = append(files, p)
			return nil
		})
		if err != nil {
			return core.ToolResult{}, err
		}
	}
	sort.Strings(files)

	var matches []SearchMatch
	truncated := false
outer:
	for _, f := range files {
		if ctx.Err() != nil {
			break
		}
		rel, _ := filepath.Rel(t.CWD, f)
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		if !isText(data) {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for i, ln := range lines {
			var col int
			var ok bool
			if re != nil {
				loc := re.FindStringIndex(ln)
				if loc == nil {
					continue
				}
				col, ok = loc[0]+1, true
			} else {
				hay := ln
				if !a.CaseSensitive {
					hay = strings.ToLower(ln)
				}
				idx := strings.Index(hay, literal)
				if idx < 0 {
					continue
				}
				col, ok = idx+1, true
			}
			if !ok {
				continue
			}
			m := SearchMatch{File: slash(rel), Line: i + 1, Col: col, Text: trimLine(ln)}
			if ctxLines > 0 {
				for k := i - ctxLines; k <= i+ctxLines; k++ {
					if k < 0 || k >= len(lines) || k == i {
						continue
					}
					m.Context = append(m.Context, fmt.Sprintf("%d:%s", k+1, trimLine(lines[k])))
				}
			}
			matches = append(matches, m)
			if len(matches) >= maxResults {
				truncated = true
				break outer
			}
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%d match%s", len(matches), plural(len(matches)))
	if truncated {
		fmt.Fprintf(&b, " (capped at %d — narrow `path` or `include`)", maxResults)
	}
	b.WriteString("\n")
	for _, m := range matches {
		fmt.Fprintf(&b, "%s:%d:%d: %s\n", m.File, m.Line, m.Col, m.Text)
		for _, c := range m.Context {
			fmt.Fprintf(&b, "  %s\n", c)
		}
	}
	if len(matches) == 0 {
		b.WriteString("(no matches)")
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
	}, nil
}

func slash(p string) string { return filepath.ToSlash(p) }

func trimLine(s string) string {
	s = strings.TrimRight(s, "\r")
	if len(s) > 300 {
		return s[:300] + "…"
	}
	return s
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "es"
}

// matchAnyGlob reports whether rel matches any of the glob patterns.
// Empty list + allowEmpty=true means "match everything".
func matchAnyGlob(patterns []string, rel string, allowEmpty bool) bool {
	if len(patterns) == 0 {
		return allowEmpty
	}
	relSlash := slash(rel)
	base := slash(filepath.Base(rel))
	for _, pat := range patterns {
		pat = strings.TrimSpace(pat)
		if pat == "" {
			continue
		}
		// Try full-path match, basename match, and doublestar-ish suffix.
		if ok, _ := filepath.Match(pat, relSlash); ok {
			return true
		}
		if ok, _ := filepath.Match(pat, base); ok {
			return true
		}
		if strings.HasPrefix(pat, "**/") {
			if ok, _ := filepath.Match(strings.TrimPrefix(pat, "**/"), base); ok {
				return true
			}
			if ok, _ := filepath.Match(strings.TrimPrefix(pat, "**/"), relSlash); ok {
				return true
			}
		}
		if strings.HasSuffix(pat, "/**") {
			prefix := strings.TrimSuffix(pat, "/**")
			if relSlash == prefix || strings.HasPrefix(relSlash, prefix+"/") {
				return true
			}
		}
	}
	return false
}

// isText skips binary files (NUL byte in the first 8KB).
func isText(data []byte) bool {
	n := len(data)
	if n > 8192 {
		n = 8192
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return false
		}
	}
	return true
}

// resolvePath is defined in read.go (shared workspace-relative join).
