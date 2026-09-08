package core

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Compact summarizes the conversation and records the result as a
// chain-head advance over the append-only history. It NEVER rewrites
// the transcript: a.messages stays intact and context changes purely
// through projection (compaction advances the chain head;
// history is immutable; context = latest entry + later entries).
//
// Inputs are derived from the projectMessages view (latest summary +
// kept tail), which is also what repeated compactions summarize —
// the incremental "update previous summary" prompt.
//
// keepTail, when > 0, overrides the computed keep floor with an exact
// message count (used by manual /compact callers and tests). 0 means
// "compute from the hybrid window" (max(20k, 30% of context tokens)).
//
// The agent mutex is NOT held while the summarizer runs: tool
// execution, queue drains and user input handlers that lock a.mu keep
// working during the LLM call (previously a compaction mid-loop could
// deadlock when tool hooks needed the agent lock). The state swap at
// the end is atomic under the lock.
//
// Emitted events via sink are limited to text deltas from the summary
// call so the UI can show progress. Returns the raw summary text.
func (a *Agent) Compact(ctx context.Context, keepTail int, sink func(delta string)) (string, error) {
	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	a.mu.Unlock()

	if len(history) == 0 {
		return "", fmt.Errorf("nothing to compact")
	}
	msgs := projectMessages(history, state)
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
	// On the auto path: when the whole transcript fits under
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
		turnStart := -1
		isSplit := false
		if keepFrom > 0 && keepFrom < len(msgs) && !isUserBoundary(msgs[keepFrom]) {
			turnStart = findTurnStartIndex(msgs, keepFrom)
			if turnStart >= 0 {
				isSplit = true
			}
		}
		historyEnd := keepFrom
		var prefixWindow []provider.Message
		if isSplit && turnStart >= 0 && turnStart < keepFrom {
			historyEnd = turnStart
			prefixWindow = msgs[turnStart:keepFrom]
		}
		window := msgs[:historyEnd]
		ops := ExtractFileOps(msgs[:keepFrom])
		plan = &CompactionPlan{
			Summarize:      window,
			TurnPrefix:     prefixWindow,
			KeepFrom:       keepFrom,
			TurnStartIndex: turnStart,
			SplitTurn:      isSplit && len(prefixWindow) > 0,
			WindowOps:      ops,
			FileOpsNote:    FormatFileOperations(ops),
		}
		if len(window) > 0 {
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
		if plan.SplitTurn && len(prefixWindow) > 0 {
			plan.TurnPrefixPrompt = TurnPrefixSummarizationPrompt(SerializeConversation(prefixWindow))
		}
	}

	var summary string
	var totalUsage provider.Usage

	// Split turn path: when a turn is too large to keep, the history
	// before the split turn and the turn prefix itself are summarized separately
	// and merged.
	if plan.SplitTurn && len(plan.TurnPrefix) > 0 {
		var histSummary string
		if len(plan.Summarize) > 0 {
			s, stopLen, u, err := a.runSummarizer(ctx, plan.Prompt, sink)
			if err != nil {
				return "", err
			}
			if stopLen {
				// Retry or report length stop
			}
			histSummary = strings.TrimSpace(s)
			totalUsage = totalUsage.Add(u)
		} else {
			histSummary = "No prior history."
		}

		prefixSummary, _, prefixUsage, err := a.runSummarizer(ctx, plan.TurnPrefixPrompt, sink)
		if err != nil {
			return "", err
		}
		totalUsage = totalUsage.Add(prefixUsage)
		summary = fmt.Sprintf("%s\n\n---\n\n**Turn Context (split turn):**\n\n%s", histSummary, strings.TrimSpace(prefixSummary))
	} else {
		s, stopLen, u, err := a.runSummarizer(ctx, plan.Prompt, sink)
		if err != nil {
			return "", err
		}
		totalUsage = totalUsage.Add(u)
		if stopLen {
			// Reject length-truncated summaries and retry once with a
			// smaller window before giving up.
			retryFrom := keepFrom + (len(msgs)-keepFrom)/2
			if retryFrom >= len(msgs) {
				return "", fmt.Errorf("summary truncated by length; transcript too short to retry")
			}
			smaller := PrepareCompaction(msgs[:retryFrom], state, keepTokens)
			s2, stopLen2, u2, err2 := a.runSummarizer(ctx, smaller.Prompt, sink)
			if err2 != nil {
				return "", err2
			}
			if stopLen2 {
				return "", fmt.Errorf("summary truncated by length after retry")
			}
			s = s2
			plan = smaller
			keepFrom = smaller.KeepFrom
			totalUsage = totalUsage.Add(u2)
		}
		summary = strings.TrimSpace(s)
	}

	summary = strings.TrimSpace(summary)
	if summary == "" {
		return "", fmt.Errorf("empty summary from model")
	}

	// Compute file operations and append to summary
	ops := plan.WindowOps
	if state != nil {
		ops.Read = MergeFileOps(state.ReadFiles, ops.Read)
		ops.Modified = MergeFileOps(state.ModifiedFiles, ops.Modified)
	}
	if fileNote := FormatFileOperations(ops); fileNote != "" {
		summary += "\n\n" + fileNote
	}

	nextState := advanceCompactionChain(plan, summary, state)
	nextState.KeepFrom = projectionIndexForContext(history, state, plan.KeepFrom)
	nextState.FirstKeptEntryID = "h" + strconv.Itoa(nextState.KeepFrom)
	if totalUsage.InputTokens > 0 || totalUsage.OutputTokens > 0 {
		nextState.Usage = &totalUsage
	}

	a.mu.Lock()
	a.setCompactionStateLocked(nextState)
	a.rev++
	onCompacted := a.OnTranscriptCompacted
	onState := a.OnCompactionState
	store := a.store
	projected := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	a.mu.Unlock()

	// Record token usage for compaction in the session store and agent cost
	if totalUsage.InputTokens > 0 || totalUsage.OutputTokens > 0 {
		cum := a.cost.Add(totalUsage)
		if store != nil {
			_ = store.AppendUsage(totalUsage, cum)
		}
		if a.OnUsage != nil {
			a.OnUsage(cum)
		}
	}

	// Compaction checkpoints are first-class persistence rows,
	// not best-effort callbacks. The store
	// write is mandatory when a store is attached; the legacy hooks
	// stay for hosts that mirror to their own session file.
	if store != nil {
		if err := store.AppendCompaction(nextState); err != nil {
			return "", fmt.Errorf("persist compaction checkpoint: %w", err)
		}
	}
	if onState != nil {
		onState(a.CompactionChain())
	}
	if onCompacted != nil {
		onCompacted(projected)
	}

	return summary, nil
}

// MaybeAutoCompact is the proactive compaction trigger for the
// AutoCompact hook. It is a no-op when the next
// request still fits; otherwise it runs Compact and returns true.
//
// Trigger semantics: the LAST turn's usage approximates the size
// of the prompt the model just saw; adding the trailing estimate for
// messages appended since (tool results, queued user text) yields the
// next request's projected size. It never uses the cumulative session
// usage — a cumulative trigger would fire forever once crossed, even
// right after a successful compaction. The state is evaluated over
// the projected context, so a previous compaction's discarded prefix
// cannot inflate the estimate.
//
// window <= 0 (unknown context window) disables the trigger. A failed
// summarization does NOT abort the run: false is returned and the
// request proceeds; the reactive overflow retry stays as the safety
// net.
func (a *Agent) MaybeAutoCompact(ctx context.Context, window int, sink func(delta string)) (bool, error) {
	if window <= 0 {
		return false, nil
	}
	a.mu.Lock()
	history := append([]provider.Message(nil), a.messages...)
	state := a.compactionStateLocked()
	usage := a.cost.LastTurn
	a.mu.Unlock()

	msgs := projectMessages(history, state)
	if len(msgs) <= CompactionMinMessages {
		return false, nil
	}
	if !ShouldCompact(window, UsageTotal(usage), TrailingTokens(msgs, usage)) {
		return false, nil
	}
	summary, err := a.Compact(ctx, 0, sink)
	if err != nil || summary == "" {
		return false, nil
	}
	return true, nil
}

// runSummarizer issues one summarization request with tool use disabled
// and cache bypassed. It rejects assistant tool calls outright and
// reports whether the turn stopped for length plus the token usage.
func (a *Agent) runSummarizer(ctx context.Context, prompt string, sink func(delta string)) (string, bool, provider.Usage, error) {
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
		return "", false, provider.Usage{}, err
	}

	var sb strings.Builder
	var runUsage provider.Usage
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
		case provider.EventUsage:
			runUsage = runUsage.Add(e.Usage)
		case provider.EventDone:
			if e.Err != nil {
				return "", false, runUsage, e.Err
			}
			if e.Stop == provider.StopLength {
				stopLen = true
			}
		}
	}
	if sawToolCall {
		return "", false, runUsage, fmt.Errorf("summarizer attempted a tool call; retrying without tools is not supported by this provider route")
	}
	return sb.String(), stopLen, runUsage, nil
}

// advanceCompactionChain advances the incremental chain head after a
// successful summarization: merged file ops + new summary + count. The
// transcript itself is untouched — the caller fills the projection
// anchor (KeepFrom) with projectionIndexForContext.
func advanceCompactionChain(plan *CompactionPlan, summary string, prev *CompactionState) *CompactionState {
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
	return &CompactionState{
		Version:         CompactionProjectionVersion,
		PreviousSummary: summary,
		ReadFiles:       readFiles,
		ModifiedFiles:   modFiles,
		Count:           count,
	}
}

// projectionIndexForContext maps a cut point expressed in projected-
// context coordinates (what PrepareCompaction/FindCutPoint produce)
// back to a history index for the new chain head.
//
// Layouts:
//   - pass-through context (no/legacy state): context[i] == history[i]
//   - active projection: context[0] is the old synthetic summary and
//     context[i>=1] == history[state.KeepFrom+i-1]
//
// The old synthetic summary (context index 0 of an active projection)
// is never a keep candidate — the new summary supersedes it — so a cut
// at 0 clamps to 1. Legacy inline summaries (Meta compaction=true,
// spliced by old builds at history index 0) get the same treatment.
func projectionIndexForContext(history []provider.Message, state *CompactionState, ctxKeepFrom int) int {
	active, base := projectionAnchor(state, len(history))
	if active {
		idx := ctxKeepFrom
		if idx <= 0 {
			idx = 1
		}
		if idx >= len(history)-base+1 {
			return len(history)
		}
		return base + idx - 1
	}
	if ctxKeepFrom < 0 {
		return 0
	}
	if ctxKeepFrom > len(history) {
		return len(history)
	}
	if ctxKeepFrom == 0 && len(history) > 0 && isCompactionSynthetic(history[0]) {
		// The old inline summary is superseded by the new one.
		return 1
	}
	return ctxKeepFrom
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

// hybridKeepFloor computes the keep floor: a 20k-token floor, raised
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
