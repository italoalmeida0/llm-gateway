package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

type PatchEdit struct {
	// File is workspace-relative (required).
	File string `json:"file"`
	// Old is the verbatim text to find (oldText mode) or regex (regex mode).
	Old string `json:"old"`
	// New is the replacement text ($1-style groups allowed in regex mode).
	New string `json:"new"`
	// Regex enables RE2 matching for Old.
	Regex bool `json:"regex,omitempty"`
	// ReplaceAll replaces every occurrence (default: first only).
	ReplaceAll bool `json:"replaceAll,omitempty"`
	// Anchor inserts New after the line matching Old instead of replacing
	// (Old is a regex or literal line matcher, New is inserted after it).
	Anchor bool `json:"anchor,omitempty"`
}

type PatchArgs struct {
	// Edits apply in order; later edits see earlier results.
	Edits []PatchEdit `json:"edits"`
	// DryRun previews diffs without writing (default true — pass false to apply).
	DryRun *bool `json:"dryRun,omitempty"`
}

type patchResult struct {
	file    string
	applied bool
	matches int
	diff    string
	err     string
}

// PatchTool is multi-file search/replace with dry-run preview. It kills the
// `python3 heredoc` pattern: instead of blind sed -i, the model sends edits,
// previews unified diffs (dryRun default true), then re-sends with dryRun
// false to apply. All-or-nothing per file; failures listed, never partial.
type PatchTool struct {
	CWD     string
	Sandbox *Sandbox
}

func (t *PatchTool) Name() string { return "patch" }

func (t *PatchTool) Description() string {
	return "Multi-file search/replace with dry-run preview. Params: `edits` [{file, old, new, regex?, replaceAll?, anchor?}], `dryRun` (default TRUE — preview diffs first, then re-send with false to apply). Verbatim, regex, or anchor-insert modes. All-or-nothing per file; binary files rejected."
}

const patchSchema = `{"type":"object","required":["edits"],"properties":{"edits":{"type":"array","items":{"type":"object","required":["file","old","new"],"properties":{"file":{"type":"string"},"old":{"type":"string"},"new":{"type":"string"},"regex":{"type":"boolean"},"replaceAll":{"type":"boolean"},"anchor":{"type":"boolean"}}}},"dryRun":{"type":"boolean","description":"Preview diffs without writing (default true)."}}}`

func (t *PatchTool) Schema() json.RawMessage { return json.RawMessage(patchSchema) }

func (t *PatchTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	var a PatchArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}
	if len(a.Edits) == 0 {
		return core.ToolResult{}, fmt.Errorf("patch: `edits` is required (non-empty)")
	}
	if len(a.Edits) > 50 {
		return core.ToolResult{}, fmt.Errorf("patch: max 50 edits per call (got %d)", len(a.Edits))
	}
	dryRun := true
	if a.DryRun != nil {
		dryRun = *a.DryRun
	}

	// Group edits per file (order preserved).
	order := []string{}
	byFile := map[string][]PatchEdit{}
	for _, e := range a.Edits {
		f := strings.TrimSpace(e.File)
		if f == "" {
			return core.ToolResult{}, fmt.Errorf("patch: edit missing `file`")
		}
		if e.Old == "" && !e.Anchor {
			return core.ToolResult{}, fmt.Errorf("patch: edit for %s missing `old`", f)
		}
		if _, ok := byFile[f]; !ok {
			order = append(order, f)
		}
		byFile[f] = append(byFile[f], e)
	}
	sort.Strings(order)

	var results []patchResult
	for _, f := range order {
		if ctx.Err() != nil {
			break
		}
		r := t.applyFile(f, byFile[f], dryRun)
		if r.err != "" && len(order) == 1 {
			return core.ToolResult{}, fmt.Errorf("patch: %s", r.err)
		}
		results = append(results, r)
	}

	var b strings.Builder
	if dryRun {
		b.WriteString("DRY RUN — no files written. Re-send with dryRun:false to apply.\n")
	} else {
		b.WriteString("APPLIED.\n")
	}
	for _, r := range results {
		if r.err != "" {
			fmt.Fprintf(&b, "\n✗ %s: %s\n", r.file, r.err)
			continue
		}
		mark := "✓"
		if dryRun {
			mark = "○"
		}
		fmt.Fprintf(&b, "\n%s %s (%d match%s)\n", mark, r.file, r.matches, plural(r.matches))
		if r.diff != "" {
			b.WriteString(r.diff)
			if !strings.HasSuffix(r.diff, "\n") {
				b.WriteString("\n")
			}
		}
	}
	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
	}, nil
}

func (t *PatchTool) applyFile(file string, edits []PatchEdit, dryRun bool) patchResult {
	abs := resolvePath(t.CWD, file)
	if err := t.Sandbox.CheckPath(abs); err != nil {
		return patchResult{file: file, err: fmt.Sprintf("invalid path: %v", err)}
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return patchResult{file: file, err: "cannot read file"}
	}
	if !isText(data) {
		return patchResult{file: file, err: "binary file rejected"}
	}
	if len(data) > 2*1024*1024 {
		return patchResult{file: file, err: "file too large (>2MB)"}
	}
	orig := string(data)
	cur := orig
	totalMatches := 0
	for i, e := range edits {
		next, n, err := applyOneEdit(cur, e)
		if err != nil {
			return patchResult{file: file, err: fmt.Sprintf("edit %d: %v", i+1, err)}
		}
		if n == 0 {
			return patchResult{file: file, err: fmt.Sprintf("edit %d: `old` not found", i+1)}
		}
		cur = next
		totalMatches += n
	}
	if cur == orig {
		return patchResult{file: file, err: "no changes"}
	}
	diff := patchDiff(slash(file), orig, cur)
	if !dryRun {
		st, err := os.Stat(abs)
		if err != nil {
			return patchResult{file: file, err: "cannot stat file"}
		}
		if err := os.WriteFile(abs, []byte(cur), st.Mode().Perm()); err != nil {
			return patchResult{file: file, err: fmt.Sprintf("write failed: %v", err)}
		}
	}
	return patchResult{file: slash(file), applied: !dryRun, matches: totalMatches, diff: diff}
}

func applyOneEdit(content string, e PatchEdit) (string, int, error) {
	if e.Anchor {
		return anchorInsert(content, e)
	}
	if e.Regex {
		re, err := regexp.Compile(e.Old)
		if err != nil {
			return "", 0, fmt.Errorf("invalid regex: %v", err)
		}
		locs := re.FindAllStringIndex(content, -1)
		if len(locs) == 0 {
			return content, 0, nil
		}
		if e.ReplaceAll {
			return re.ReplaceAllString(content, e.New), len(locs), nil
		}
		loc := locs[0]
		expanded := re.ReplaceAllString(content[loc[0]:loc[1]], e.New)
		return content[:loc[0]] + expanded + content[loc[1]:], 1, nil
	}
	n := strings.Count(content, e.Old)
	if n == 0 {
		return content, 0, nil
	}
	if e.ReplaceAll {
		return strings.ReplaceAll(content, e.Old, e.New), n, nil
	}
	return strings.Replace(content, e.Old, e.New, 1), 1, nil
}

// anchorInsert inserts New as new line(s) after the first line matching Old
// (literal substring, or regex when Regex=true).
func anchorInsert(content string, e PatchEdit) (string, int, error) {
	lines := strings.Split(content, "\n")
	var re *regexp.Regexp
	if e.Regex {
		var err error
		re, err = regexp.Compile(e.Old)
		if err != nil {
			return "", 0, fmt.Errorf("invalid anchor regex: %v", err)
		}
	}
	for i, ln := range lines {
		hit := strings.Contains(ln, e.Old)
		if e.Regex {
			hit = re.MatchString(ln)
		}
		if hit {
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[:i+1]...)
			out = append(out, e.New)
			out = append(out, lines[i+1:]...)
			return strings.Join(out, "\n"), 1, nil
		}
	}
	return content, 0, nil
}

// patchDiff reuses the shared unified diff renderer from edit.go (with file
// headers), so patch previews look identical to edit results.
func patchDiff(file, before, after string) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "--- %s\n+++ %s\n", file, file)
	sb.WriteString(DiffText(before, after))
	return sb.String()
}
