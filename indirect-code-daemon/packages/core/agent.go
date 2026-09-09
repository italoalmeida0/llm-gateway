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

// Agent is a stateful conversation bound to a provider client, a model,
// and a set of tools.
type Agent struct {
	Client      provider.Client
	Model       string
	System      string
	Tools       Registry
	MaxSteps    int
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

	// Transforms shapes the derived request context every turn without
	// touching the live transcript. Typical uses: AGENTS.md/skills/memory
	// injection, project-context rewrites. Runs inside BuildContext
	// after prune+repair, before provider mirror and reminders.
	//
	// Rules: do not mutate the input slice; keep tool_call/tool_result
	// pairs intact; never persist the result (request-only).
	Transforms []ContextTransformer

	// AssistantTextTransforms rewrites visible assistant text
	// (suppress or replace) for UI emission. Replaces the removed
	// BeforeAssistantMessage hook as a stackable transform: the
	// transcript always keeps the model's original output.
	AssistantTextTransforms []AssistantTextTransform

	// RemindersForTurn, if set, returns synthetic non-persisted
	// reminders appended to the request context (system
	// reminders — pending approvals, compaction notices, queued
	// messages). Called on the agent goroutine per model call.
	// Defaults to collectReminders (registered ReminderProviders);
	// hosts may override for custom reminder sets.
	RemindersForTurn func() []Reminder

	// WindowForTurn, if set, returns the active model context window
	// in tokens. The host owns the provider.Model; core only reads
	// the window for pressure-driven reminders (compactionReminder)
	// via compactionPressure. Nil/0 disables window-based reminders.
	WindowForTurn func() int

	// MaxRetries controls agent-level retries for transient provider
	// failures that arrive after the HTTP stream opens (for example
	// Anthropic overloaded_error). Zero disables this retry layer.
	// RetryBaseDelay is doubled for each attempt; zero uses 2s.
	MaxRetries     int
	RetryBaseDelay time.Duration

	// OnEvent, if set, mirrors every AgentEvent the loop emits to
	// this callback in addition to the per-Prompt sink. Used by the
	// extension manager to fan events out to subscribed extensions
	// without each caller having to compose sinks manually.
	OnEvent func(AgentEvent)

	// OnMessageAppended, if set, fires every time a message is
	// appended to the in-memory transcript by the agent loop — the
	// initial user prompt, each finalised assistant message, and
	// each tool-results message. Derived context (provider image
	// mirrors, reminders, transform output) never fires this hook:
	// it exists only in the request, never in the transcript.
	// Hosts wire this to the on-disk session so that turns are
	// durable as soon as they happen, instead of only being
	// flushed on a clean exit.
	OnMessageAppended func(provider.Message)

	// OnUsage, if set, fires after every turn's usage row arrives,
	// carrying the cumulative usage for the session. Hosts wire
	// this to the on-disk session so the persisted total stays
	// current and a crash recovers the right cost figure.
	OnUsage func(cumulative provider.Usage)

	// OnTranscriptCompacted, if set, fires after Compact advances the
	// chain head, receiving the PROJECTED context (synthetic summary +
	// kept tail — what the model sees next), NOT a replacement
	// transcript. History stays append-only; hosts that mirror the
	// session file must keep their full history and persist the chain
	// via OnCompactionState. Kept for legacy hosts; new wiring should
	// prefer OnCompactionState.
	OnTranscriptCompacted func(messages []provider.Message)

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

	// queued holds user messages submitted while the agent is busy.
	// The loop appends them as normal user messages at safe
	// boundaries: before the next model call after a tool batch, or
	// after a text-only assistant turn finishes. It never interrupts
	// a running tool or cancels an in-flight provider request.
	queued []string

	// reminderProviders produce synthetic non-persisted reminders
	// consumed by BuildContext (see reminders.go).
	reminderProviders []ReminderProvider
	// store, when attached via AttachStore, is the persistence
	// backend (SessionStore). The agent loop writes messages, usage
	// and compaction checkpoints through it; Compact persists its
	// checkpoint through it mandatorily.
	store SessionStore
	// defaultRemindersWired guards WireDefaultReminders idempotency.
	defaultRemindersWired bool
}

// NewAgent returns an Agent with sensible defaults.
func NewAgent(client provider.Client, model, system string, tools Registry) *Agent {
	a := &Agent{
		Client:         client,
		Model:          model,
		System:         system,
		Tools:          tools,
		MaxSteps:       0, // 0 = unlimited
		MaxRetries:     3,
		RetryBaseDelay: 2 * time.Second,
	}
	// Default wiring: derive RemindersForTurn from registered
	// providers unless the host overrides it explicitly.
	a.RemindersForTurn = a.collectReminders
	return a
}

// QueueMessage queues text to be injected as a user message at the
// next safe boundary of the active agent loop. It is non-blocking in
// the sense that it never waits for model/tool work; it only takes
// the transcript mutex briefly. Empty/whitespace-only messages are
// ignored.
func (a *Agent) QueueMessage(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	a.mu.Lock()
	a.queued = append(a.queued, text)
	a.mu.Unlock()
	return true
}

// PendingQueuedMessages returns a snapshot of user messages waiting
// to be injected. Used by hosts to render the visible "sliding in"
// chips without consuming them.
func (a *Agent) PendingQueuedMessages() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.queued))
	copy(out, a.queued)
	return out
}

// QueuedMessageCount returns the number of messages waiting to be
// injected at the next safe boundary.
func (a *Agent) QueuedMessageCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.queued)
}

// PopQueuedMessage removes and returns the most recently queued
// message. Hosts use this for the slide-back keybinding.
func (a *Agent) PopQueuedMessage() (string, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	n := len(a.queued)
	if n == 0 {
		return "", false
	}
	text := a.queued[n-1]
	a.queued = a.queued[:n-1]
	return text, true
}

// DrainQueuedMessages discards and returns every queued message.
// Hosts use this on explicit cancel/clear so stale follow-ups do
// not run after the user aborted the turn.
func (a *Agent) DrainQueuedMessages() []string {
	return a.drainQueuedMessages()
}

func (a *Agent) drainQueuedMessages() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.queued))
	copy(out, a.queued)
	a.queued = nil
	return out
}

func (a *Agent) appendQueuedAsUser(texts []string, sink func(AgentEvent)) {
	for _, text := range texts {
		msg := provider.Message{
			Role:    provider.RoleUser,
			Content: []provider.Content{provider.TextBlock{Text: text}},
			Time:    time.Now(),
		}
		a.mu.Lock()
		a.messages = append(a.messages, msg)
		a.rev++
		a.mu.Unlock()
		a.fireMessageAppended(msg)
		if sink != nil {
			sink(EvUserMessage{Message: msg})
		}
	}
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

// fireMessageAppended persists through the attached store (if any)
// and invokes OnMessageAppended without holding the agent mutex, so
// the host's persistence callback can take its own locks without
// deadlocking the agent loop. Tolerates a nil hook so non-persisting
// callers (tests, RPC mode) don't have to set it. Ephemeral rows
// (MetaEphemeral, e.g. reminders/mirrors) never reach here: they
// exist only in the derived request context, never in a.messages.
func (a *Agent) fireMessageAppended(m provider.Message) {
	a.mu.Lock()
	cb := a.OnMessageAppended
	store := a.store
	a.mu.Unlock()
	if store != nil && !isEphemeralRow(m) {
		_ = store.AppendMessage(m)
	}
	if cb != nil {
		cb(m)
	}
}

// isEphemeralRow reports whether m is request-only derived context
// (reminder, provider mirror) that must never persist.
func isEphemeralRow(m provider.Message) bool {
	return m.Meta != nil && m.Meta[MetaEphemeral] == "true"
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
	for step := 1; a.MaxSteps <= 0 || step <= a.MaxSteps; step++ {
		// Preparation is cached across steps and user messages. Only an
		// explicit prompt/model/session change invokes BeforeStart again.
		if err := a.prepareStart(ctx); err != nil {
			sink(EvDone{})
			return err
		}
		// Messages queued while the agent was busy are delivered
		// before the next model call. This is the safe boundary:
		// any previous tool batch has already completed and its
		// results have been appended, but no new provider request has
		// started yet.
		if pending := a.drainQueuedMessages(); len(pending) > 0 {
			a.appendQueuedAsUser(pending, sink)
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
			if sleepErr := sleepRetry(ctx, a.retryDelay(attempt)); sleepErr != nil {
				return sleepErr
			}
		}
		if err != nil {
			return err
		}

		if stop == provider.StopToolUse {
			// Execute each client tool call, append a single tool-results message, continue.
			toolMsg, hadError := a.executeTools(ctx, assistantMsg, sink)
			if len(toolMsg.Content) == 0 {
				// Provider-executed (server) tools need no client results.
				continue
			}
			a.mu.Lock()
			a.messages = append(a.messages, toolMsg)
			a.rev++
			a.mu.Unlock()
			a.fireMessageAppended(toolMsg)
			// Note: the provider image mirror (openai/openai-codex) is
			// derived per-turn inside BuildContext now — it is request-only
			// and never appended to the transcript. filterHidden drops
			// legacy mirrors persisted by older builds so they are not
			// duplicated in the request.
			// If context was cancelled during tool execution, bail out.
			if err := ctx.Err(); err != nil {
				sink(EvDone{})
				return err
			}
			_ = hadError
			continue
		}

		// If the assistant stopped without tool calls but a message was
		// queued while it was speaking, loop once more so that message
		// is appended and answered instead of waiting until a later
		// top-level prompt.
		if ctx.Err() == nil && a.QueuedMessageCount() > 0 {
			continue
		}

		// Terminal stop (end, length, error, aborted).
		sink(EvDone{})
		return nil
	}
	if a.MaxSteps > 0 {
		sink(EvDone{})
		return fmt.Errorf("max steps (%d) exceeded", a.MaxSteps)
	}
	return nil
}

func (a *Agent) canRetryError(err error, attempt int) bool {
	if err == nil || a.MaxRetries <= 0 || attempt >= a.MaxRetries {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	msg := strings.ToLower(err.Error())
	if msg == "" || isNonRetryableProviderLimit(msg) {
		return false
	}
	needles := []string{
		"overloaded", "provider returned error", "rate limit", "ratelimit", "too many requests",
		"429", "http 429", "500", "http 500", "502", "http 502", "503", "http 503", "504", "http 504",
		"service unavailable", "server error", "internal error", "network error", "connection error",
		"connection refused", "connection lost", "fetch failed", "upstream connect", "reset before headers",
		"socket hang up", "ended without", "stream ended before", "did not get a response", "timed out",
		"timeout", "terminated", "unexpected eof", "transport failure",
		// OpenAI's ChatGPT/Codex backend returns this generic message (with a
		// request ID) for transient server failures and explicitly says
		// "You can retry your request".
		"an error occurred while processing your request",
		// Explicit retry guidance emitted by provider backends (OpenAI
		// Responses, AWS Bedrock stream exceptions) with varying prefixes.
		"you can retry your request", "try your request again", "please retry your request",
		// Capacity messages from the ChatGPT/Codex backend, e.g.
		// "Our servers are currently overloaded. Please try again later."
		// The trailing advice also shows up on its own for transient
		// capacity failures; usage/quota limits are filtered out above by
		// isNonRetryableProviderLimit before this list is consulted.
		"servers are currently overloaded", "servers are busy", "try again later",
	}
	for _, needle := range needles {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

func isNonRetryableProviderLimit(msg string) bool {
	needles := []string{
		"usage limit", "monthly usage limit", "freeusagelimit", "gousagelimit",
		"available balance", "insufficient_quota", "out of budget", "quota exceeded", "billing",
	}
	for _, needle := range needles {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

func (a *Agent) retryDelay(attempt int) time.Duration {
	base := a.RetryBaseDelay
	if base <= 0 {
		base = 2 * time.Second
	}
	return base * time.Duration(1<<attempt)
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
// PruneOldToolResults -> repairToolUseResultPairs -> Transforms[] ->
// provider image mirror -> RemindersForTurn.
//
// Steps after the snapshot are request-only: mirrors, transform
// output and reminders never persist and never feed back into
// a.messages. Callers hold no lock; the snapshot is taken under mu
// and every step after that works on the copy.
func (a *Agent) BuildContext() []provider.Message {
	a.mu.Lock()
	msgs := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	transforms := append([]ContextTransformer(nil), a.Transforms...)
	remindersFn := a.RemindersForTurn
	clientName := ""
	if a.Client != nil {
		clientName = a.Client.Name()
	}
	a.mu.Unlock()

	var reminders []Reminder
	if remindersFn != nil {
		reminders = remindersFn()
	}
	return a.buildContextFromLocked(msgs, transforms, reminders, clientName)
}

// buildContextFromLocked runs the derivation pipeline over an
// already-snapshotted transcript. Both BuildContext (unlocked) and
// BuildContextLocked share it so the pipeline exists in one place.
func (a *Agent) buildContextFromLocked(msgs []provider.Message, transforms []ContextTransformer, reminders []Reminder, clientName string) []provider.Message {
	msgs = filterHidden(msgs)
	msgs = PruneOldToolResults(msgs)
	msgs = repairToolUseResultPairs(msgs)
	for _, t := range transforms {
		if t == nil {
			continue
		}
		if out := t(msgs); out != nil {
			msgs = out
		}
	}
	if mirror := mirrorImagesForProvider(clientName, msgs); mirror != nil {
		msgs = append(msgs, *mirror)
	}
	msgs = injectReminders(msgs, reminders)
	return msgs
}

// BuildContextLocked is BuildContext for callers already holding mu.
// oneTurn uses it so the start-generation check and the transcript
// snapshot stay under the same lock; external callers use
// BuildContext.
func (a *Agent) BuildContextLocked() []provider.Message {
	// No pre-collected reminders available and the caller holds mu:
	// skip reminder collection (collectReminders needs mu). oneTurn
	// uses BuildContextLockedWith with reminders collected before
	// locking. External locked callers that need reminders should
	// collect them before taking mu.
	return a.BuildContextLockedWith(nil, true)
}

// BuildContextLockedWith derives context while the caller holds mu.
// Pass pre-collected reminders when the reminder fn needs the lock
// (collectReminders does); useCollected=true skips in-lock collection.
// oneTurn pre-collects before locking to avoid self-deadlock.
func (a *Agent) BuildContextLockedWith(precollected []Reminder, useCollected bool) []provider.Message {
	msgs := projectMessages(append([]provider.Message(nil), a.messages...), a.compactionStateLocked())
	transforms := append([]ContextTransformer(nil), a.Transforms...)
	remindersFn := a.RemindersForTurn
	clientName := ""
	if a.Client != nil {
		clientName = a.Client.Name()
	}
	var reminders []Reminder
	if useCollected {
		reminders = precollected
	} else if remindersFn != nil {
		// Only safe when remindersFn never touches a.mu.
		reminders = remindersFn()
	}
	return a.buildContextFromLocked(msgs, transforms, reminders, clientName)
}

// AddTransform appends a ContextTransformer to the agent's pipeline.
// Safe for concurrent use; takes effect on the next model call.
func (a *Agent) AddTransform(t ContextTransformer) {
	if t == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.Transforms = append(a.Transforms, t)
	a.rev++
}

// AttachStore sets the persistence backend for the agent loop and
// compaction checkpoints. Safe for concurrent use. A nil store
// detaches (legacy callback-only mode: OnMessageAppended /
// OnTranscriptCompacted keep working, nothing is written by core).
func (a *Agent) AttachStore(st SessionStore) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.store = st
	a.rev++
}

// Store returns the attached SessionStore, or nil.
func (a *Agent) Store() SessionStore {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.store
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
		// Collect reminders BEFORE locking: the default fn
		// (collectReminders) takes a.mu itself. Request-only output.
		a.mu.Lock()
		remindersFn := a.RemindersForTurn
		a.mu.Unlock()
		var turnReminders []Reminder
		if remindersFn != nil {
			turnReminders = remindersFn()
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
			// filter -> prune -> repair -> Transforms -> provider
			// mirror -> reminders). Request-only output never
			// feeds back into a.messages.
			Messages:     a.BuildContextLockedWith(turnReminders, true),
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
			a.mu.Lock()
			usageStore := a.store
			a.mu.Unlock()
			if usageStore != nil {
				_ = usageStore.AppendUsage(e.Usage, cum)
			}
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
