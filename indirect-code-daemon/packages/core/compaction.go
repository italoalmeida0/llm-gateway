package core

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Compaction tuning and heuristics.
//
// Features include: reserve-based triggering, trailing-context estimation,
// tool-boundary-safe cut points, file-op tracking, and initial/update
// summarization prompts.
const (
	// CompactionReserveTokens is the headroom kept for the summarizer's
	// own output plus the next turn. RESERVE_TOKENS = 16384.
	CompactionReserveTokens = 16384
	// CompactionKeepRecentTokens is the floor of recent context that is
	// never summarized away. KEEP_RECENT_TOKENS = 20000.
	CompactionKeepRecentTokens = 20000
	// CompactionMinMessages is the minimum history length worth
	// compacting. Below this there is nothing meaningful to summarize.
	CompactionMinMessages = 6
	// CompactionImageTokenEstimate is the per-image cost used when no
	// usage numbers are available: 1500 tokens.
	CompactionImageTokenEstimate = 1500
)

// CompactionProjectionVersion is the projection schema version written
// by new compactions. States restored from older session files lack the
// field (decoded as 0) and keep the legacy inline-summary layout: the
// synthetic summary message was spliced INTO the transcript by the old
// destructive applyCompaction, so projection is a pass-through for them.
const CompactionProjectionVersion = 1

// CompactionState is the incremental state chained across compactions
// (summary + firstKeptEntryId + file ops).
// It is persisted on the session record so a restart does not break the
// chain: the next summarization receives the previous summary as context
// instead of re-summarizing from scratch.
//
// Non-destructive history + projection: the state IS the
// compaction entry. The transcript log underneath is append-only and
// never rewritten — context is derived by splicing [summary] +
// [history[KeepFrom:]] at read time (see projectMessages), resolving
// "latest compaction + later entries".
type CompactionState struct {
	// PreviousSummary is the last produced summary text.
	PreviousSummary string `json:"previousSummary,omitempty"`
	// ReadFiles accumulates files the agent has read across compactions.
	ReadFiles []string `json:"readFiles,omitempty"`
	// ModifiedFiles accumulates files the agent has created/edited.
	ModifiedFiles []string `json:"modifiedFiles,omitempty"`
	// FirstKeptEntryID anchors the cut point: entries at or after this ID
	// were kept verbatim by the last compaction. The daemon keeps it as a
	// human/debug label; the operative anchor is KeepFrom.
	FirstKeptEntryID string `json:"firstKeptEntryId,omitempty"`
	// Count tracks how many compactions have run in this session.
	Count int `json:"count,omitempty"`
	// Version marks states that carry a projection anchor. Absent (0) in
	// legacy rows: those sessions embed the summary inline and project
	// as pass-through.
	Version int `json:"version,omitempty"`
	// KeepFrom is the index into the append-only history of the first
	// message kept verbatim by this compaction.
	// Context derivation = synthetic summary message + history[KeepFrom:].
	KeepFrom int `json:"keepFrom,omitempty"`
	// Usage records the LLM token cost of generating this compaction summary.
	Usage *provider.Usage `json:"usage,omitempty"`
}

// summaryMessageText renders the summary as the synthetic user-message
// text the model sees after a compaction.
func summaryMessageText(summary string) string {
	return "## Context Summary (compacted)\n\n" + summary
}

// isCompactionSynthetic reports whether m is a synthetic compaction
// summary message (produced by projection or spliced by a legacy build).
func isCompactionSynthetic(m provider.Message) bool {
	return m.Meta != nil && m.Meta["compaction"] == "true"
}

// projectionAnchor resolves a chain head against a history length to the
// effective projection layout: whether a synthetic summary precedes the
// kept tail and where the kept tail starts in the history.
//
// Legacy states (Version 0, restored from pre-projection session files)
// project as pass-through: their summary lives inline in the transcript.
// Corrupted/out-of-range anchors fail open to pass-through too — never
// hide user messages from the model because of a bad anchor.
func projectionAnchor(state *CompactionState, historyLen int) (synthetic bool, keepFrom int) {
	if state == nil || state.Version < CompactionProjectionVersion || state.PreviousSummary == "" {
		return false, 0
	}
	if state.KeepFrom < 0 || state.KeepFrom > historyLen {
		return false, 0
	}
	return true, state.KeepFrom
}

// projectMessages derives the effective model context from the
// append-only history and the compaction chain head:
// latest compaction entry + later entries. The
// history slice itself is never mutated or reordered.
//
// The synthetic summary message aggregates AddedToolNames gathered from
// the whole history so deferred-tool activations survive compaction the
// same way they did under the old splice (applyCompaction collected
// them into the synthetic message it spliced in).
func projectMessages(history []provider.Message, state *CompactionState) []provider.Message {
	synthetic, keepFrom := projectionAnchor(state, len(history))
	if !synthetic {
		return history
	}
	var activated []string
	for _, m := range history {
		for _, name := range m.AddedToolNames {
			if !containsString(activated, name) {
				activated = append(activated, name)
			}
		}
	}
	syn := provider.Message{
		Role:    provider.RoleUser,
		Time:    time.Now(),
		Content: []provider.Content{provider.TextBlock{Text: summaryMessageText(state.PreviousSummary)}},
		Meta: map[string]string{
			"compaction": "true",
			"count":      strconv.Itoa(state.Count),
		},
		AddedToolNames: activated,
	}
	out := make([]provider.Message, 0, 1+len(history)-keepFrom)
	out = append(out, syn)
	out = append(out, history[keepFrom:]...)
	return out
}

// FileOps is the per-window file activity extracted for the summary.
type FileOps struct {
	Read     []string
	Modified []string
}

// EstimateMessageTokens approximates a single message's token cost.
// Port of estimateMessageTokens: ceil(chars/4) per text/tool block, with
// image blocks estimated at a flat cost when no usage is attached.
func EstimateMessageTokens(m provider.Message) int {
	tokens := 0
	for _, c := range m.Content {
		switch b := c.(type) {
		case provider.TextBlock:
			tokens += (len(b.Text) + 3) / 4
		case provider.ReasoningBlock:
			tokens += (len(b.Summary) + 3) / 4
		case provider.ToolCallBlock:
			tokens += (len(b.Name) + len(b.Arguments) + 3) / 4
		case provider.ToolResultBlock:
			tokens += toolResultChars(b) / 4
		case provider.ImageBlock:
			if n := len(b.Data); n > 0 {
				// Keep a rough chars/4 on bytes so large screenshots still move
				// the needle, floored at the flat estimate.
				if est := (n + 3) / 4; est > CompactionImageTokenEstimate {
					tokens += est
				} else {
					tokens += CompactionImageTokenEstimate
				}
			} else {
				tokens += CompactionImageTokenEstimate
			}
		}
	}
	return tokens
}

// toolResultChars counts the characters inside a tool result block.
func toolResultChars(b provider.ToolResultBlock) int {
	n := 0
	for _, c := range b.Content {
		if t, ok := c.(provider.TextBlock); ok {
			n += len(t.Text)
		}
	}
	return n
}

// EstimateConversationTokens sums EstimateMessageTokens over a window.
func EstimateConversationTokens(msgs []provider.Message) int {
	total := 0
	for _, m := range msgs {
		total += EstimateMessageTokens(m)
	}
	return total
}

// UsageTotal returns input+output tokens used by ShouldCompact.
func UsageTotal(u provider.Usage) int {
	return u.InputTokens + u.OutputTokens
}

// TrailingTokens estimates the unsummarized tail: messages after the last
// assistant usage snapshot plus the current turn's new messages. This
// avoids undercounting long tool-heavy turns that have not yet reported usage.
func TrailingTokens(msgs []provider.Message, usage provider.Usage) int {
	// usage.TotalTokens already accounts for everything up to the last
	// assistant message that reported it. Anything after the last
	// assistant message in the transcript is unaccounted trailing context.
	lastAssistant := -1
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role == provider.RoleAssistant {
			lastAssistant = i
			break
		}
	}
	trailing := 0
	for i := lastAssistant + 1; i < len(msgs); i++ {
		trailing += EstimateMessageTokens(msgs[i])
	}
	_ = usage
	return trailing
}

// ShouldCompact reports whether the session should auto-compact before the
// next model call: usage + trailing estimate vs window minus reserve.
//
// window <= 0 means unknown: fall back to false and let the caller apply
// its own legacy heuristic.
func ShouldCompact(window int, usageTotal, trailingEstimate int) bool {
	if window <= 0 {
		return false
	}
	return usageTotal+trailingEstimate > window-CompactionReserveTokens
}

// NeedsCompaction is the convenience wrapper over the live transcript: it
// combines the cumulative usage with the trailing estimate.
func NeedsCompaction(window int, msgs []provider.Message, usage provider.Usage) bool {
	if window <= 0 || len(msgs) < CompactionMinMessages {
		return false
	}
	return ShouldCompact(window, UsageTotal(usage), TrailingTokens(msgs, usage))
}

// SerializeConversation renders messages into a <conversation> XML-ish
// format for the summarizer.
func SerializeConversation(msgs []provider.Message) string {
	var sb strings.Builder
	sb.WriteString("<conversation>\n")
	for _, m := range msgs {
		switch m.Role {
		case provider.RoleUser:
			sb.WriteString("<user>\n")
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					sb.WriteString(b.Text)
					sb.WriteString("\n")
				case provider.ImageBlock:
					sb.WriteString("[image attached]\n")
				case provider.ToolResultBlock:
					// Defensive: a stray tool result under a user message.
					sb.WriteString("[tool result: ")
					sb.WriteString(truncateForSummary(toolResultText(b), 500))
					sb.WriteString("]\n")
				}
			}
			sb.WriteString("</user>\n")
		case provider.RoleAssistant:
			sb.WriteString("<assistant>\n")
			for _, c := range m.Content {
				switch b := c.(type) {
				case provider.TextBlock:
					sb.WriteString(b.Text)
					sb.WriteString("\n")
				case provider.ReasoningBlock:
					sb.WriteString("[thinking: ")
					sb.WriteString(truncateForSummary(b.Summary, 500))
					sb.WriteString("]\n")
				case provider.ToolCallBlock:
					sb.WriteString("[tool call: ")
					sb.WriteString(b.Name)
					sb.WriteString(" ")
					sb.WriteString(truncateForSummary(string(b.Arguments), 500))
					sb.WriteString("]\n")
				case provider.ImageBlock:
					sb.WriteString("[image attached]\n")
				case provider.ToolResultBlock:
					sb.WriteString("[tool result: ")
					sb.WriteString(truncateForSummary(toolResultText(b), 500))
					sb.WriteString("]\n")
				}
			}
			sb.WriteString("</assistant>\n")
		case provider.RoleTool:
			sb.WriteString("<tool_result>\n")
			for _, c := range m.Content {
				if tr, ok := c.(provider.ToolResultBlock); ok {
					sb.WriteString(truncateForSummary(toolResultText(tr), 2000))
					sb.WriteString("\n")
				} else if t, ok := c.(provider.TextBlock); ok {
					sb.WriteString(truncateForSummary(t.Text, 2000))
					sb.WriteString("\n")
				}
			}
			sb.WriteString("</tool_result>\n")
		}
	}
	sb.WriteString("</conversation>")
	return sb.String()
}

// toolResultText flattens a tool result block to text.
func toolResultText(b provider.ToolResultBlock) string {
	var sb strings.Builder
	for _, c := range b.Content {
		if t, ok := c.(provider.TextBlock); ok {
			sb.WriteString(t.Text)
		}
	}
	return sb.String()
}

func truncateForSummary(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "...[truncated]"
}

// SummarizationSystemPrompt configures the summarizer:
// the summarizer must produce structured state, never answer, never call tools.
const SummarizationSystemPrompt = `You are a conversation summarizer. Your task is to create a structured summary of the conversation so far that preserves all critical context needed to continue the work.

<instructions>
- Summarize the conversation: goals, constraints, key decisions, progress, and next steps.
- Preserve file paths, code changes, tool results, error messages, and user preferences.
- Be concise but complete. Use the structure below.
- Do NOT answer the user's questions or continue the task. Only summarize.
- Do NOT call any tools.
</instructions>

<format>
## Goal
What the user is trying to accomplish.

## Constraints
User preferences, technical constraints, things to avoid.

## Progress
What has been done so far, including files read/modified and key tool results.

## Decisions
Key decisions made and why.

## Next Steps
What remains to be done.

## Critical Context
Anything else needed to continue (error messages, partial results, user feedback).
</format>`

// InitialSummarizationPrompt builds the initial summarization prompt.
func InitialSummarizationPrompt(conversation string) string {
	return fmt.Sprintf(`Summarize the following conversation:

%s

Provide the summary using the required format.`, conversation)
}

// UpdateSummarizationPrompt builds the update summarization prompt: the
// previous summary is carried forward and updated, never rewritten from
// scratch. This is what makes repeated compactions stable.
func UpdateSummarizationPrompt(previous, conversation, fileOps string) string {
	var sb strings.Builder
	sb.WriteString("A previous summary exists. Update it with the new conversation below. ")
	sb.WriteString("Preserve still-relevant context, move completed items to Progress, ")
	sb.WriteString("and update Next Steps. Do not drop critical context that is still pending.\n\n")
	sb.WriteString("<previous_summary>\n")
	sb.WriteString(previous)
	sb.WriteString("\n</previous_summary>\n\n")
	if fileOps != "" {
		sb.WriteString("<file_operations>\n")
		sb.WriteString(fileOps)
		sb.WriteString("\n</file_operations>\n\n")
	}
	sb.WriteString("<new_conversation>\n")
	sb.WriteString(conversation)
	sb.WriteString("\n</new_conversation>\n\n")
	sb.WriteString("Provide the updated summary using the required format.")
	return sb.String()
}

// toolArgPath extracts the file path from raw tool-call arguments JSON.
// It tolerates the path living under "path", "file_path", "file" or
// "pattern" keys (glob/search use pattern as their path scope).
func toolArgPath(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
		return ""
	}
	for _, k := range []string{"path", "file_path", "file", "pattern"} {
		if v, ok := obj[k]; ok {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
	}
	return ""
}

// FormatFileOperations renders read/modified file lists for the update
// prompt. Port of formatFileOperations.
func FormatFileOperations(ops FileOps) string {
	var sb strings.Builder
	if len(ops.Read) > 0 {
		sb.WriteString("Files read:\n")
		for _, f := range ops.Read {
			sb.WriteString("- ")
			sb.WriteString(f)
			sb.WriteString("\n")
		}
	}
	if len(ops.Modified) > 0 {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("Files modified:\n")
		for _, f := range ops.Modified {
			sb.WriteString("- ")
			sb.WriteString(f)
			sb.WriteString("\n")
		}
	}
	return strings.TrimSpace(sb.String())
}

// ExtractFileOps scans a message window for file activity.
// read/glob+search+inspect count as reads;
// write/edit count as modifications. Paths come from the tool-call
// arguments the assistant produced.
func ExtractFileOps(msgs []provider.Message) FileOps {
	var ops FileOps
	seenRead := map[string]bool{}
	seenMod := map[string]bool{}
	for _, m := range msgs {
		if m.Role != provider.RoleAssistant {
			continue
		}
		for _, c := range m.Content {
			tc, ok := c.(provider.ToolCallBlock)
			if !ok {
				continue
			}
			path := toolArgPath(string(tc.Arguments))
			if path == "" {
				continue
			}
			switch tc.Name {
			case "write", "edit":
				if !seenMod[path] {
					seenMod[path] = true
					ops.Modified = append(ops.Modified, path)
				}
			case "read", "glob", "search", "inspect":
				// Use independent sets: a file read and later
				// modified appears in both lists.
				if !seenRead[path] {
					seenRead[path] = true
					ops.Read = append(ops.Read, path)
				}
			}
		}
	}
	return ops
}

// MergeFileOps unions old and new file lists, deduplicated, order-stable.
func MergeFileOps(old []string, add []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(old)+len(add))
	for _, f := range old {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	for _, f := range add {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// CutPoint is the result of FindCutPoint: the index of the first message
// to keep verbatim, plus whether the cut split a turn mid-way.
type CutPoint struct {
	// Index is the first message index kept verbatim.
	Index int
	// SplitTurn is true when the cut landed mid-turn (at an assistant message),
	// so the caller must summarize the prefix window as well.
	SplitTurn bool
	// TurnStartIndex is the start index of the split turn (or -1 if not split).
	TurnStartIndex int
}

func findTurnStartIndex(msgs []provider.Message, cutIndex int) int {
	for i := cutIndex - 1; i >= 0; i-- {
		if isUserBoundary(msgs[i]) {
			return i
		}
	}
	return -1
}

// FindCutPoint walks back from the end keeping at least keepRecent tokens
// and never cutting in the middle of a tool result sequence, including
// the split-turn detection: if the boundary falls
// at an assistant message mid-turn, the turn is split into a prefix
// (summarized) and a suffix (retained).
func FindCutPoint(msgs []provider.Message, keepRecent int) CutPoint {
	if len(msgs) == 0 {
		return CutPoint{Index: 0, TurnStartIndex: -1}
	}
	// Walk back accumulating token estimates until the keep floor is met.
	acc := 0
	idx := len(msgs)
	for idx > 0 && acc < keepRecent {
		idx--
		acc += EstimateMessageTokens(msgs[idx])
	}
	if idx <= 0 {
		return CutPoint{Index: 0, TurnStartIndex: -1}
	}
	// Never cut directly after an assistant tool_call (its results would
	// be orphaned) — move the boundary forward past the result run.
	for idx < len(msgs) && isToolCallTail(msgs[idx-1]) && isToolResultHead(msgs[idx]) {
		idx++
	}
	// Never cut directly before a tool result run — move back to include
	// the owning assistant tool_call.
	for idx > 0 && isToolResultHead(msgs[idx]) && !ownsToolCall(msgs, idx) {
		idx--
	}
	if idx < 0 {
		idx = 0
	}
	if idx >= len(msgs) {
		idx = len(msgs) - 1
	}

	// If the cut point is a user boundary, it is a clean turn boundary.
	// If it is an assistant message, it splits the turn!
	if isUserBoundary(msgs[idx]) {
		return CutPoint{Index: idx, SplitTurn: false, TurnStartIndex: -1}
	}
	turnStart := findTurnStartIndex(msgs, idx)
	if turnStart >= 0 {
		return CutPoint{Index: idx, SplitTurn: true, TurnStartIndex: turnStart}
	}
	// No preceding user boundary found; snap to user boundary if one follows.
	snapped := snapCutToUserBoundary(msgs, idx)
	return CutPoint{Index: snapped, SplitTurn: false, TurnStartIndex: -1}
}

// snapCutToUserBoundary moves a pair-safe cut forward to the next user
// message so the kept tail never starts mid-turn (orphan tool result,
// bare assistant continuation). Hidden/internal messages (MetaHidden)
// and legacy image mirrors do not count as boundaries: they are
// filtered from the request context anyway, so starting the tail at
// one would still read as mid-turn to the model.
func snapCutToUserBoundary(msgs []provider.Message, idx int) int {
	if idx <= 0 || idx >= len(msgs) {
		return idx
	}
	if isUserBoundary(msgs[idx]) {
		return idx
	}
	for i := idx; i < len(msgs); i++ {
		if isUserBoundary(msgs[i]) {
			return i
		}
	}
	return idx
}

// isUserBoundary reports whether m is a genuine user turn start: role
// user, visible to the model (not hidden), and not a legacy image
// mirror (request-derived now, filtered by filterHidden).
func isUserBoundary(m provider.Message) bool {
	if m.Role != provider.RoleUser {
		return false
	}
	if m.Meta != nil && m.Meta[MetaHidden] == "true" {
		return false
	}
	if m.Meta != nil && m.Meta[MetaEphemeral] == "true" {
		return false
	}
	return !isLegacyImageMirror(m)
}

// isToolCallTail reports whether m is an assistant message ending in (or
// containing) a tool call.
func isToolCallTail(m provider.Message) bool {
	if m.Role != provider.RoleAssistant {
		return false
	}
	for _, c := range m.Content {
		if _, ok := c.(provider.ToolCallBlock); ok {
			return true
		}
	}
	return false
}

// isToolResultHead reports whether m opens (or is) a tool result.
func isToolResultHead(m provider.Message) bool {
	if m.Role == provider.RoleTool {
		return true
	}
	if m.Role == provider.RoleAssistant {
		for _, c := range m.Content {
			if _, ok := c.(provider.ToolResultBlock); ok {
				return true
			}
		}
	}
	return false
}

// ownsToolCall checks whether the window before idx contains the assistant
// tool_call that the tool result at idx answers.
func ownsToolCall(msgs []provider.Message, idx int) bool {
	for i := idx - 1; i >= 0 && i >= idx-3; i-- {
		if isToolCallTail(msgs[i]) {
			return true
		}
		if msgs[i].Role == provider.RoleUser {
			break
		}
	}
	return false
}

const TurnPrefixSummarizationPromptTemplate = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

// TurnPrefixSummarizationPrompt formats the prompt for the split-turn prefix.
func TurnPrefixSummarizationPrompt(conversation string) string {
	return fmt.Sprintf("<conversation>\n%s\n</conversation>\n\n%s", conversation, TurnPrefixSummarizationPromptTemplate)
}

// CompactionPlan is the output of PrepareCompaction: everything needed to
// run summarization (including split turns) and splice it back.
type CompactionPlan struct {
	// Summarize holds the history messages before the split turn (or before KeepFrom if not split).
	Summarize []provider.Message
	// TurnPrefix holds the split-turn prefix messages (from TurnStartIndex to KeepFrom).
	TurnPrefix []provider.Message
	// KeepFrom is the transcript index kept verbatim.
	KeepFrom int
	// TurnStartIndex is the start index of the split turn (or -1 if not split).
	TurnStartIndex int
	// SplitTurn is true when cutting in the middle of a turn.
	SplitTurn bool
	// Prompt is the fully built summarizer prompt for history (if any).
	Prompt string
	// TurnPrefixPrompt is the prompt for the split turn prefix (if SplitTurn).
	TurnPrefixPrompt string
	// FileOpsNote is the rendered file-operations section.
	FileOpsNote string
	// WindowOps is the file activity across Summarize + TurnPrefix.
	WindowOps FileOps
	// Incremental is true when a previous summary is being updated.
	Incremental bool
}

// PrepareCompaction prepares the compaction plan: pick the cut point,
// serialize the window, extract file ops, merge with carried state, and
// build the initial/update prompts (including split-turn prefix prompts).
func PrepareCompaction(msgs []provider.Message, state *CompactionState, keepRecent int) *CompactionPlan {
	if keepRecent <= 0 {
		keepRecent = CompactionKeepRecentTokens
	}
	cut := FindCutPoint(msgs, keepRecent)
	keepFrom := cut.Index
	if keepFrom < 0 {
		keepFrom = 0
	}
	if keepFrom > len(msgs) {
		keepFrom = len(msgs)
	}

	historyEnd := keepFrom
	if cut.SplitTurn && cut.TurnStartIndex >= 0 && cut.TurnStartIndex < keepFrom {
		historyEnd = cut.TurnStartIndex
	}

	summarizeWindow := msgs[:historyEnd]
	var turnPrefixWindow []provider.Message
	if cut.SplitTurn && cut.TurnStartIndex >= 0 && cut.TurnStartIndex < keepFrom {
		turnPrefixWindow = msgs[cut.TurnStartIndex:keepFrom]
	}

	allSummarized := msgs[:keepFrom]
	ops := ExtractFileOps(allSummarized)

	plan := &CompactionPlan{
		Summarize:      summarizeWindow,
		TurnPrefix:     turnPrefixWindow,
		KeepFrom:       keepFrom,
		TurnStartIndex: cut.TurnStartIndex,
		SplitTurn:      cut.SplitTurn && len(turnPrefixWindow) > 0,
		WindowOps:      ops,
		FileOpsNote:    FormatFileOperations(ops),
	}

	if len(summarizeWindow) > 0 {
		conversation := SerializeConversation(summarizeWindow)
		if state != nil && state.PreviousSummary != "" {
			plan.Incremental = true
			merged := FileOps{
				Read:     MergeFileOps(state.ReadFiles, ops.Read),
				Modified: MergeFileOps(state.ModifiedFiles, ops.Modified),
			}
			plan.FileOpsNote = FormatFileOperations(merged)
			plan.Prompt = UpdateSummarizationPrompt(state.PreviousSummary, conversation, plan.FileOpsNote)
		} else {
			plan.Prompt = InitialSummarizationPrompt(conversation)
		}
	}

	if plan.SplitTurn && len(turnPrefixWindow) > 0 {
		prefixConv := SerializeConversation(turnPrefixWindow)
		plan.TurnPrefixPrompt = TurnPrefixSummarizationPrompt(prefixConv)
	}

	return plan
}
