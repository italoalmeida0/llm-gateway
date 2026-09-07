package core

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/provider"
)

// Compact summarizes the agent's transcript via the LLM and replaces
// it with a single synthetic user message carrying the summary. A
// small tail of recent messages is optionally preserved for continuity.
//
// keepTail is the number of most-recent messages to keep verbatim after
// the summary. 0 means summarize everything; a typical useful value is
// 4-8 (last couple of exchanges).
//
// The method blocks until the summary request completes. Emitted
// events via sink are limited to text deltas from the summary call so
// the UI can show progress.
// Compact summarizes the agent's transcript via the LLM and splices the
// summary back in, preserving a recent tail verbatim. This is a faithful
// port of pi's compactConversation + applyCompaction:
//
//   - cut point via FindCutPoint (tool-boundary-safe, split-turn aware)
//   - keep floor = max(CompactionKeepRecentTokens, 30% of transcript
//     tokens) — the hybrid window: pi-faithful on small windows, sane on
//     1M-token windows
//   - initial vs update summarization prompts (incremental chaining via
//     the persisted CompactionState)
//   - file-ops tracking (read/modified) carried across compactions
//   - summarizer guards: reject empty summaries, tool calls, and
//     length-truncated output (stop=length), with one retry
//   - orphaned tool_result repair on the spliced transcript
//
// keepTail, when > 0, overrides the computed keep floor with an exact
// message count (used by manual /compact callers and tests). 0 means
// "compute from the hybrid window".
//
// The method blocks until the summary request completes. Emitted events
// via sink are limited to text deltas from the summary call so the UI
// can show progress. Returns the raw summary text.
func (a *Agent) Compact(ctx context.Context, keepTail int, sink func(delta string)) (summary string, err error) {
	a.mu.Lock()
	msgs := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	a.mu.Unlock()

	if len(msgs) == 0 {
		return "", fmt.Errorf("nothing to compact")
	}
	if len(msgs) < CompactionMinMessages && keepTail <= 0 {
		return "", fmt.Errorf("nothing to compact: transcript below minimum (%d messages)", CompactionMinMessages)
	}

	keepTokens := hybridKeepFloor(msgs)
	keepFrom := len(msgs)
	if keepTail > 0 {
		keepFrom = len(msgs) - keepTail
		if keepFrom < 0 {
			keepFrom = 0
		}
	} else {
		keepFrom = FindCutPoint(msgs, keepTokens).Index
	}
	// pi parity on the auto path: when the whole transcript fits under
	// the keep floor, FindCutPoint returns 0 — meaning "nothing worth
	// summarizing". Report it instead of force-halving the transcript,
	// which would drop history without need. Explicit keepTail callers
	// (manual /compact, overflow retry) asked for that exact split.
	if keepFrom <= 0 {
		if keepTail > 0 {
			keepFrom = len(msgs) / 2
			if keepFrom <= 0 {
				keepFrom = 1
			}
		} else {
			return "", fmt.Errorf("nothing to compact: transcript fits under the keep floor")
		}
	}
	if keepFrom >= len(msgs) {
		return "", fmt.Errorf("nothing to compact: keep-tail covers the whole transcript")
	}

	plan := PrepareCompaction(msgs, state, keepTokens)
	// When the caller forced an explicit keepTail, re-cut the plan to it.
	if keepTail > 0 {
		window := msgs[:keepFrom]
		ops := ExtractFileOps(window)
		plan = &CompactionPlan{
			Summarize:   window,
			KeepFrom:    keepFrom,
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
	}

	summary, stopLen, err := a.runSummarizer(ctx, plan.Prompt, sink)
	if err != nil {
		return "", err
	}
	if stopLen {
		// pi rejects length-truncated summaries and retries once with a
		// smaller window before giving up.
		retryFrom := keepFrom + (len(msgs)-keepFrom)/2
		if retryFrom >= len(msgs) {
			return "", fmt.Errorf("summary truncated by length; transcript too short to retry")
		}
		retryPlan := PrepareCompaction(msgs[retryFrom-len(plan.Summarize):], state, keepTokens)
		_ = retryPlan
		smaller := PrepareCompaction(msgs[:retryFrom], state, keepTokens)
		summary, stopLen, err = a.runSummarizer(ctx, smaller.Prompt, sink)
		if err != nil {
			return "", err
		}
		if stopLen {
			return "", fmt.Errorf("summary truncated by length after retry")
		}
		plan = smaller
		keepFrom = smaller.KeepFrom
	}

	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "", fmt.Errorf("empty summary from model")
	}

	next, nextState := applyCompaction(msgs, plan, summary, state)

	a.mu.Lock()
	a.messages = next
	a.rev++
	a.setCompactionStateLocked(nextState)
	onCompacted := a.OnTranscriptCompacted
	persisted := append([]provider.Message(nil), next...)
	persistState := *nextState
	a.mu.Unlock()

	if onCompacted != nil {
		onCompacted(persisted)
	}
	if a.OnCompactionState != nil {
		a.OnCompactionState(&persistState)
	}

	return summary, nil
}

// runSummarizer issues one summarization request with tool use disabled
// and cache bypassed (port of pi's retryAssistantCall with
// cacheRetention:none). It rejects assistant tool calls outright and
// reports whether the turn stopped for length.
func (a *Agent) runSummarizer(ctx context.Context, prompt string, sink func(delta string)) (string, bool, error) {
	req := provider.Request{
		Model:       a.Model,
		System:      SummarizationSystemPrompt,
		MaxTokens:   4096,
		Temperature: a.Temperature,
		SessionID:   a.SessionID,
		Messages: []provider.Message{
			{
				Role:    provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: prompt}},
				Time:    time.Now(),
				Meta:    map[string]string{"compaction": "summarizer"},
			},
		},
	}

	stream, err := a.Client.Stream(ctx, req)
	if err != nil {
		return "", false, err
	}

	var sb strings.Builder
	stopLen := false
	sawToolCall := false
	for ev := range stream {
		switch e := ev.(type) {
		case provider.EventTextDelta:
			sb.WriteString(e.Delta)
			if sink != nil {
				sink(e.Delta)
			}
		case provider.EventToolStart, provider.EventToolArgs, provider.EventToolEnd:
			sawToolCall = true
		case provider.EventDone:
			if e.Err != nil {
				return "", false, e.Err
			}
			if e.Stop == provider.StopLength {
				stopLen = true
			}
		}
	}
	if sawToolCall {
		return "", false, fmt.Errorf("summarizer attempted a tool call; retrying without tools is not supported by this provider route")
	}
	return sb.String(), stopLen, nil
}

// applyCompaction splices the summary back into the transcript: one
// synthetic user message carrying the summary, followed by the preserved
// tail, with orphaned tool results repaired. It also advances the
// incremental chain head. Port of pi's applyCompaction.
func applyCompaction(msgs []provider.Message, plan *CompactionPlan, summary string, prev *CompactionState) ([]provider.Message, *CompactionState) {
	tokensBefore := EstimateConversationTokens(plan.Summarize)

	// Preserve activated tool names so deferred/provider tool wiring
	// survives the splice (same as before).
	var activatedTools []string
	for _, message := range msgs {
		for _, name := range message.AddedToolNames {
			if !containsString(activatedTools, name) {
				activatedTools = append(activatedTools, name)
			}
		}
	}
	synthetic := provider.Message{
		Role:           provider.RoleUser,
		AddedToolNames: activatedTools,
		Content: []provider.Content{
			provider.TextBlock{Text: "## Context Summary (compacted)\n\n" + summary},
		},
		Time: time.Now(),
		Meta: map[string]string{
			"compaction":    "true",
			"tokens_before": strconv.Itoa(tokensBefore),
		},
	}

	tail := append([]provider.Message(nil), msgs[plan.KeepFrom:]...)
	tail = repairOrphanedToolResults(tail)

	next := make([]provider.Message, 0, 1+len(tail))
	next = append(next, synthetic)
	next = append(next, tail...)

	// Advance the chain head: merged file ops + new summary + anchor.
	var readFiles, modFiles []string
	if prev != nil {
		readFiles = MergeFileOps(prev.ReadFiles, plan.WindowOps.Read)
		modFiles = MergeFileOps(prev.ModifiedFiles, plan.WindowOps.Modified)
	} else {
		readFiles = append([]string(nil), plan.WindowOps.Read...)
		modFiles = append([]string(nil), plan.WindowOps.Modified...)
	}
	count := 1
	if prev != nil {
		count = prev.Count + 1
	}
	// Anchor: index of the first kept message in the NEW transcript is 1
	// (right after the synthetic summary).
	nextState := &CompactionState{
		PreviousSummary:  summary,
		ReadFiles:        readFiles,
		ModifiedFiles:    modFiles,
		FirstKeptEntryID: "compacted-1",
		Count:            count,
	}
	return next, nextState
}

// SeedCompactionState primes the incremental chain head, e.g. from the
// compaction row restored out of the session file on resume. A nil state
// clears the chain (fresh session).
func (a *Agent) SeedCompactionState(state *CompactionState) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.compactionState = state
}

// CompactionChain returns a copy of the current chain head, or nil.
func (a *Agent) CompactionChain() *CompactionState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.compactionStateLocked()
}

func (a *Agent) compactionStateLocked() *CompactionState {
	if a.compactionState == nil {
		return nil
	}
	cp := *a.compactionState
	cp.ReadFiles = append([]string(nil), a.compactionState.ReadFiles...)
	cp.ModifiedFiles = append([]string(nil), a.compactionState.ModifiedFiles...)
	return &cp
}

func (a *Agent) setCompactionStateLocked(state *CompactionState) {
	a.compactionState = state
}

// hybridKeepFloor ports the keep decision: pi's 20k-token floor, raised
// to 30% of the transcript when the transcript is large (so 1M-token
// windows keep working context instead of summarizing 98% away).
func hybridKeepFloor(msgs []provider.Message) int {
	total := EstimateConversationTokens(msgs)
	floor := CompactionKeepRecentTokens
	if thirty := total * 30 / 100; thirty > floor {
		floor = thirty
	}
	return floor
}

// repairOrphanedToolResults removes tool_result content blocks (and
// entire messages that become empty) when the matching tool_use ID
// does not appear anywhere in the given messages. This happens after
// compaction when the tail preserves a tool_result but the tool_use
// that produced it was summarized away.
func repairOrphanedToolResults(msgs []provider.Message) []provider.Message {
	return provider.RepairOrphanedToolResults(msgs)
}

// serializeTranscript renders a list of provider.Message into a plain
// text transcript the summarization model can read without trying to
// continue the conversation.
func serializeTranscript(msgs []provider.Message) string {
	var sb strings.Builder
	for _, m := range msgs {
		switch m.Role {
		case provider.RoleUser:
			sb.WriteString("\n--- user ---\n")
		case provider.RoleAssistant:
			sb.WriteString("\n--- assistant ---\n")
		case provider.RoleTool:
			sb.WriteString("\n--- tool ---\n")
		}
		for _, c := range m.Content {
			switch v := c.(type) {
			case provider.TextBlock:
				sb.WriteString(v.Text)
				sb.WriteString("\n")
			case provider.ImageBlock:
				fmt.Fprintf(&sb, "[image: %s, %d bytes]\n", v.MimeType, len(v.Data))
			case provider.ToolCallBlock:
				fmt.Fprintf(&sb, "[tool_call %s %s]\n", v.Name, string(v.Arguments))
			case provider.ToolResultBlock:
				for _, inner := range v.Content {
					if tb, ok := inner.(provider.TextBlock); ok {
						sb.WriteString("[tool_result] ")
						text := tb.Text
						if len(text) > ToolOutputMaxChars {
							text = text[:ToolOutputMaxChars] + "\n[truncated]"
						}
						sb.WriteString(text)
						sb.WriteString("\n")
					}
				}
			}
		}
	}
	return sb.String()
}

const summarizationSystem = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`

const compactionPrompt = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

// calculateKeepTail dynamically computes the number of recent messages to retain
// verbatim after compaction, targeting between 2,000 and 15,000 tokens of the
// most recent turns (matching OpenCode's preserveRecentBudget approach).
func calculateKeepTail(msgs []provider.Message) int {
	const maxTailTokens = 15000
	if len(msgs) <= 2 {
		return 0
	}

	tokens := 0
	count := 0
	userTurns := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		m := msgs[i]
		mTokens := estimateMessageTokens(m)
		if tokens+mTokens > maxTailTokens && count >= 2 && userTurns >= 1 {
			break
		}
		tokens += mTokens
		count++
		if m.Role == provider.RoleUser {
			userTurns++
		}
	}
	if count >= len(msgs) {
		count = len(msgs) / 2
	}
	return count
}

func estimateMessageTokens(m provider.Message) int {
	chars := 0
	for _, c := range m.Content {
		switch v := c.(type) {
		case provider.TextBlock:
			chars += len(v.Text)
		case provider.ToolCallBlock:
			chars += len(v.Name) + len(v.Arguments)
		case provider.ToolResultBlock:
			for _, inner := range v.Content {
				if tb, ok := inner.(provider.TextBlock); ok {
					chars += len(tb.Text)
				}
			}
		}
	}
	return chars/4 + 1
}
