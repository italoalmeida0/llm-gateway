package tools

import (
	"bytes"
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

// EditTool applies exact-match substitutions or line-based edits across one or more files.
type EditTool struct {
	CWD     string
	Sandbox *Sandbox
}

type EditOp struct {
	// File is workspace-relative (required if path not set at top level).
	File string `json:"file,omitempty"`
	Path string `json:"path,omitempty"`

	// Text-based replacement:
	Old        string `json:"old,omitempty"`
	OldText    string `json:"oldText,omitempty"`
	New        string `json:"new,omitempty"`
	NewText    string `json:"newText,omitempty"`
	NewContent string `json:"newContent,omitempty"`

	// Line-based replacement (1-indexed):
	Line    int `json:"line,omitempty"`
	EndLine int `json:"endLine,omitempty"`

	// Match options (for text-based replacement):
	Regex      bool `json:"regex,omitempty"`
	ReplaceAll bool `json:"replaceAll,omitempty"`
	Anchor     bool `json:"anchor,omitempty"`
}

type EditArgs struct {
	// Optional top-level path/file if all edits apply to the same file.
	Path string `json:"path,omitempty"`
	File string `json:"file,omitempty"`

	// Edits apply in order; later edits see earlier results.
	Edits []EditOp `json:"edits,omitempty"`

	// Convenience top-level fields for a single edit:
	Line       int    `json:"line,omitempty"`
	EndLine    int    `json:"endLine,omitempty"`
	NewContent string `json:"newContent,omitempty"`
	Old        string `json:"old,omitempty"`
	OldText    string `json:"oldText,omitempty"`
	New        string `json:"new,omitempty"`
	NewText    string `json:"newText,omitempty"`
	Regex      bool   `json:"regex,omitempty"`
	ReplaceAll bool   `json:"replaceAll,omitempty"`
	Anchor     bool   `json:"anchor,omitempty"`

	// DryRun previews diffs without writing (default false).
	DryRun *bool `json:"dryRun,omitempty"`
}

type fileEditResult struct {
	file    string
	applied bool
	matches int
	diff    string
	aiDiff  string
	err     string
}

const editSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Optional file to modify, given as an absolute path or relative to the working directory."},"file":{"type":"string","description":"Alias for path."},"edits":{"type":"array","description":"A list of edit operations to apply in order.","items":{"type":"object","properties":{"file":{"type":"string","description":"File to modify (required if not set at top level)."},"path":{"type":"string","description":"Alias for file."},"line":{"type":"integer","description":"1-indexed line number to replace (e.g. line: 2, newContent: \"...\")."},"endLine":{"type":"integer","description":"1-indexed end line number for range replacement (inclusive). Default is line."},"newContent":{"type":"string","description":"Content that replaces the specified line(s)."},"old":{"type":"string","description":"A verbatim excerpt from the file being modified. Include enough surrounding text to identify exactly one location."},"oldText":{"type":"string","description":"A verbatim excerpt from the file being modified (alias for old)."},"new":{"type":"string","description":"Content that will replace the matched excerpt."},"newText":{"type":"string","description":"Alias for new."},"regex":{"type":"boolean","description":"Treat old as RE2 regex ($1 groups in new)."},"replaceAll":{"type":"boolean","description":"Replace every match instead of requiring a unique one."},"anchor":{"type":"boolean","description":"Insert new after the line matching old instead of replacing."}}}},"line":{"type":"integer","description":"Convenience 1-indexed line number for single edit without edits array."},"endLine":{"type":"integer","description":"Convenience 1-indexed end line number."},"newContent":{"type":"string","description":"Convenience replacement content for line edit."},"old":{"type":"string","description":"Convenience verbatim excerpt from the file for single edit."},"oldText":{"type":"string","description":"Alias for old."},"new":{"type":"string","description":"Convenience replacement content for matched excerpt."},"newText":{"type":"string","description":"Alias for new."},"regex":{"type":"boolean","description":"Treat old as RE2 regex ($1 groups in new)."},"replaceAll":{"type":"boolean","description":"Replace every match instead of requiring a unique one."},"anchor":{"type":"boolean","description":"Insert new after the line matching old instead of replacing."},"dryRun":{"type":"boolean","description":"Preview diffs without writing (default false)."}}}`

func (t *EditTool) Name() string { return "edit" }

func (t *EditTool) Description() string {
	return "Apply exact substitutions or line-based edits to files (verbatim default; line:N for line replacement; regex:true for patterns; replaceAll:true for mass rename). Inspect that file before editing and take every oldText directly from its current contents. Use short excerpts that identify one location; choose write when replacing most or all of a file. Pass dryRun:true to preview diffs without writing (default false). Edits apply across one or more files in edits list or via top-level single-edit parameters."
}

func (t *EditTool) Schema() json.RawMessage { return json.RawMessage(editSchema) }

// Preview validates the edit against current files and returns the diff without writing.
func (t *EditTool) Preview(ctx context.Context, raw json.RawMessage) (core.ToolResult, error) {
	return t.executeInternal(ctx, raw, true, nil)
}

func (t *EditTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	return t.executeInternal(ctx, raw, false, progress)
}

func (t *EditTool) executeInternal(ctx context.Context, raw json.RawMessage, isPreview bool, progress func(string)) (core.ToolResult, error) {
	var a EditArgs
	if err := unmarshalArgs(raw, &a); err != nil {
		return core.ToolResult{}, fmt.Errorf("invalid args: %w", err)
	}

	// Synthesize edits if provided at top-level
	if len(a.Edits) == 0 && (a.Line > 0 || a.Old != "" || a.OldText != "" || a.NewContent != "") {
		a.Edits = []EditOp{{
			File:       a.File,
			Path:       a.Path,
			Line:       a.Line,
			EndLine:    a.EndLine,
			NewContent: a.NewContent,
			Old:        a.Old,
			OldText:    a.OldText,
			New:        a.New,
			NewText:    a.NewText,
			Regex:      a.Regex,
			ReplaceAll: a.ReplaceAll,
			Anchor:     a.Anchor,
		}}
	}

	if len(a.Edits) == 0 {
		return core.ToolResult{}, fmt.Errorf("edit: at least one edit is required")
	}
	if len(a.Edits) > 50 {
		return core.ToolResult{}, fmt.Errorf("edit: max 50 edits per call (got %d)", len(a.Edits))
	}

	dryRun := false
	if a.DryRun != nil {
		dryRun = *a.DryRun
	}
	if isPreview {
		dryRun = true
	}

	topFile := strings.TrimSpace(a.Path)
	if topFile == "" {
		topFile = strings.TrimSpace(a.File)
	}

	for i := range a.Edits {
		f := strings.TrimSpace(a.Edits[i].File)
		if f == "" {
			f = strings.TrimSpace(a.Edits[i].Path)
		}
		if f == "" {
			f = topFile
		}
		if f == "" {
			return core.ToolResult{}, fmt.Errorf("edit %d: missing file path", i+1)
		}
		a.Edits[i].File = f

		oldText := a.Edits[i].Old
		if oldText == "" {
			oldText = a.Edits[i].OldText
		}
		if a.Edits[i].Line <= 0 && oldText == "" && !a.Edits[i].Anchor {
			return core.ToolResult{}, fmt.Errorf("edit %d: old or line is required", i+1)
		}
		newVal := a.Edits[i].New
		if newVal == "" && a.Edits[i].NewContent != "" {
			newVal = a.Edits[i].NewContent
		}
		if newVal == "" && a.Edits[i].NewText != "" {
			newVal = a.Edits[i].NewText
		}
		if a.Edits[i].Line <= 0 && oldText == newVal && !a.Edits[i].Regex {
			return core.ToolResult{}, fmt.Errorf("edit %d: oldText equals newText", i+1)
		}
	}

	// Group edits per file (order preserved).
	order := []string{}
	byFile := map[string][]EditOp{}
	for _, e := range a.Edits {
		f := e.File
		if _, ok := byFile[f]; !ok {
			order = append(order, f)
		}
		byFile[f] = append(byFile[f], e)
	}
	sort.Strings(order)

	var results []fileEditResult
	for _, f := range order {
		if ctx.Err() != nil {
			break
		}
		r := t.applyFile(f, byFile[f], dryRun)
		if r.err != "" && len(order) == 1 {
			return core.ToolResult{}, fmt.Errorf("%s", r.err)
		}
		results = append(results, r)
	}

	var b strings.Builder
	b.WriteString(LinePrefixNotice)
	if dryRun && !isPreview {
		b.WriteString("DRY RUN — no files written. Re-send with dryRun:false to apply.\n")
	} else if !dryRun || isPreview {
		b.WriteString("APPLIED.\n")
	}

	for _, r := range results {
		if r.err != "" {
			fmt.Fprintf(&b, "\n✗ %s: %s\n", r.file, r.err)
			continue
		}
		mark := "✓"
		if dryRun && !isPreview {
			mark = "○"
		}
		fmt.Fprintf(&b, "\n%s %s (%d match%s)\n", mark, r.file, r.matches, plural(r.matches))
		if r.aiDiff != "" {
			b.WriteString(r.aiDiff)
			if !strings.HasSuffix(r.aiDiff, "\n") {
				b.WriteString("\n")
			}
		}
	}

	details := map[string]any{
		"dryRun": dryRun,
		"edits":  len(a.Edits),
		"files":  order,
	}
	if len(results) == 1 {
		details["path"] = resolvePath(t.CWD, results[0].file)
		details["diff"] = results[0].diff
	}

	return core.ToolResult{
		Content: []provider.Content{provider.TextBlock{Text: b.String()}},
		Details: details,
	}, nil
}

func (t *EditTool) applyFile(file string, edits []EditOp, dryRun bool) fileEditResult {
	abs := resolvePath(t.CWD, file)
	if t.Sandbox != nil {
		if err := t.Sandbox.CheckWritePath(abs); err != nil {
			return fileEditResult{file: file, err: fmt.Sprintf("invalid path: %v", err)}
		}
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return fileEditResult{file: file, err: fmt.Sprintf("cannot read file: %v", err)}
	}
	if !isText(data) {
		return fileEditResult{file: file, err: "binary file rejected"}
	}
	if len(data) > 2*1024*1024 {
		return fileEditResult{file: file, err: "file too large (>2MB)"}
	}

	orig := string(data)
	cur := orig
	totalMatches := 0
	for i, e := range edits {
		var next string
		var n int
		var editErr error
		if e.Line > 0 {
			next, n, editErr = applyLineEdit(cur, e)
		} else {
			next, n, editErr = applyTextEdit(cur, e)
		}
		if editErr != nil {
			return fileEditResult{file: file, err: fmt.Sprintf("edit %d: %v", i+1, editErr)}
		}
		if n == 0 {
			oldText := e.Old
			if oldText == "" {
				oldText = e.OldText
			}
			return fileEditResult{file: file, err: fmt.Sprintf("edit %d: oldText not found in %s; inspect that file again and use a verbatim excerpt with matching spaces and line breaks", i+1, file)}
		}
		cur = next
		totalMatches += n
	}
	if cur == orig {
		return fileEditResult{file: file, err: "no changes"}
	}

	origNorm := strings.ReplaceAll(orig, "\r\n", "\n")
	curNorm := strings.ReplaceAll(cur, "\r\n", "\n")
	diff := patchDiff(slash(file), origNorm, curNorm)
	aiDiff := patchDiffNumbered(slash(file), origNorm, curNorm)

	if !dryRun {
		st, err := os.Stat(abs)
		mode := os.FileMode(0o644)
		if err == nil {
			mode = st.Mode().Perm()
		}
		if err := os.WriteFile(abs, []byte(cur), mode); err != nil {
			return fileEditResult{file: file, err: fmt.Sprintf("write failed: %v", err)}
		}
	}
	return fileEditResult{file: slash(file), applied: !dryRun, matches: totalMatches, diff: diff, aiDiff: aiDiff}
}

func applyLineEdit(content string, e EditOp) (string, int, error) {
	nl := "\n"
	if strings.Contains(content, "\r\n") {
		nl = "\r\n"
	}
	hasTrailingNewline := strings.HasSuffix(content, "\n")

	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	if hasTrailingNewline && len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	totalLines := len(lines)
	if totalLines == 0 && e.Line == 1 {
		newText := e.NewContent
		if newText == "" {
			newText = e.New
		}
		if newText == "" {
			newText = e.NewText
		}
		newNorm := strings.ReplaceAll(newText, "\r\n", "\n")
		var newLines []string
		if newText != "" {
			newLines = strings.Split(newNorm, "\n")
		}
		res := strings.Join(newLines, nl)
		if hasTrailingNewline && len(newLines) > 0 {
			res += nl
		}
		return res, 1, nil
	}

	if e.Line < 1 || e.Line > totalLines {
		return content, 0, fmt.Errorf("line %d out of range (file has %d lines)", e.Line, totalLines)
	}

	endLine := e.Line
	if e.EndLine > 0 {
		if e.EndLine < e.Line {
			return content, 0, fmt.Errorf("endLine %d cannot be less than line %d", e.EndLine, e.Line)
		}
		if e.EndLine > totalLines {
			return content, 0, fmt.Errorf("endLine %d out of range (file has %d lines)", e.EndLine, totalLines)
		}
		endLine = e.EndLine
	}

	startIdx := e.Line - 1
	endIdx := endLine

	oldExpected := e.Old
	if oldExpected == "" {
		oldExpected = e.OldText
	}
	if oldExpected != "" {
		actualLines := lines[startIdx:endIdx]
		actualText := strings.Join(actualLines, "\n")
		actualNorm := strings.TrimSpace(actualText)
		expNorm := strings.TrimSpace(strings.ReplaceAll(oldExpected, "\r\n", "\n"))
		expStripped := strings.TrimSpace(stripLinePrefix(expNorm, e.Line))
		if actualNorm != expNorm && actualNorm != expStripped {
			return content, 0, fmt.Errorf("line %d content %q does not match expected old %q", e.Line, actualText, oldExpected)
		}
	}

	newText := e.NewContent
	if newText == "" {
		newText = e.New
	}
	if newText == "" {
		newText = e.NewText
	}

	newNorm := strings.ReplaceAll(newText, "\r\n", "\n")
	var newLines []string
	if newText != "" {
		newLines = strings.Split(newNorm, "\n")
	}

	out := make([]string, 0, len(lines)-(endIdx-startIdx)+len(newLines))
	out = append(out, lines[:startIdx]...)
	out = append(out, newLines...)
	out = append(out, lines[endIdx:]...)

	res := strings.Join(out, nl)
	if hasTrailingNewline && len(out) > 0 {
		res += nl
	}
	return res, 1, nil
}

func stripLinePrefix(s string, lineNum int) string {
	prefix := fmt.Sprintf("%d:", lineNum)
	if strings.HasPrefix(s, prefix) {
		return strings.TrimPrefix(s, prefix)
	}
	return s
}

func applyTextEdit(content string, e EditOp) (string, int, error) {
	oldText := e.Old
	if oldText == "" {
		oldText = e.OldText
	}
	newText := e.New
	if newText == "" && e.NewContent != "" {
		newText = e.NewContent
	}
	if newText == "" && e.NewText != "" {
		newText = e.NewText
	}

	if e.Anchor {
		return anchorInsert(content, oldText, newText, e.Regex)
	}

	if e.Regex {
		re, err := regexp.Compile(oldText)
		if err != nil {
			return "", 0, fmt.Errorf("invalid regex: %v", err)
		}
		locs := re.FindAllStringIndex(content, -1)
		if len(locs) == 0 {
			return content, 0, nil
		}
		if len(locs) > 1 && !e.ReplaceAll {
			return "", 0, fmt.Errorf("regex matches %d times (must be unique or set replaceAll)", len(locs))
		}
		if e.ReplaceAll {
			return re.ReplaceAllString(content, newText), len(locs), nil
		}
		loc := locs[0]
		expanded := re.ReplaceAllString(content[loc[0]:loc[1]], newText)
		return content[:loc[0]] + expanded + content[loc[1]:], 1, nil
	}

	count := strings.Count(content, oldText)
	if count == 0 {
		return content, 0, nil
	}
	if count > 1 && !e.ReplaceAll {
		return "", 0, fmt.Errorf("oldText matches %d times (must be unique or set replaceAll)", count)
	}
	if e.ReplaceAll {
		return strings.ReplaceAll(content, oldText, newText), count, nil
	}
	return strings.Replace(content, oldText, newText, 1), 1, nil
}

func anchorInsert(content, oldText, newText string, isRegex bool) (string, int, error) {
	lines := strings.Split(content, "\n")
	var re *regexp.Regexp
	if isRegex {
		var err error
		re, err = regexp.Compile(oldText)
		if err != nil {
			return "", 0, fmt.Errorf("invalid anchor regex: %v", err)
		}
	}
	for i, ln := range lines {
		hit := strings.Contains(ln, oldText)
		if isRegex {
			hit = re.MatchString(ln)
		}
		if hit {
			out := make([]string, 0, len(lines)+1)
			out = append(out, lines[:i+1]...)
			out = append(out, newText)
			out = append(out, lines[i+1:]...)
			return strings.Join(out, "\n"), 1, nil
		}
	}
	return content, 0, nil
}

func patchDiff(file, before, after string) string {
	_ = file
	return DiffText(before, after)
}

func patchDiffNumbered(file, before, after string) string {
	_ = file
	return DiffTextNumbered(before, after)
}


func detectLineEnding(b []byte) string {
	if bytes.Contains(b, []byte("\r\n")) {
		return "\r\n"
	}
	return "\n"
}

// diffContextLines is the number of unchanged lines kept on each
// side of an edit when rendering the diff. 3 is the git-diff
// default and balances readability with transcript size.
const diffContextLines = 3

// unifiedDiff emits a context diff for the edit tool's result.
//
// Shape: each output row is either
//   - " <line>"       unchanged context
//   - "-<line>"       deletion (from a)
//   - "+<line>"       addition (to b)
//   - "..."           context break between hunks
//
// The legacy "--- name / +++ name" header is omitted because the
// tool-call header above the result already shows the path. Only
// lines within diffContextLines of a +/- row are kept; longer
// runs of unchanged content collapse into a single "..." row so
// a one-line edit in a thousand-line file produces a short
// transcript.
// DiffText is shared by edit results and the host's pending-change review.
func DiffText(a, b string) string { return unifiedDiff("", a, b) }

func unifiedDiff(name, a, b string) string {
	if a == b {
		return ""
	}
	aLines := strings.Split(a, "\n")
	bLines := strings.Split(b, "\n")
	ops := diffLines(aLines, bLines)

	// Mark ops that sit within diffContextLines of any +/- op.
	keep := make([]bool, len(ops))
	for i, op := range ops {
		if op.kind == '+' || op.kind == '-' {
			keep[i] = true
			for d := 1; d <= diffContextLines; d++ {
				if i-d >= 0 {
					keep[i-d] = true
				}
				if i+d < len(ops) {
					keep[i+d] = true
				}
			}
		}
	}

	var sb strings.Builder
	prevKept := false
	anyOutput := false
	for i, op := range ops {
		if !keep[i] {
			if prevKept {
				sb.WriteString("...\n")
				prevKept = false
			}
			continue
		}
		if !prevKept && anyOutput {
			sb.WriteString("...\n")
		}
		switch op.kind {
		case ' ':
			fmt.Fprintf(&sb, " %s\n", op.line)
		case '-':
			fmt.Fprintf(&sb, "-%s\n", op.line)
		case '+':
			fmt.Fprintf(&sb, "+%s\n", op.line)
		}
		prevKept = true
		anyOutput = true
	}
	_ = name // header dropped; kept in signature for call-site stability
	return sb.String()
}

// DiffTextNumbered returns a context diff with 1-indexed line numbers (<number>:)
// for AI model consumption.
func DiffTextNumbered(a, b string) string { return unifiedDiffNumbered("", a, b) }

func unifiedDiffNumbered(name, a, b string) string {
	if a == b {
		return ""
	}
	aLines := strings.Split(a, "\n")
	bLines := strings.Split(b, "\n")
	ops := diffLines(aLines, bLines)

	keep := make([]bool, len(ops))
	for i, op := range ops {
		if op.kind == '+' || op.kind == '-' {
			keep[i] = true
			for d := 1; d <= diffContextLines; d++ {
				if i-d >= 0 {
					keep[i-d] = true
				}
				if i+d < len(ops) {
					keep[i+d] = true
				}
			}
		}
	}

	var sb strings.Builder
	prevKept := false
	anyOutput := false
	lineA := 0
	lineB := 0
	for i, op := range ops {
		switch op.kind {
		case ' ':
			lineA++
			lineB++
		case '-':
			lineA++
		case '+':
			lineB++
		}
		if !keep[i] {
			if prevKept {
				sb.WriteString("...\n")
				prevKept = false
			}
			continue
		}
		if !prevKept && anyOutput {
			sb.WriteString("...\n")
		}
		switch op.kind {
		case ' ':
			fmt.Fprintf(&sb, "%d: %s\n", lineA, op.line)
		case '-':
			fmt.Fprintf(&sb, "%d:-%s\n", lineA, op.line)
		case '+':
			fmt.Fprintf(&sb, "%d:+%s\n", lineB, op.line)
		}
		prevKept = true
		anyOutput = true
	}
	_ = name
	return sb.String()
}

type diffOp struct {
	kind byte
	line string
}

func diffLines(a, b []string) []diffOp {
	// LCS table.
	m, n := len(a), len(b)
	// Bound memory for large rewrites. Retain common ends and display the
	// changed middle as a replacement when a full LCS would be too expensive.
	if int64(m)*int64(n) > 2_000_000 {
		prefix, suffix := 0, 0
		for prefix < m && prefix < n && a[prefix] == b[prefix] {
			prefix++
		}
		for suffix < m-prefix && suffix < n-prefix && a[m-1-suffix] == b[n-1-suffix] {
			suffix++
		}
		ops := make([]diffOp, 0, m+n)
		for _, line := range a[:prefix] {
			ops = append(ops, diffOp{' ', line})
		}
		for _, line := range a[prefix : m-suffix] {
			ops = append(ops, diffOp{'-', line})
		}
		for _, line := range b[prefix : n-suffix] {
			ops = append(ops, diffOp{'+', line})
		}
		for _, line := range a[m-suffix:] {
			ops = append(ops, diffOp{' ', line})
		}
		return ops
	}
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	for i := 0; i < m; i++ {
		for j := 0; j < n; j++ {
			if a[i] == b[j] {
				dp[i+1][j+1] = dp[i][j] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i+1][j+1] = dp[i+1][j]
			} else {
				dp[i+1][j+1] = dp[i][j+1]
			}
		}
	}
	// Backtrack.
	var ops []diffOp
	i, j := m, n
	for i > 0 && j > 0 {
		if a[i-1] == b[j-1] {
			ops = append(ops, diffOp{' ', a[i-1]})
			i--
			j--
		} else if dp[i][j-1] >= dp[i-1][j] {
			ops = append(ops, diffOp{'+', b[j-1]})
			j--
		} else {
			ops = append(ops, diffOp{'-', a[i-1]})
			i--
		}
	}
	for i > 0 {
		ops = append(ops, diffOp{'-', a[i-1]})
		i--
	}
	for j > 0 {
		ops = append(ops, diffOp{'+', b[j-1]})
		j--
	}
	for i, j := 0, len(ops)-1; i < j; i, j = i+1, j-1 {
		ops[i], ops[j] = ops[j], ops[i]
	}
	return ops
}
