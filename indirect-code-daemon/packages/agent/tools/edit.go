package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// EditTool edits a single file using exact text replacement, mirroring pi's
// edit tool: every edits[].oldText must match a unique, non-overlapping region
// of the ORIGINAL file (edits are not applied incrementally), with fuzzy
// matching (trailing whitespace / smart quotes / dashes / special spaces
// normalization) as a fallback when an exact match fails.
type EditTool struct {
	CWD     string
	Sandbox *Sandbox
	Changes ChangeTracker
}

// piEdit is one targeted replacement, exactly like pi's replaceEditSchema.
type piEdit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

type editArgs struct {
	Path  string   `json:"path"`
	Edits []piEdit `json:"edits"`
}

const editSchema = `{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to edit (relative or absolute)"},"edits":{"type":"array","description":"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.","items":{"type":"object","properties":{"oldText":{"type":"string","description":"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},"newText":{"type":"string","description":"Replacement text for this targeted edit."}},"required":["oldText","newText"]}}},"required":["path","edits"]}`

func (t *EditTool) Name() string { return "edit" }
func (t *EditTool) Description() string {
	// Mirrors pi's edit tool description.
	return "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes."
}
func (t *EditTool) Schema() json.RawMessage { return json.RawMessage(editSchema) }

// Preview validates the edit against current files and returns the diff without writing.
func (t *EditTool) Preview(ctx context.Context, raw json.RawMessage) (core.ToolResult, error) {
	return t.executeInternal(ctx, raw, true, nil)
}

func (t *EditTool) Execute(ctx context.Context, raw json.RawMessage, progress func(string)) (core.ToolResult, error) {
	return t.executeInternal(ctx, raw, false, progress)
}

// prepareEditArguments mirrors pi's prepareEditArguments: some models send
// edits as a JSON string instead of an array, or a single edit object. All
// shapes are normalized into the canonical {path, edits[]} form.
func prepareEditArguments(raw json.RawMessage) (editArgs, error) {
	var generic map[string]json.RawMessage
	if err := json.Unmarshal(raw, &generic); err != nil {
		return editArgs{}, fmt.Errorf("invalid args: %w", err)
	}

	var a editArgs
	if v, ok := generic["path"]; ok {
		_ = json.Unmarshal(v, &a.Path)
	}

	if editsRaw, ok := generic["edits"]; ok {
		// edits as JSON string (Opus/GLM style degenerate input).
		var s string
		if err := json.Unmarshal(editsRaw, &s); err == nil {
			trimmed := strings.TrimSpace(s)
			if trimmed != "" {
				var arr []piEdit
				if err := json.Unmarshal([]byte(trimmed), &arr); err == nil && len(arr) > 0 {
					a.Edits = append(a.Edits, arr...)
				} else {
					var one piEdit
					if err := json.Unmarshal([]byte(trimmed), &one); err == nil && (one.OldText != "" || one.NewText != "") {
						a.Edits = append(a.Edits, one)
					}
				}
				// Unparseable string: leave empty; validation below reports
				// it with pi's message (validateEditInput equivalent).
			}
		} else if err := json.Unmarshal(editsRaw, &a.Edits); err == nil {
			// edits as array.
		} else {
			// edits as a single edit object.
			var one piEdit
			if err := json.Unmarshal(editsRaw, &one); err == nil && (one.OldText != "" || one.NewText != "") {
				a.Edits = append(a.Edits, one)
			}
			// Any other shape: leave empty; validation below reports it.
		}
	}
	return a, nil
}

func (t *EditTool) executeInternal(ctx context.Context, raw json.RawMessage, isPreview bool, progress func(string)) (core.ToolResult, error) {
	a, err := prepareEditArguments(raw)
	if err != nil {
		return core.ToolResult{}, err
	}
	if a.Path == "" {
		return core.ToolResult{}, fmt.Errorf("path is required")
	}
	if len(a.Edits) == 0 {
		// Mirrors pi's validateEditInput.
		return core.ToolResult{}, fmt.Errorf("Edit tool input is invalid. edits must contain at least one replacement.")
	}

	path := a.Path
	abs := resolvePath(t.CWD, path)
	if err := t.Sandbox.CheckWritePath(abs); err != nil {
		return core.ToolResult{}, err
	}

	// Check if file exists and is readable/writable. Mirrors pi's error text.
	if _, err := os.Stat(abs); err != nil {
		return core.ToolResult{}, fmt.Errorf("Could not edit file: %s. %s.", path, err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("Could not edit file: %s. %s.", path, err)
	}
	// Daemon safety rails (pi reads any file; these guards keep pathological
	// inputs from corrupting binary files or burning daemon memory).
	if !isText(data) {
		return core.ToolResult{}, fmt.Errorf("Could not edit file: %s. binary file rejected.", path)
	}
	if len(data) > 2*1024*1024 {
		return core.ToolResult{}, fmt.Errorf("Could not edit file: %s. file too large (>2MB).", path)
	}

	// Change tracking: snapshot the content BEFORE the edit (first sighting
	// only). The tmp content is compared after the edit for the live diff.
	if t.Changes != nil {
		if capped, tooLarge := cappedSnapshot(data); tooLarge {
			t.Changes.NoteBinaryNew(abs)
		} else {
			t.Changes.NoteEditBefore(abs, capped)
		}
	}

	// Strip BOM before matching. The model will not include an invisible BOM
	// in oldText. Mirrors pi.
	bom := ""
	content := string(data)
	if strings.HasPrefix(content, "\uFEFF") {
		bom = "\uFEFF"
		content = content[len(bom):]
	}
	originalEnding := detectLineEnding(content)
	normalizedContent := normalizeToLF(content)

	baseContent, newContent, err := applyEditsToNormalizedContent(normalizedContent, a.Edits, path)
	if err != nil {
		return core.ToolResult{}, err
	}

	finalContent := bom + restoreLineEndings(newContent, originalEnding)
	if !isPreview {
		st, statErr := os.Stat(abs)
		mode := os.FileMode(0o644)
		if statErr == nil {
			mode = st.Mode().Perm()
		}
		if err := os.WriteFile(abs, []byte(finalContent), mode); err != nil {
			return core.ToolResult{}, fmt.Errorf("Could not edit file: %s. %s.", path, err)
		}
	}

	// Frontend-only rendering: the APPLIED + numbered-diff view shown
	// by the UI transcript.
	display := t.renderDisplay(path, baseContent, newContent, len(a.Edits))

	return core.ToolResult{
		// Mirrors pi: a one-line confirmation; the diff is frontend-only.
		Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Successfully replaced %d block(s) in %s.", len(a.Edits), path)}},
		Details: map[string]any{
			"display": display,
			"diff":    DiffText(baseContent, newContent),
			"path":    abs,
			"files":   []string{path},
			"edits":   len(a.Edits),
			"dryRun":  isPreview,
		},
	}, nil
}

// renderDisplay builds the presentation for the UI: notice, "APPLIED.", the
// per-file check mark with match count, and the numbered context diff.
func (t *EditTool) renderDisplay(path, baseContent, newContent string, matches int) string {
	var b strings.Builder
	b.WriteString(LinePrefixNotice)
	b.WriteString("APPLIED.\n")
	fmt.Fprintf(&b, "\n✓ %s (%d match%s)\n", slash(path), matches, plural(matches))
	aiDiff := DiffTextNumbered(baseContent, newContent)
	if aiDiff != "" {
		b.WriteString(aiDiff)
		if !strings.HasSuffix(aiDiff, "\n") {
			b.WriteString("\n")
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// pi edit engine (port of pi's edit-diff.ts applyEditsToNormalizedContent)
// ---------------------------------------------------------------------------

// normalizeToLF mirrors pi's normalizeToLF.
func normalizeToLF(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.ReplaceAll(text, "\r", "\n")
}

// restoreLineEndings mirrors pi's restoreLineEndings.
func restoreLineEndings(text, ending string) string {
	if ending == "\r\n" {
		return strings.ReplaceAll(text, "\n", "\r\n")
	}
	return text
}

// detectLineEnding mirrors pi's detectLineEnding: the first occurrence wins.
func detectLineEnding(content string) string {
	crlfIdx := strings.Index(content, "\r\n")
	lfIdx := strings.Index(content, "\n")
	if lfIdx == -1 {
		return "\n"
	}
	if crlfIdx == -1 {
		return "\n"
	}
	if crlfIdx < lfIdx {
		return "\r\n"
	}
	return "\n"
}

// normalizeForFuzzyMatch mirrors pi's normalizeForFuzzyMatch: strip trailing
// whitespace per line, normalize smart quotes to ASCII, Unicode dashes/hyphens
// to ASCII hyphen, and special Unicode spaces to regular space. (pi also
// applies NFKC; the explicit replacements below cover the practical cases.)
func normalizeForFuzzyMatch(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRightFunc(line, unicode.IsSpace)
	}
	text = strings.Join(lines, "\n")
	return fuzzyReplacer.Replace(text)
}

var fuzzyReplacer = strings.NewReplacer(
	// Smart single quotes → '
	"‘", "'",
	"’", "'",
	"‚", "'",
	"‛", "'",
	// Smart double quotes → "
	"“", `"`,
	"”", `"`,
	"„", `"`,
	"‟", `"`,
	// Various dashes/hyphens → -
	"‐", "-",
	"‑", "-",
	"‒", "-",
	"–", "-",
	"—", "-",
	"―", "-",
	"−", "-",
	// Special spaces → regular space
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	" ", " ",
	"　", " ",
)

type fuzzyMatchResult struct {
	found     bool
	index     int
	matchLen  int
	usedFuzzy bool
}

// fuzzyFindText mirrors pi's fuzzyFindText: exact match first, then fuzzy
// match in normalized space.
func fuzzyFindText(content, oldText string) fuzzyMatchResult {
	if idx := strings.Index(content, oldText); idx != -1 {
		return fuzzyMatchResult{found: true, index: idx, matchLen: len(oldText), usedFuzzy: false}
	}
	fuzzyContent := normalizeForFuzzyMatch(content)
	fuzzyOldText := normalizeForFuzzyMatch(oldText)
	idx := strings.Index(fuzzyContent, fuzzyOldText)
	if idx == -1 {
		return fuzzyMatchResult{found: false}
	}
	return fuzzyMatchResult{found: true, index: idx, matchLen: len(fuzzyOldText), usedFuzzy: true}
}

func countOccurrences(content, oldText string) int {
	fuzzyContent := normalizeForFuzzyMatch(content)
	fuzzyOldText := normalizeForFuzzyMatch(oldText)
	if fuzzyOldText == "" {
		return 0
	}
	return strings.Count(fuzzyContent, fuzzyOldText)
}

func getNotFoundError(path string, editIndex, totalEdits int) error {
	if totalEdits == 1 {
		return fmt.Errorf("Could not find the exact text in %s. The old text must match exactly including all whitespace and newlines.", path)
	}
	return fmt.Errorf("Could not find edits[%d] in %s. The oldText must match exactly including all whitespace and newlines.", editIndex, path)
}

func getDuplicateError(path string, editIndex, totalEdits, occurrences int) error {
	if totalEdits == 1 {
		return fmt.Errorf("Found %d occurrences of the text in %s. The text must be unique. Please provide more context to make it unique.", occurrences, path)
	}
	return fmt.Errorf("Found %d occurrences of edits[%d] in %s. Each oldText must be unique. Please provide more context to make it unique.", occurrences, editIndex, path)
}

func getEmptyOldTextError(path string, editIndex, totalEdits int) error {
	if totalEdits == 1 {
		return fmt.Errorf("oldText must not be empty in %s.", path)
	}
	return fmt.Errorf("edits[%d].oldText must not be empty in %s.", editIndex, path)
}

func getNoChangeError(path string, totalEdits int) error {
	if totalEdits == 1 {
		return fmt.Errorf("No changes made to %s. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.", path)
	}
	return fmt.Errorf("No changes made to %s. The replacements produced identical content.", path)
}

type matchedEdit struct {
	editIndex  int
	matchIndex int
	matchLen   int
	newText    string
}

type textReplacement struct {
	matchIndex int
	matchLen   int
	newText    string
}

// applyEditsToNormalizedContent ports pi's function of the same name: all
// edits are matched against the same original content; replacements are then
// applied in reverse order so offsets stay stable. If any edit needs fuzzy
// matching, the operation runs in fuzzy-normalized content space and then
// overlays those line-level changes onto the original content so unchanged
// line blocks keep their original bytes.
func applyEditsToNormalizedContent(normalizedContent string, edits []piEdit, path string) (string, string, error) {
	normalizedEdits := make([]piEdit, len(edits))
	for i, e := range edits {
		normalizedEdits[i] = piEdit{
			OldText: normalizeToLF(e.OldText),
			NewText: normalizeToLF(e.NewText),
		}
	}

	for i, e := range normalizedEdits {
		if len(e.OldText) == 0 {
			return "", "", getEmptyOldTextError(path, i, len(normalizedEdits))
		}
	}

	usedFuzzyMatch := false
	for _, e := range normalizedEdits {
		if m := fuzzyFindText(normalizedContent, e.OldText); m.found && m.usedFuzzy {
			usedFuzzyMatch = true
			break
		}
	}
	replacementBaseContent := normalizedContent
	if usedFuzzyMatch {
		replacementBaseContent = normalizeForFuzzyMatch(normalizedContent)
	}

	var matchedEdits []matchedEdit
	for i, e := range normalizedEdits {
		matchResult := fuzzyFindText(replacementBaseContent, e.OldText)
		if !matchResult.found {
			return "", "", getNotFoundError(path, i, len(normalizedEdits))
		}
		occurrences := countOccurrences(replacementBaseContent, e.OldText)
		if occurrences > 1 {
			return "", "", getDuplicateError(path, i, len(normalizedEdits), occurrences)
		}
		matchedEdits = append(matchedEdits, matchedEdit{
			editIndex:  i,
			matchIndex: matchResult.index,
			matchLen:   matchResult.matchLen,
			newText:    e.NewText,
		})
	}

	sort.SliceStable(matchedEdits, func(x, y int) bool {
		return matchedEdits[x].matchIndex < matchedEdits[y].matchIndex
	})
	for i := 1; i < len(matchedEdits); i++ {
		previous := matchedEdits[i-1]
		current := matchedEdits[i]
		if previous.matchIndex+previous.matchLen > current.matchIndex {
			return "", "", fmt.Errorf(
				"edits[%d] and edits[%d] overlap in %s. Merge them into one edit or target disjoint regions.",
				previous.editIndex, current.editIndex, path)
		}
	}

	baseContent := normalizedContent
	var newContent string
	if usedFuzzyMatch {
		var err error
		newContent, err = applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, toReplacements(matchedEdits))
		if err != nil {
			return "", "", err
		}
	} else {
		newContent = applyReplacements(replacementBaseContent, toReplacements(matchedEdits), 0)
	}

	if baseContent == newContent {
		return "", "", getNoChangeError(path, len(normalizedEdits))
	}
	return baseContent, newContent, nil
}

func toReplacements(matched []matchedEdit) []textReplacement {
	out := make([]textReplacement, len(matched))
	for i, m := range matched {
		out[i] = textReplacement{matchIndex: m.matchIndex, matchLen: m.matchLen, newText: m.newText}
	}
	return out
}

func applyReplacements(content string, replacements []textReplacement, offset int) string {
	result := content
	for i := len(replacements) - 1; i >= 0; i-- {
		r := replacements[i]
		matchIndex := r.matchIndex - offset
		result = result[:matchIndex] + r.newText + result[matchIndex+r.matchLen:]
	}
	return result
}

// splitLinesWithEndings splits content into lines that keep their trailing
// newline (pi's /[^\n]*\n|[^\n]+/g).
func splitLinesWithEndings(content string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(content); i++ {
		if content[i] == '\n' {
			lines = append(lines, content[start:i+1])
			start = i + 1
		}
	}
	if start < len(content) {
		lines = append(lines, content[start:])
	}
	return lines
}

type lineSpan struct {
	start int
	end   int
}

func getLineSpans(content string) []lineSpan {
	offset := 0
	spans := make([]lineSpan, 0)
	for _, line := range splitLinesWithEndings(content) {
		spans = append(spans, lineSpan{start: offset, end: offset + len(line)})
		offset += len(line)
	}
	return spans
}

func getReplacementLineRange(lines []lineSpan, r textReplacement) (int, int, error) {
	replacementStart := r.matchIndex
	replacementEnd := r.matchIndex + r.matchLen

	startLine := -1
	for i, line := range lines {
		if replacementStart >= line.start && replacementStart < line.end {
			startLine = i
			break
		}
	}
	if startLine == -1 {
		return 0, 0, fmt.Errorf("Replacement range is outside the base content.")
	}

	endLine := startLine
	for endLine < len(lines) && lines[endLine].end < replacementEnd {
		endLine++
	}
	if endLine >= len(lines) {
		return 0, 0, fmt.Errorf("Replacement range is outside the base content.")
	}
	return startLine, endLine + 1, nil
}

// applyReplacementsPreservingUnchangedLines ports pi's function: replacements
// matched against the normalized base are widened to the lines they touch;
// touched lines are rewritten from the normalized base and every other line
// is copied back from the original so unchanged blocks keep their bytes.
func applyReplacementsPreservingUnchangedLines(originalContent, baseContent string, replacements []textReplacement) (string, error) {
	originalLines := splitLinesWithEndings(originalContent)
	baseLines := getLineSpans(baseContent)
	if len(originalLines) != len(baseLines) {
		// Mirrors pi's error.
		return "", fmt.Errorf("Cannot preserve unchanged lines because the base content has a different line count.")
	}

	type group struct {
		startLine    int
		endLine      int
		replacements []textReplacement
	}
	var groups []group
	sorted := append([]textReplacement(nil), replacements...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].matchIndex < sorted[j].matchIndex })
	for _, r := range sorted {
		startLine, endLine, err := getReplacementLineRange(baseLines, r)
		if err != nil {
			return "", err
		}
		if n := len(groups); n > 0 && startLine < groups[n-1].endLine {
			g := &groups[n-1]
			if endLine > g.endLine {
				g.endLine = endLine
			}
			g.replacements = append(g.replacements, r)
			continue
		}
		groups = append(groups, group{startLine: startLine, endLine: endLine, replacements: []textReplacement{r}})
	}

	originalLineIndex := 0
	var result strings.Builder
	for _, g := range groups {
		result.WriteString(strings.Join(originalLines[originalLineIndex:g.startLine], ""))
		groupStartOffset := baseLines[g.startLine].start
		groupEndOffset := baseLines[g.endLine-1].end
		result.WriteString(applyReplacements(
			baseContent[groupStartOffset:groupEndOffset],
			g.replacements,
			groupStartOffset,
		))
		originalLineIndex = g.endLine
	}
	result.WriteString(strings.Join(originalLines[originalLineIndex:], ""))
	return result.String(), nil
}

// diffContextLines is the number of unchanged lines kept on each
// side of an edit when rendering the diff. 3 is the git-diff
// default and balances readability with transcript size.
const diffContextLines = 3

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
// for the frontend display.
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
