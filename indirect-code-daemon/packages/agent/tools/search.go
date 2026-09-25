package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/ignore"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type SearchArgs struct {
	// Pattern is always an RE2 regular expression.
	Pattern string `json:"pattern"`
	// Path scopes the search (workspace-relative file or dir, default ".").
	Path string `json:"path,omitempty"`
	// Include limits files by glob(s), e.g. ["*.ts", "*.tsx"].
	Include []string `json:"include,omitempty"`
	// Exclude skips files by glob(s), e.g. ["dist/**", "*.min.js"].
	Exclude []string `json:"exclude,omitempty"`
	// MaxResults caps returned matches (default 50, max 200).
	MaxResults int `json:"maxResults,omitempty"`
	// ContextLines includes N lines before/after each match (default 0, max 20).
	ContextLines int `json:"contextLines,omitempty"`
	// CaseSensitive enables case-sensitive matching (default false).
	CaseSensitive bool `json:"caseSensitive,omitempty"`
	// OnlyMatching returns only the matched substrings per line (grep -o):
	// one entry per match with col pointing at the match start instead of
	// one entry per matching line.
	OnlyMatching bool `json:"onlyMatching,omitempty"`
	// Count returns per-file match counts instead of individual matches
	// (grep -c): one "file: N matches" line per file with matches.
	Count bool `json:"count,omitempty"`
	// FilesOnly returns only file paths with at least one match (grep -l),
	// one path per line, no line/col/text.
	FilesOnly bool `json:"filesOnly,omitempty"`
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
	return "Search file contents with an RE2 regular expression. Params: `pattern` (required regex), `path` (file/dir scope, default '.'), `include`/`exclude` globs, `maxResults` (default 50, max 200), `contextLines` (default 0, max 20), `caseSensitive` (default false), `onlyMatching` (grep -o: one entry per match), `count` (grep -c: per-file counts), `filesOnly` (grep -l: paths only), `respectGitignore` (default true). Returns structured matches [{file, line, col, text}] — open hits with read."
}

const searchSchema = `{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string","description":"RE2 regular expression to find."},"path":{"type":"string","description":"Workspace-relative file or dir scope (default '.')."},"include":{"type":"array","items":{"type":"string"},"description":"File glob patterns to include (e.g. ['*.ts', '*.tsx'])."},"exclude":{"type":"array","items":{"type":"string"},"description":"File glob patterns to exclude (e.g. ['dist/**', '*.min.js'])."},"maxResults":{"type":"number","description":"Maximum number of matches to return (default 50, max 200)."},"contextLines":{"type":"number","description":"Number of context lines before and after each match (default 0, max 20)."},"caseSensitive":{"type":"boolean","description":"Case-sensitive search (default false)."},"onlyMatching":{"type":"boolean","description":"Return only the matched substrings, one entry per match (grep -o)."},"count":{"type":"boolean","description":"Return per-file match counts instead of matches (grep -c)."},"filesOnly":{"type":"boolean","description":"Return only matching file paths, one per line (grep -l)."},"respectGitignore":{"type":"boolean","description":"Skip files ignored by git (default true)."},"maxFileBytes":{"type":"number","description":"Skip files larger than this size in bytes (default 1MB)."}}}`

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
	if ctxLines > 20 {
		ctxLines = 20
	}
	// count/filesOnly are aggregate modes: context and per-match text add
	// nothing, so they are ignored there (no error — permissive parsing).
	if a.Count || a.FilesOnly {
		ctxLines = 0
	}
	maxBytes := a.MaxFileBytes
	if maxBytes <= 0 {
		maxBytes = 1024 * 1024
	}
	respectIgnore := true
	if a.RespectGitignore != nil {
		respectIgnore = *a.RespectGitignore
	}

	// Compile matcher: pattern is always an RE2 regex.
	src := pattern
	if !a.CaseSensitive {
		src = "(?i)" + src
	}
	re, err := regexp.Compile(src)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("search: invalid regex: %v", err)
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

	include, exclude := compileGlobFilter(a.Include, true), compileGlobFilter(a.Exclude, false)

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
			if !include(rel) {
				return nil
			}
			if exclude(rel) {
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
	// counts/files accumulate aggregate modes (grep -c / grep -l).
	counts := map[string]int{}
	var countOrder []string
	var filesOnly []string
	filesSeen := map[string]bool{}
	truncated := false
outer:
	for _, f := range files {
		if ctx.Err() != nil {
			return core.ToolResult{}, ctx.Err()
		}
		if err := t.Sandbox.CheckReadPath(f); err != nil {
			continue
		}
		info, err := os.Stat(f)
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxBytes {
			continue
		}
		rel, _ := filepath.Rel(t.CWD, f)
		data, err := readSearchFile(f, maxBytes)
		if err != nil {
			continue
		}
		if !isText(data) {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for i, ln := range lines {
			if ctx.Err() != nil {
				return core.ToolResult{}, ctx.Err()
			}
			if a.Count {
				if n := len(re.FindAllStringIndex(ln, -1)); n > 0 {
					if counts[slash(rel)] == 0 {
						countOrder = append(countOrder, slash(rel))
					}
					counts[slash(rel)] += n
				}
				continue
			}
			if a.FilesOnly {
				if re.MatchString(ln) && !filesSeen[slash(rel)] {
					filesSeen[slash(rel)] = true
					filesOnly = append(filesOnly, slash(rel))
					if len(filesOnly) >= maxResults {
						truncated = true
						break outer
					}
					break
				}
				continue
			}
			if a.OnlyMatching {
				for _, loc := range re.FindAllStringIndex(ln, -1) {
					m := SearchMatch{File: slash(rel), Line: i + 1, Col: loc[0] + 1, Text: trimLine(ln[loc[0]:loc[1]])}
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
				continue
			}
			loc := re.FindStringIndex(ln)
			if loc == nil {
				continue
			}
			m := SearchMatch{File: slash(rel), Line: i + 1, Col: loc[0] + 1, Text: trimLine(ln)}
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
	if a.Count {
		total := 0
		for _, f := range countOrder {
			total += counts[f]
		}
		fmt.Fprintf(&b, "%d match%s in %d file%s\n", total, plural(total), len(countOrder), filePlural(len(countOrder)))
		for i, f := range countOrder {
			if i >= maxResults {
				truncated = true
				break
			}
			fmt.Fprintf(&b, "%s: %d match%s\n", f, counts[f], plural(counts[f]))
		}
		if len(countOrder) == 0 {
			b.WriteString("(no matches)")
		}
		if truncated {
			fmt.Fprintf(&b, "(capped at %d — narrow `path` or `include`)", maxResults)
		}
		return core.ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: b.String()}},
			},
			nil
	}
	if a.FilesOnly {
		fmt.Fprintf(&b, "%d file%s\n", len(filesOnly), plural(len(filesOnly)))
		for _, f := range filesOnly {
			fmt.Fprintf(&b, "%s\n", f)
		}
		if len(filesOnly) == 0 {
			b.WriteString("(no matches)")
		}
		if truncated {
			fmt.Fprintf(&b, "(capped at %d — narrow `path` or `include`)", maxResults)
		}
		return core.ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: b.String()}},
			},
			nil
	}

	var nb strings.Builder
	fmt.Fprintf(&nb, "%d match%s", len(matches), plural(len(matches)))
	if truncated {
		fmt.Fprintf(&nb, " (capped at %d — narrow `path` or `include`)", maxResults)
	}
	nb.WriteString("\n")
	for _, m := range matches {
		fmt.Fprintf(&nb, "%s:%d:%d: %s\n", m.File, m.Line, m.Col, m.Text)
		for _, c := range m.Context {
			fmt.Fprintf(&nb, "  %s\n", c)
		}
	}
	if len(matches) == 0 {
		nb.WriteString("(no matches)")
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: nb.String()}},
	}, nil
}

func slash(p string) string { return filepath.ToSlash(p) }

func trimLine(s string) string {
	s = strings.TrimRight(s, "\r")
	if len(s) > 300 {
		end := 300
		for end > 0 && !utf8.RuneStart(s[end]) {
			end--
		}
		return s[:end] + "…"
	}
	return s
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "es"
}

func filePlural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// compileGlobFilter compiles once per tool call, not once per visited file.
// Slash-separated patterns share glob's semantics on every OS.
func compileGlobFilter(patterns []string, allowEmpty bool) func(string) bool {
	type pattern struct {
		re       *regexp.Regexp
		hasSlash bool
		prefix   string
	}
	var compiled []pattern
	for _, pat := range patterns {
		re, hasSlash, err := compileGlob(pat)
		if err != nil {
			continue
		}
		prefix := ""
		normalized := filepath.ToSlash(strings.TrimSpace(pat))
		if strings.HasSuffix(normalized, "/**") {
			prefix = strings.TrimSuffix(normalized, "/**")
		}
		compiled = append(compiled, pattern{re, hasSlash, prefix})
	}
	return func(rel string) bool {
		if len(patterns) == 0 {
			return allowEmpty
		}
		relSlash, base := slash(rel), slash(filepath.Base(rel))
		for _, pat := range compiled {
			target := base
			if pat.hasSlash {
				target = relSlash
			}
			if pat.re.MatchString(target) || (pat.prefix != "" && relSlash == pat.prefix) {
				return true
			}
		}
		return false
	}
}

// Bound reads even if a file grows between Stat and Open.
func readSearchFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit))
	if err != nil {
		return nil, err
	}
	var extra [1]byte
	if n, err := f.Read(extra[:]); n != 0 || err != io.EOF {
		return nil, fmt.Errorf("search: file exceeds size limit or cannot be read")
	}
	return data, nil
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
