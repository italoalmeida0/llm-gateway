package core

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/patriceckhart/zot/packages/provider"
)

// Compaction tuning ported from pi's
// packages/coding-agent/src/core/compaction/compaction.ts.
//
// The daemon previously compacted on a single heuristic (last-turn usage
// vs 70% of the window) with no incremental chaining. This file ports the
// full pi model: reserve-based triggering, trailing-context estimation,
// tool-boundary-safe cut points, file-op tracking, and initial/update
// summarization prompts.
const (
	// CompactionReserveTokens is the headroom kept for the summarizer's
	// own output plus the next turn. pi: RESERVE_TOKENS = 16384.
	CompactionReserveTokens = 16384
	// CompactionKeepRecentTokens is the floor of recent context that is
	// never summarized away. pi: KEEP_RECENT_TOKENS = 20000.
	CompactionKeepRecentTokens = 20000
	// CompactionMinMessages is the minimum history length worth
	// compacting. Below this there is nothing meaningful to summarize.
	CompactionMinMessages = 6
	// CompactionImageTokenEstimate is the per-image cost used when no
	// usage numbers are available. pi: 1500 tokens.
	CompactionImageTokenEstimate = 1500
)

// CompactionState is the incremental state chained across compactions,
// mirroring pi's CompactionEntry (summary + firstKeptEntryId + file ops).
// It is persisted on the session record so a restart does not break the
// chain: the next summarization receives the previous summary as context
// instead of re-summarizing from scratch.
type CompactionState struct {
	// PreviousSummary is the last produced summary text.
	PreviousSummary string `json:"previousSummary,omitempty"`
	// ReadFiles accumulates files the agent has read across compactions.
	ReadFiles []string `json:"readFiles,omitempty"`
	// ModifiedFiles accumulates files the agent has created/edited.
	ModifiedFiles []string `json:"modifiedFiles,omitempty"`
	// FirstKeptEntryID anchors the cut point: entries at or after this ID
	// were kept verbatim by the last compaction.
	FirstKeptEntryID string `json:"firstKeptEntryId,omitempty"`
	// Count tracks how many compactions have run in this session.
	Count int `json:"count,omitempty"`
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
				// pi has no byte-based image estimate; the daemon keeps a
				// rough chars/4 on bytes so large screenshots still move
				// the needle, floored at the pi flat estimate.
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
// Port of estimateConversationTokens.
func EstimateConversationTokens(msgs []provider.Message) int {
	total := 0
	for _, m := range msgs {
		total += EstimateMessageTokens(m)
	}
	return total
}

// UsageTotal returns input+output tokens, the pi-compatible "totalTokens"
// figure used by shouldCompact.
func UsageTotal(u provider.Usage) int {
	return u.InputTokens + u.OutputTokens
}

// TrailingTokens estimates the unsummarized tail: messages after the last
// assistant usage snapshot plus the current turn's new messages. This is
// the port of pi's getLastAssistantUsage + trailing-estimate logic — the
// daemon previously looked only at LastTurnUsage, which undercounts long
// tool-heavy turns that have not yet reported usage.
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
// next model call. Port of shouldCompact: usage + trailing estimate vs
// window minus reserve.
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

// SerializeConversation renders messages into pi's <conversation> XML-ish
// format so the summarizer sees exactly what pi's summarizer sees.
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

// SummarizationSystemPrompt is pi's SUMMARIZATION_SYSTEM_PROMPT verbatim:
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

// InitialSummarizationPrompt builds pi's INITIAL_SUMMARIZATION_PROMPT.
func InitialSummarizationPrompt(conversation string) string {
	return fmt.Sprintf(`Summarize the following conversation:

%s

Provide the summary using the required format.`, conversation)
}

// UpdateSummarizationPrompt builds pi's UPDATE_SUMMARIZATION_PROMPT: the
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

// ExtractFileOps scans a message window for file activity, porting pi's
// extractFileOps. read/glob+search+inspect count as reads;
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
				// pi uses independent sets: a file read and later
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
// Port of the carry-over logic in prepareCompaction.
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
// to keep verbatim, plus whether the cut split a tool turn (requiring the
// prefix summary path).
type CutPoint struct {
	// Index is the first message index kept verbatim.
	Index int
	// SplitTurn is true when the cut landed mid tool-call/result turn, so
	// the caller must summarize the prefix window as well (pi's split-turn
	// path producing two summaries).
	SplitTurn bool
	// PrefixEnd is the end index of the prefix window when SplitTurn.
	PrefixEnd int
}

// FindCutPoint walks back from the end keeping at least keepRecent tokens
// and never cutting in the middle of a tool result sequence. Port of pi's
// findCutPoint, including the split-turn detection: if the boundary falls
// between an assistant tool_call and its tool_result, the prefix (up to the
// tool call) is summarized separately so no orphaned tool_result survives.
func FindCutPoint(msgs []provider.Message, keepRecent int) CutPoint {
	if len(msgs) == 0 {
		return CutPoint{Index: 0}
	}
	// Walk back accumulating token estimates until the keep floor is met.
	acc := 0
	idx := len(msgs)
	for idx > 0 && acc < keepRecent {
		idx--
		acc += EstimateMessageTokens(msgs[idx])
	}
	if idx <= 0 {
		return CutPoint{Index: 0}
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
	// Split-turn detection: boundary sits between an assistant message
	// with tool calls and the tool results that answer it.
	if idx > 0 && idx < len(msgs) && isToolCallTail(msgs[idx-1]) && isToolResultHead(msgs[idx]) {
		return CutPoint{Index: idx, SplitTurn: true, PrefixEnd: idx}
	}
	if idx < 0 {
		idx = 0
	}
	return CutPoint{Index: idx}
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

// CompactionPlan is the output of PrepareCompaction: everything needed to
// run one summarization and splice it back.
type CompactionPlan struct {
	// Summarize holds the messages to feed the summarizer.
	Summarize []provider.Message
	// KeepFrom is the transcript index kept verbatim.
	KeepFrom int
	// SplitTurn mirrors CutPoint.SplitTurn.
	SplitTurn bool
	// PrefixEnd mirrors CutPoint.PrefixEnd.
	PrefixEnd int
	// Prompt is the fully built summarizer prompt.
	Prompt string
	// FileOpsNote is the rendered file-operations section.
	FileOpsNote string
	// WindowOps is the file activity in the summarized window.
	WindowOps FileOps
	// Incremental is true when a previous summary is being updated.
	Incremental bool
}

// PrepareCompaction mirrors pi's prepareCompaction: pick the cut point,
// serialize the window, extract file ops, merge with carried state, and
// build the initial or update prompt.
func PrepareCompaction(msgs []provider.Message, state *CompactionState, keepRecent int) *CompactionPlan {
	if keepRecent <= 0 {
		keepRecent = CompactionKeepRecentTokens
	}
	cut := FindCutPoint(msgs, keepRecent)
	window := msgs
	if cut.Index > 0 && cut.Index < len(msgs) {
		window = msgs[:cut.Index]
	}
	ops := ExtractFileOps(window)
	plan := &CompactionPlan{
		Summarize:   window,
		KeepFrom:    cut.Index,
		SplitTurn:   cut.SplitTurn,
		PrefixEnd:   cut.PrefixEnd,
		WindowOps:   ops,
		FileOpsNote: FormatFileOperations(ops),
	}
	conversation := SerializeConversation(window)
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
	return plan
}
