package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// ContinueNudgeText is the synthetic user message the agent loop appends
// when the model returns a terminal stop with no visible text and no tool
// calls (typically a thinking-only early stop): instead of ending the
// turn, the loop nudges the model to continue. Frontends hide user
// messages whose trimmed text equals this (same idea as TODO activity,
// which is also transcript-real but display-hidden). Keep the frontend
// CONTINUE_NUDGE_TEXT constant in sync.
const ContinueNudgeText = "[You should continue what you are doing.]"

// CompletionNudgeTextBuild and CompletionNudgeTextPlan prompt the model
// when it returns visible text without calling a completion tool in build/plan modes.
const (
	CompletionNudgeTextBuild = "[Automatic system message: If you have completed the task, call mark_task_as_complete. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work.]"
	CompletionNudgeTextPlan  = "[Automatic system message: If your plan is ready, call mark_plan_as_ready_to_execute. If you still have questions, use the question tool to await the user's response. Otherwise, continue your work.]"
)

// maxContinueNudges caps consecutive empty-response nudges per turn so a
// model stuck returning nothing cannot burn requests forever; the turn
// then ends normally.
const maxContinueNudges = 3

// maxCompletionNudges caps consecutive completion-prompt nudges per turn.
const maxCompletionNudges = 3

// SanitizeUserText keeps a user-authored message distinguishable from the
// synthetic continue nudge: when the trimmed text equals ContinueNudgeText
// or a completion nudge, the surrounding brackets are stripped, so the
// frontend's nudge filter (exact match on the bracketed form) never hides a real user message.
func SanitizeUserText(s string) string {
	t := strings.TrimSpace(s)
	if t == ContinueNudgeText || t == CompletionNudgeTextBuild || t == CompletionNudgeTextPlan {
		return t[1 : len(t)-1]
	}
	return s
}

// Agent is a stateful conversation bound to a provider client, a model,
// and a set of tools.
type Agent struct {
	Client      provider.Client
	Model       string
	System      string
	Tools       Registry
	Reasoning   string
	Temperature *float32

	// MaxTokens caps the model's output tokens per turn. Zero leaves
	// the field unset on the provider request, letting each provider
	// apply its own default (which can be conservative, e.g. Bedrock
	// defaults to 4096, truncating long writes/edits). Hosts populate
	// this from the resolved model's MaxOutput so large single-turn
	// responses aren't silently cut off with stopReason=length.
	MaxTokens int

	// SessionID is the conversation id, forwarded to providers that
	// support sticky routing. Empty means omitted.
	SessionID string

	// MaxToolCalls caps provider-executed server-tool calls per turn.
	// Zero leaves the field unset.
	MaxToolCalls int

	// BeforeToolExecute, if set, is called immediately before each
	// tool runs. Returning (allowed=false, reason) short-circuits
	// the call with an error result containing reason. Optionally,
	// returning a non-nil modifiedArgs replaces the JSON args the
	// tool will see, which lets guards redact / augment / patch the
	// model's request without rewriting the transcript. Empty or
	// malformed modifiedArgs is ignored.
	BeforeToolExecute func(call provider.ToolCallBlock) (allowed bool, reason string, modifiedArgs json.RawMessage)

	// BeforeStart replaces the complete system prompt once per runtime session
	// or explicit prompt/model reset, before any turn starts. It is not called
	// for ordinary follow-up messages or tool-loop steps.
	BeforeStart func(context.Context, string) string

	// BeforeTurn, if set, is called before each turn's model call.
	// Returning (allowed=false, reason) aborts the turn; reason is
	// surfaced as an assistant-like status line. Used for rate-
	// limiting, business-hour gates, and deny-by-default setups.
	BeforeTurn func(step int) (allowed bool, reason string)

	// BeforeRequest refreshes runtime configuration on the agent goroutine before
	// every provider request, including retries. In-flight requests are untouched.
	// Kept as-is: it mutates runtime config, not message context.
	BeforeRequest func(context.Context) error

	// AssistantTextTransforms rewrites visible assistant text
	// (suppress or replace) for UI emission. Replaces the removed
	// BeforeAssistantMessage hook as a stackable transform: the
	// transcript always keeps the model's original output.
	AssistantTextTransforms []AssistantTextTransform

	// RetrySchedule overrides the backoff between upstream attempts (nil
	// selects the default schedule). The last entry repeats forever: a
	// retryable upstream failure never ends the turn — only success or
	// context cancellation (user stop / shutdown) does.
	RetrySchedule []time.Duration

	// OnEvent, if set, mirrors every AgentEvent the loop emits to
	// this callback in addition to the per-Prompt sink. Used by the
	// extension manager to fan events out to subscribed extensions
	// without each caller having to compose sinks manually.
	OnEvent func(AgentEvent)

	// OnMessageAppended, if set, fires every time a message is
	// appended to the in-memory transcript by the agent loop — the
	// initial user prompt, each finalised assistant message, and
	// each tool-results message. Derived context (provider image
	// mirrors) never fires this hook: it exists only in the
	// request, never in the transcript.
	// Hosts wire this to the on-disk session so that turns are
	// durable as soon as they happen, instead of only being
	// flushed on a clean exit.
	OnMessageAppended func(provider.Message)

	// TurnIndex is the host's current turn sequence, stamped onto every
	// message the agent appends (user, assistant, tool). Unique per
	// session only. Hosts set it before each turn; zero leaves
	// messages unstamped (readers derive boundaries).
	TurnIndex int

	// OnUsage, if set, fires after every turn's usage row arrives,
	// carrying the cumulative usage for the session. Hosts wire
	// this to the on-disk session so the persisted total stays
	// current and a crash recovers the right cost figure.
	OnUsage func(cumulative provider.Usage)

	// OnCompactionState, if set, fires after every successful Compact
	// with the new incremental chain head (previous summary + merged
	// file ops + KeepFrom anchor + count). Hosts persist it on the
	// session record so the next summarization — even after a restart —
	// is an update, not a from-scratch re-summary, and so projection
	// can re-derive the compacted context.
	// This is the ONLY state a host needs to persist for compaction:
	// the transcript log itself is append-only and unchanged.
	OnCompactionState func(state *CompactionState)

	// AutoCompact, if set, runs before EVERY model request of the
	// agent loop — including mid-loop between tool batches — so a
	// long run compacts proactively instead of burning a failed
	// overflowing request first. The hook owns the window/threshold
	// policy (hosts know the model); it typically calls
	// a.MaybeAutoCompact. Returning an error aborts the loop. Runs
	// outside a.mu, so the hook may call any Agent method.
	AutoCompact func(ctx context.Context, sink func(AgentEvent)) error

	// Preparation caches the effective prompt separately from its unmodified
	// base so a model or session reset cannot stack extension appendices.
	startPrepared                                    bool
	startGeneration                                  uint64
	startBase, startSystem, startModel, startSession string

	mu       sync.Mutex
	messages []provider.Message
	// compactionState is the incremental chain head. Seeded from the session file on resume
	// (SeedCompactionState) and advanced by every Compact call.
	compactionState *CompactionState
	// rev increments whenever the transcript slice is replaced or a
	// message is appended. The UI uses it as a cheap redraw cache key
	// so typing doesn't copy/rebuild a long transcript on
	// every keypress.
	rev  uint64
	cost CostTracker
}

// NewAgent returns an Agent with sensible defaults.
func NewAgent(client provider.Client, model, system string, tools Registry) *Agent {
	a := &Agent{
		Client: client,
		Model:  model,
		System: system,
		Tools:  tools,
	}
	return a
}

// Messages returns a copy of the effective model context: the
// append-only history projected through the compaction chain head
// (latest summary + kept tail). Use History for the full log.
func (a *Agent) Messages() []provider.Message {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	return append([]provider.Message(nil), out...)
}

// History returns a copy of the full append-only transcript — every
// message ever appended, including ones the compaction chain has
// summarized away. The history is the source of truth persisted by
// hosts; the model never sees it
// directly, only its projection.
func (a *Agent) History() []provider.Message {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]provider.Message, len(a.messages))
	copy(out, a.messages)
	return out
}

// ContextSnapshot returns the provider-neutral inputs that make up the
// current model context. Hosts use the snapshot for read-only inspection
// without racing a tool-registry replacement or transcript append.
// Messages are the projected context (same view Messages returns).
func (a *Agent) ContextSnapshot() (system string, tools []provider.Tool, messages []provider.Message) {
	a.mu.Lock()
	defer a.mu.Unlock()
	messages = append([]provider.Message(nil),
		projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())...)
	return a.System, a.Tools.Specs(), messages
}

// Revision returns a monotonically increasing transcript version.
// It is cheap to query and changes whenever Messages() would return
// different transcript content because of append/set operations.
func (a *Agent) Revision() uint64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.rev
}

// SetTools swaps the tool registry. Used by /reload-ext to hand
// the agent a fresh registry after extension subprocesses have been
// respawned (and their freshly-registered tools merged in).
func (a *Agent) SetTools(reg Registry) {
	a.mu.Lock()
	a.Tools = reg
	a.mu.Unlock()
}

// SetMessages replaces the append-only history (used when resuming a
// session). Pair with SeedCompactionState so projection can re-derive
// the effective context; the slice must be the full log, not an
// already-compacted view.
func (a *Agent) SetMessages(msgs []provider.Message) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.messages = append(a.messages[:0], msgs...)
	if len(msgs) == 0 {
		a.resetStartLocked()
	}
	a.rev++
}

// AppendUserContext adds a user-role message to the transcript without
// starting a model turn. Hosts use it for context gathered outside the agent
// loop, such as the output of an explicitly invoked shell command.
func (a *Agent) AppendUserContext(text string, meta map[string]string) {
	msg := provider.Message{
		Role:    provider.RoleUser,
		Content: []provider.Content{provider.TextBlock{Text: text}},
		Time:    time.Now(),
		Meta:    meta,
	}
	a.stampTurn(&msg)
	a.mu.Lock()
	a.messages = append(a.messages, msg)
	a.rev++
	a.mu.Unlock()
	a.fireMessageAppended(msg)
}

// Cost returns the cumulative usage.
func (a *Agent) Cost() provider.Usage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cost.Total
}

// SeedCost sets the cumulative usage as a baseline before the first
// turn runs. Used when transferring state from another agent (model
// or provider switch) so the running cost meter doesn't reset to 0.
func (a *Agent) SeedCost(u provider.Usage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cost.Seed(u)
}

// LastTurnUsage returns the per-turn usage of the most recent
// completed turn. Drives the "context used" gauge in the status bar
// without waiting for the next turn to land.
func (a *Agent) LastTurnUsage() provider.Usage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cost.LastTurn
}

// SeedLastTurnUsage primes the per-turn snapshot. Used on resume so
// the gauge reflects the prompt size of the last turn in the session
// file instead of starting at zero.
func (a *Agent) SeedLastTurnUsage(u provider.Usage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cost.LastTurn = u
}

// stampTurn tags m with the current turn before it joins the transcript.
// An already-stamped message keeps its id (fork prefixes, repairs).
func (a *Agent) stampTurn(m *provider.Message) {
	if m.TurnIndex == 0 {
		m.TurnIndex = a.TurnIndex
	}
}

// fireMessageAppended invokes OnMessageAppended without holding the
// agent mutex, so the host's persistence callback can take its own
// locks without deadlocking the agent loop. Tolerates a nil hook so
// non-persisting callers (tests, RPC mode) don't have to set it.
func (a *Agent) fireMessageAppended(m provider.Message) {
	a.mu.Lock()
	cb := a.OnMessageAppended
	a.mu.Unlock()
	if cb != nil {
		cb(m)
	}
}

// Prompt sends a user message and runs the agent loop until the model
// stops or an error occurs. Events are delivered via sink in order.
// sink must not block the caller for long; buffer as needed.
func (a *Agent) Prompt(ctx context.Context, text string, images []provider.ImageBlock, sink func(AgentEvent)) error {
	if sink == nil {
		sink = func(AgentEvent) {}
	}
	sink = a.wrapSink(sink)
	content := []provider.Content{}
	if text != "" {
		content = append(content, provider.TextBlock{Text: text})
	}
	for _, img := range images {
		content = append(content, img)
	}
	user := provider.Message{Role: provider.RoleUser, Content: content, Time: time.Now()}
	a.stampTurn(&user)

	a.mu.Lock()
	a.messages = append(a.messages, user)
	a.rev++
	a.mu.Unlock()
	a.fireMessageAppended(user)
	sink(EvUserMessage{Message: user})

	return a.runLoop(ctx, sink)
}

// Continue runs the agent loop against the existing transcript. Used
// after appending tool results manually or to retry.
func (a *Agent) Continue(ctx context.Context, sink func(AgentEvent)) error {
	if sink == nil {
		sink = func(AgentEvent) {}
	}
	sink = a.wrapSink(sink)
	return a.runLoop(ctx, sink)
}

// wrapSink composes the per-call sink with a.OnEvent (if set) so the
// extension manager (or any other observer) sees every AgentEvent
// without having to thread itself through every Prompt callsite.
func (a *Agent) wrapSink(sink func(AgentEvent)) func(AgentEvent) {
	if a.OnEvent == nil {
		return sink
	}
	obs := a.OnEvent
	return func(ev AgentEvent) {
		obs(ev)
		sink(ev)
	}
}

func (a *Agent) runLoop(ctx context.Context, sink func(AgentEvent)) error {
	// Unbounded by design: a turn runs until the model stops asking
	// for more work or the context is cancelled. Provider errors
	// retry forever on the backoff schedule — only AI conclusion or
	// user cancel (context cancellation) ends a turn.
	nudges := 0
	completionNudges := 0
	completedInTurn := false
	for step := 1; ; step++ {
		// Preparation is cached across steps and user messages. Only an
		// explicit prompt/model/session change invokes BeforeStart again.
		if err := a.prepareStart(ctx); err != nil {
			sink(EvDone{})
			return err
		}
		// Proactive in-run compaction, evaluated before EVERY model
		// response — including mid-run, right after tool results.
		// Evaluated inside the loop instead of
		// only at turn boundaries. The hook owns the window policy;
		// core provides MaybeAutoCompact as the trigger.
		a.mu.Lock()
		autoCompact := a.AutoCompact
		a.mu.Unlock()
		if autoCompact != nil {
			if err := autoCompact(ctx, sink); err != nil {
				sink(EvDone{})
				return err
			}
		}

		sink(EvTurnStart{Step: step})
		if a.BeforeTurn != nil {
			if allowed, reason := a.BeforeTurn(step); !allowed {
				if reason == "" {
					reason = "turn blocked by extension guard"
				}
				sink(EvTurnEnd{Stop: provider.StopError, Err: fmt.Errorf("%s", reason)})
				sink(EvDone{})
				return nil
			}
		}

		var (
			stop         provider.StopReason
			assistantMsg provider.Message
			err          error
		)
		for attempt := 0; ; attempt++ {
			stop, assistantMsg, err = a.oneTurn(ctx, sink)
			sink(EvTurnEnd{Stop: stop, Err: err})
			if err == nil {
				break
			}
			// Reactive recovery: if the provider rejected due to context overflow,
			// compact the transcript and retry immediately instead of hard-failing the turn.
			if IsContextOverflow(err) && attempt == 0 {
				sink(EvToolProgress{Text: "Context limit reached upstream; automatically compacting older context…"})
				if summary, compactErr := a.Compact(ctx, 0, nil); compactErr == nil && summary != "" {
					continue
				}
			}
			if !a.canRetryError(err, attempt) {
				break
			}
			a.dropLastAssistantMessage()
			delay := a.retryDelay(attempt)
			sink(EvRetry{Attempt: attempt + 1, Delay: delay, Err: err})
			if sleepErr := sleepRetry(ctx, delay); sleepErr != nil {
				return sleepErr
			}
		}
		if err != nil {
			return err
		}

		if stop == provider.StopToolUse {
			// Real progress: the model asked for more work, so the
			// empty-response nudge budget renews from here.
			nudges = 0
			completionNudges = 0
			for _, c := range assistantMsg.Content {
				if tc, ok := c.(provider.ToolCallBlock); ok {
					if tc.Name == "mark_task_as_complete" || tc.Name == "mark_plan_as_ready_to_execute" {
						completedInTurn = true
					}
				}
			}
			// Execute each client tool call, append a single tool-results message, continue.
			toolMsg, hadError := a.executeTools(ctx, assistantMsg, sink)
			if len(toolMsg.Content) == 0 {
				// Provider-executed (server) tools need no client results.
				continue
			}
			a.stampTurn(&toolMsg)
			a.mu.Lock()
			a.messages = append(a.messages, toolMsg)
			a.rev++
			a.mu.Unlock()
			a.fireMessageAppended(toolMsg)
			// Note: the provider image mirror (openai/openai-codex) is
			// derived per-turn inside BuildContext now — it is request-only
			// and never appended to the transcript.
			// If context was cancelled during tool execution, bail out.
			if err := ctx.Err(); err != nil {
				sink(EvDone{})
				return err
			}
			_ = hadError
			continue
		}

		// Terminal stop (end, length, error, aborted).
		if ctx.Err() != nil || stop == provider.StopAborted {
			sink(EvDone{})
			return nil
		}

		trimmedText := strings.TrimSpace(extractText(assistantMsg))

		// An empty terminal response — no tool calls and no visible text after trim,
		// typically a thinking-only early stop — does NOT end the turn:
		// append a hidden user nudge and ask the model again, so the
		// turn only completes on real output. Capped per turn; cancelled
		// and aborted turns still end immediately.
		if trimmedText == "" && !completedInTurn && nudges < maxContinueNudges {
			nudges++
			nudge := provider.Message{
				Role:    provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: ContinueNudgeText}},
				Time:    time.Now(),
			}
			a.stampTurn(&nudge)
			a.mu.Lock()
			a.messages = append(a.messages, nudge)
			a.rev++
			a.mu.Unlock()
			a.fireMessageAppended(nudge)
			sink(EvUserMessage{Message: nudge})
			continue
		}

		// When the model returns visible text without calling any tools:
		// check if a completion tool is configured in the registry and has not yet been called in this turn.
		// If so, prompt the model to either mark completion or continue working.
		if trimmedText != "" && !completedInTurn && completionNudges < maxCompletionNudges {
			completionNudgeText := ""
			a.mu.Lock()
			tools := a.Tools
			a.mu.Unlock()
			if _, err := tools.Get("mark_task_as_complete"); err == nil {
				completionNudgeText = CompletionNudgeTextBuild
			} else if _, err := tools.Get("mark_plan_as_ready_to_execute"); err == nil {
				completionNudgeText = CompletionNudgeTextPlan
			}

			if completionNudgeText != "" {
				completionNudges++
				nudge := provider.Message{
					Role:    provider.RoleUser,
					Content: []provider.Content{provider.TextBlock{Text: completionNudgeText}},
					Time:    time.Now(),
				}
				a.stampTurn(&nudge)
				a.mu.Lock()
				a.messages = append(a.messages, nudge)
				a.rev++
				a.mu.Unlock()
				a.fireMessageAppended(nudge)
				sink(EvUserMessage{Message: nudge})
				continue
			}
		}

		sink(EvDone{})
		return nil
	}
}

// canRetryError reports whether a failed model call is worth another
// attempt. Everything is retryable except context cancellation (user
// stop / shutdown): only those end a turn. A 400, a dead key, a quota
// wall — all keep retrying on the backoff schedule until success or
// cancel, so no provider error ever feels like "failed, I'll stop".
func (a *Agent) canRetryError(err error, _ int) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	return true
}

// defaultRetrySchedule is the backoff between upstream attempts: 1s x3,
// 5s x2, 10s x2, 30s x2, 1m x2, 5m x2, 10m x2, 30m x2, then hourly
// forever. Attempts never stop on error — only success or context
// cancellation (user stop / shutdown) ends the turn.
var defaultRetrySchedule = []time.Duration{
	time.Second, time.Second, time.Second,
	5 * time.Second, 5 * time.Second,
	10 * time.Second, 10 * time.Second,
	30 * time.Second, 30 * time.Second,
	time.Minute, time.Minute,
	5 * time.Minute, 5 * time.Minute,
	10 * time.Minute, 10 * time.Minute,
	30 * time.Minute, 30 * time.Minute,
}

const retryScheduleSteady = time.Hour

func (a *Agent) retryDelay(attempt int) time.Duration {
	if sched := a.RetrySchedule; len(sched) > 0 {
		if attempt < len(sched) {
			return sched[attempt]
		}
		return sched[len(sched)-1]
	}
	if attempt < len(defaultRetrySchedule) {
		return defaultRetrySchedule[attempt]
	}
	return retryScheduleSteady
}

func sleepRetry(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (a *Agent) dropLastAssistantMessage() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if n := len(a.messages); n > 0 && a.messages[n-1].Role == provider.RoleAssistant {
		a.messages = a.messages[:n-1]
		a.rev++
	}
}

// BuildContext derives the request context for the next model call
// from the live transcript without mutating it.
//
// Pipeline: snapshot -> filterHidden ->
// PruneOldToolResults -> repairToolUseResultPairs ->
// provider image mirror.
//
// Steps after the snapshot are request-only: mirrors never persist
// and never feed back into a.messages. Callers hold no lock; the
// snapshot is taken under mu and every step after that works on the
// copy.
func (a *Agent) BuildContext() []provider.Message {
	a.mu.Lock()
	msgs := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	clientName := ""
	if a.Client != nil {
		clientName = a.Client.Name()
	}
	a.mu.Unlock()

	return a.buildContextFromLocked(msgs, clientName)
}

// buildContextFromLocked runs the derivation pipeline over an
// already-snapshotted transcript. Both BuildContext (unlocked) and
// BuildContextLocked share it so the pipeline exists in one place.
func (a *Agent) buildContextFromLocked(msgs []provider.Message, clientName string) []provider.Message {
	msgs = filterHidden(msgs)
	msgs = PruneOldToolResults(msgs)
	msgs = repairToolUseResultPairs(msgs)
	if mirror := mirrorImagesForProvider(clientName, msgs); mirror != nil {
		msgs = append(msgs, *mirror)
	}
	return msgs
}

// BuildContextLocked is BuildContext for callers already holding mu.
// oneTurn uses it so the start-generation check and the transcript
// snapshot stay under the same lock; external callers use
// BuildContext.
func (a *Agent) BuildContextLocked() []provider.Message {
	msgs := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	clientName := ""
	if a.Client != nil {
		clientName = a.Client.Name()
	}
	return a.buildContextFromLocked(msgs, clientName)
}

// AddAssistantTextTransform appends an AssistantTextTransform used
// for visible-text emission (suppress/replace). The transcript
// always keeps the model's original output.
func (a *Agent) AddAssistantTextTransform(t AssistantTextTransform) {
	if t == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.AssistantTextTransforms = append(a.AssistantTextTransforms, t)
	a.rev++
}

// oneTurn calls the LLM once, forwards events, returns the stop reason
// and the assembled assistant message (already appended to the transcript).
func (a *Agent) oneTurn(ctx context.Context, sink func(AgentEvent)) (provider.StopReason, provider.Message, error) {
	if a.BeforeRequest != nil {
		if err := a.BeforeRequest(ctx); err != nil {
			return provider.StopError, provider.Message{}, err
		}
	}
	var req provider.Request
	for {
		if err := a.prepareStart(ctx); err != nil {
			return provider.StopError, provider.Message{}, err
		}
		a.mu.Lock()
		// A reset can also arrive after runLoop's preparation, for example
		// while BeforeTurn waits. Validate and snapshot under the same lock
		// so this request never receives an unprepared replacement prompt.
		if a.BeforeStart != nil && !a.startCurrentLocked() {
			a.mu.Unlock()
			continue
		}
		req = provider.Request{
			Model:  a.Model,
			System: a.System,
			// Derived request context: BuildContext snapshots the live
			// transcript and runs the context pipeline (hidden
			// filter -> prune -> repair -> provider mirror).
			// Request-only output never feeds back into a.messages.
			Messages:     a.BuildContextLocked(),
			Tools:        a.Tools.Specs(),
			Reasoning:    a.Reasoning,
			MaxTokens:    a.MaxTokens,
			Temperature:  a.Temperature,
			SessionID:    a.SessionID,
			MaxToolCalls: a.MaxToolCalls,
		}
		a.mu.Unlock()
		break
	}
	stream, err := a.Client.Stream(ctx, req)
	if err != nil {
		return provider.StopError, provider.Message{}, err
	}

	sink(EvAssistantStart{})

	var (
		stop     provider.StopReason
		finalErr error
		finalMsg provider.Message
	)
	var thinkingStart time.Time
	var thinkingTime time.Duration
	var hadThinking bool
	finishThinking := func() {
		if !thinkingStart.IsZero() {
			thinkingTime += time.Since(thinkingStart)
			thinkingStart = time.Time{}
		}
	}

	for ev := range stream {
		switch e := ev.(type) {
		case provider.EventStart:
			// nothing
		case provider.EventTextDelta:
			finishThinking()
			sink(EvTextDelta{Delta: e.Delta})
		case provider.EventReasoningDelta:
			hadThinking = true
			if thinkingStart.IsZero() {
				thinkingStart = time.Now()
			}
			sink(EvReasoningDelta{Delta: e.Delta})
		case provider.EventToolStart:
			finishThinking()
			sink(EvToolUseStart{ID: e.ID, Name: e.Name})
		case provider.EventToolArgs:
			sink(EvToolUseArgs{ID: e.ID, Delta: e.Delta})
		case provider.EventToolEnd:
			sink(EvToolUseEnd{ID: e.ID})
		case provider.EventUsage:
			cum := a.cost.Add(e.Usage)
			sink(EvUsage{Usage: e.Usage, Cumulative: cum})
			if a.OnUsage != nil {
				a.OnUsage(cum)
			}
		case provider.EventDone:
			stop = e.Stop
			finalErr = e.Err
			finalMsg = e.Message
		}
	}
	finishThinking()
	if !hadThinking {
		for _, c := range finalMsg.Content {
			if _, ok := c.(provider.ReasoningBlock); ok {
				hadThinking = true
				break
			}
		}
	}
	if hadThinking || thinkingTime > 0 {
		meta := map[string]string{}
		for k, v := range finalMsg.Meta {
			meta[k] = v
		}
		meta["thinking_ms"] = fmt.Sprintf("%d", max(1, thinkingTime.Milliseconds()))
		finalMsg.Meta = meta
	}

	// Append assistant message to transcript. Aborted turns (Esc / Ctrl+C)
	// produce partial content. Preserve visible text and reasoning, removing
	// only unfinished calls so the next request has no unmatched tool_use.
	keep := len(finalMsg.Content) > 0
	if stop == provider.StopAborted && keep {
		content := []provider.Content{}
		for _, c := range finalMsg.Content {
			if _, ok := c.(provider.ToolCallBlock); !ok {
				content = append(content, c)
			}
		}
		finalMsg.Content = content
		keep = len(content) > 0
	}
	if keep {
		emit := finalMsg
		suppress := false

		// AssistantTextTransforms: extensions suppress or rewrite
		// visible text as stackable transforms. The transcript keeps
		// the model's original output so the model still sees what
		// it said on subsequent turns.
		a.mu.Lock()
		textTransforms := append([]AssistantTextTransform(nil), a.AssistantTextTransforms...)
		a.mu.Unlock()
		emit, suppressed := applyAssistantTextTransforms(finalMsg, textTransforms)
		suppress = suppressed

		a.stampTurn(&finalMsg)
		a.mu.Lock()
		a.messages = append(a.messages, finalMsg)
		a.rev++
		a.mu.Unlock()
		a.fireMessageAppended(finalMsg)
		if !suppress {
			sink(EvAssistantMessage{Message: emit})
		}
		// Now surface tool calls as EvToolCall events so UIs can render them
		// in order before the tool results arrive.
		for _, c := range finalMsg.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok {
				sink(EvToolCall{ID: tc.ID, Name: tc.Name, Args: tc.Arguments})
			}
		}
	}

	return stop, finalMsg, finalErr
}

// executeTools runs every tool call in the assistant message and returns
// a single tool-role message carrying all results.
func (a *Agent) executeTools(ctx context.Context, msg provider.Message, sink func(AgentEvent)) (provider.Message, bool) {
	var results []provider.Content
	var addedTools []string
	hadError := false

	for _, c := range msg.Content {
		tc, ok := c.(provider.ToolCallBlock)
		if !ok || tc.Server {
			continue
		}
		res := a.runOneTool(ctx, tc, sink)
		if res.IsError {
			hadError = true
		}
		results = append(results, provider.ToolResultBlock{
			StartedAt: res.StartedAt, DurationMs: res.DurationMs,
			CallID:  tc.ID,
			Content: res.Content,
			IsError: res.IsError,
			Details: res.Details,
		})
		for _, name := range res.ActivateTools {
			if _, err := a.Tools.Get(name); err == nil && !containsString(addedTools, name) {
				addedTools = append(addedTools, name)
			}
		}
		sink(EvToolResult{ID: tc.ID, Result: res, Details: res.Details})
	}

	return provider.Message{
		Role:           provider.RoleTool,
		Content:        results,
		Time:           time.Now(),
		AddedToolNames: addedTools,
	}, hadError
}

func (a *Agent) runOneTool(ctx context.Context, tc provider.ToolCallBlock, sink func(AgentEvent)) ToolResult {
	tool, err := a.Tools.Get(tc.Name)
	if err != nil {
		return ToolResult{
			Content: []provider.Content{provider.TextBlock{Text: err.Error()}},
			IsError: true,
		}
	}

	args := tc.Arguments

	// Intercept hook: an extension or other guard can refuse the
	// call before any side effect happens, OR rewrite the args
	// seen by the tool. The model sees the reason as the tool
	// error, learns from it, and (typically) proposes a different
	// action; rewrites are invisible to the model (they apply only
	// to the execution).
	if a.BeforeToolExecute != nil {
		allowed, reason, modified := a.BeforeToolExecute(tc)
		if !allowed {
			if reason == "" {
				reason = "tool call refused by extension guard"
			}
			return ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: reason}},
				IsError: true,
			}
		}
		if len(modified) > 0 && json.Valid(modified) {
			args = modified
		}
	}

	if len(args) == 0 {
		args = json.RawMessage("{}")
	}

	// Recover panics so a buggy tool does not crash the agent.
	started := time.Now()
	sink(EvToolExecutionStart{ID: tc.ID, StartedAt: started.UnixMilli()})
	var res ToolResult
	func() {
		defer func() {
			if r := recover(); r != nil {
				res = ToolResult{
					Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("panic: %v", r)}},
					IsError: true,
				}
			}
		}()
		out, err := tool.Execute(ctx, args, func(text string) {
			sink(EvToolProgress{ID: tc.ID, Text: text})
		})
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				res = ToolResult{
					Content: []provider.Content{provider.TextBlock{Text: "aborted: " + err.Error()}},
					IsError: true,
				}
				return
			}
			res = ToolResult{
				Content: []provider.Content{provider.TextBlock{Text: err.Error()}},
				IsError: true,
			}
			return
		}
		res = out
	}()
	res.StartedAt = started.UnixMilli()
	res.DurationMs = time.Since(started).Milliseconds()
	return res
}

// extractText concatenates all TextBlock content in a message. Used
// by BeforeAssistantMessage so guards see a single string instead of
// having to walk provider.Content themselves.
func mirrorToolImagesAsUser(msg provider.Message) provider.Message {
	var content []provider.Content
	for _, c := range msg.Content {
		tr, ok := c.(provider.ToolResultBlock)
		if !ok {
			continue
		}
		for _, inner := range tr.Content {
			switch v := inner.(type) {
			case provider.TextBlock:
				// Keep short textual context so the model understands why
				// the images appeared, but don't duplicate giant read
				// outputs verbatim.
				if len(v.Text) > 0 && len(v.Text) <= 500 {
					content = append(content, v)
				}
			case provider.ImageBlock:
				content = append(content, v)
			}
		}
	}
	if len(content) == 0 {
		return provider.Message{}
	}
	prefix := provider.TextBlock{Text: "Tool output included the following image content:"}
	content = append([]provider.Content{prefix}, content...)
	return provider.Message{Role: provider.RoleUser, Content: content, Time: time.Now()}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func extractText(msg provider.Message) string {
	var out string
	for _, c := range msg.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			if out != "" {
				out += "\n"
			}
			out += tb.Text
		}
	}
	return out
}

// replaceText returns a copy of msg with every TextBlock replaced by
// a single TextBlock containing replacement. Non-text content (tool
// calls, etc.) is preserved in order.
func replaceText(msg provider.Message, replacement string) provider.Message {
	out := provider.Message{Role: msg.Role}
	out.Content = make([]provider.Content, 0, len(msg.Content))
	replaced := false
	for _, c := range msg.Content {
		if _, ok := c.(provider.TextBlock); ok {
			if !replaced {
				out.Content = append(out.Content, provider.TextBlock{Text: replacement})
				replaced = true
			}
			continue
		}
		out.Content = append(out.Content, c)
	}
	if !replaced {
		out.Content = append(out.Content, provider.TextBlock{Text: replacement})
	}
	return out
}
