package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// TurnJournal is the crash-recovery record for one running turn, stored in
// a sidecar file next to the session (<id>.turn.json) — never inside the
// session record itself, so history pulls and the sessions mirror stay
// lean no matter how much incoming content a turn accumulates.
//
// On-disk rule: a turn's data lives in exactly one place. While the turn
// runs, only the journal exists (incoming snapshot, no final balloon).
// When the turn truly ends (AI finished or user cancelled), the final
// balloon (if any) is appended to the record and the journal is deleted.
// Nothing else ends a turn: provider errors retry inside the loop, so a
// journal left behind can only mean the process died mid-turn.
type TurnJournal struct {
	TurnIndex int                     `json:"turnIndex"`
	StartedAt int64                   `json:"startedAt"`
	Model     string                  `json:"model,omitempty"`
	Incoming  []filetrack.TrackedFile `json:"incoming,omitempty"`
}

// brainDir resolves the per-session private scratch space
// (<dataDir>/brain/<sessionID>), refusing traversal. It is created lazily
// and allowed through the jail so the model always has somewhere to put
// temporary files, test scripts and experiment output.
func (d *DaemonServer) brainDir(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(d.dataDir, "brain", sessionID)
}

// ensureBrainDir creates the scratch space (0700, like the data dir).
// Returns "" when the session id is unusable.
func (d *DaemonServer) ensureBrainDir(sessionID string) string {
	dir := d.brainDir(sessionID)
	if dir == "" {
		return ""
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// turnJournalPath resolves the sidecar path, refusing traversal.
func (d *DaemonServer) turnJournalPath(sessionID string) string {
	if sessionID == "" || filepath.Base(sessionID) != sessionID {
		return ""
	}
	return filepath.Join(d.sessionsDir(), sessionID+".turn.json")
}

// writeTurnJournal persists the journal atomically (tmp + rename), without
// a sessions change ping: the journal is daemon-internal, no mirror reads
// it, so per-tool-tick checkpoints must not fan out to clients.
func (d *DaemonServer) writeTurnJournal(sessionID string, j *TurnJournal) {
	p := d.turnJournalPath(sessionID)
	if p == "" {
		return
	}
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return
	}
	if err := os.MkdirAll(d.sessionsDir(), 0o700); err != nil {
		return
	}
	tmp, err := os.CreateTemp(d.sessionsDir(), ".turn-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return
	}
	if err = tmp.Close(); err != nil {
		return
	}
	_ = os.Rename(tmp.Name(), p)
}

// readTurnJournal returns nil (no error) when no journal exists.
func (d *DaemonServer) readTurnJournal(sessionID string) (*TurnJournal, error) {
	p := d.turnJournalPath(sessionID)
	if p == "" {
		return nil, nil
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var j TurnJournal
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, err
	}
	return &j, nil
}

func (d *DaemonServer) deleteTurnJournal(sessionID string) {
	if p := d.turnJournalPath(sessionID); p != "" {
		_ = os.Remove(p)
	}
}

func (d *DaemonServer) scanTurnJournals() []string {
	entries, err := os.ReadDir(d.sessionsDir())
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".turn.json") {
			continue
		}
		out = append(out, strings.TrimSuffix(name, ".turn.json"))
	}
	return out
}

// turnRun carries the per-turn execution state shared by fresh turns and
// crash-recovered resumes: one agent setup, one event sink, one finalizer.
type turnRun struct {
	d           *DaemonServer
	cfg         DaemonConfig
	act         *ActiveSession
	sessionID   string
	sessionCWD  string
	modelToUse  string
	turnIndex   int
	tfc         *turnFileChanges
	ctx         context.Context
	myGen       int
	options     SessionOptions
	turnStarted TurnActivity
	agent       *core.Agent
	client      provider.Client
	modelInfo   provider.Model
	reg         core.Registry
	previewTick int
}

// setupAgent builds the provider client, tools, registry, agent and all
// turn hooks. Returns false when the turn was superseded before the first
// model call (caller must return; the deferred finalizer still runs).
func (r *turnRun) setupAgent() bool {
	apiBase := strings.TrimRight(r.cfg.GatewayURL, "/") + "/anthropic/v1"
	r.modelInfo = gatewayModel(r.ctx, r.cfg.GatewayURL, r.cfg.DaemonToken, r.modelToUse)
	if effort := canonicalReasoning(r.options.Effort); effort != "" && effort != "none" {
		r.modelInfo.Reasoning = true
	}
	r.client = provider.NewGatewayAnthropic(r.cfg.APIKey, apiBase, r.modelInfo)

	// Setup local filesystem tools rooted at session's CWD
	sb := tools.NewSandbox(r.sessionCWD)
	// Per-session scratch space: always writable, jail or not.
	brainDir := r.d.ensureBrainDir(r.sessionID)
	if brainDir != "" {
		sb.AllowExtra(brainDir)
	}
	if r.cfg.Settings.JailByDefault {
		sb.Lock()
	}

	baseTools := []core.Tool{
		&tools.ReadTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir},
		&tools.WriteTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir},
		&tools.EditTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir},
		&tools.BashTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.GlobTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.SearchTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.InspectTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.SearchWebTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.FetchURLTool{CWD: r.sessionCWD, Sandbox: sb},
	}
	// The python tool is only advertised when a Python 3 interpreter exists
	// on this machine (PythonAvailable probes PATH once and caches).
	if _, err := tools.PythonAvailable(); err == nil {
		baseTools = append(baseTools, &tools.PythonTool{CWD: r.sessionCWD, Sandbox: sb})
	}

	questionTool := &tools.QuestionTool{Ask: func(tctx context.Context, req tools.QuestionRequest) ([][]string, error) {
		return r.d.askQuestions(tctx, r.act, r.myGen, r.cfg.HostID, req)
	}}
	todoTool := &tools.TodoTool{Update: func(items []tools.TodoItem) error {
		r.act.mu.Lock()
		defer r.act.mu.Unlock()
		if r.act.gen != r.myGen || r.ctx.Err() != nil {
			return context.Canceled
		}
		r.act.record.Todos = append([]tools.TodoItem{}, items...)
		if err := r.d.saveSession(r.act.record); err != nil {
			return err
		}
		_ = r.d.sendWS(map[string]any{"type": "agent_event", "hostId": r.cfg.HostID, "sessionId": r.sessionID, "event": map[string]any{"type": "todo_update", "items": items}})
		return nil
	}}
	r.reg = core.NewRegistry(append(append(baseTools, questionTool), todoTool)...)

	r.agent = core.NewAgent(r.client, r.modelToUse, systemPromptWithBrain(r.cfg, r.sessionCWD, r.options, brainDir), r.reg)
	r.agent.TurnIndex = r.turnIndex
	r.agent.Reasoning = r.options.Effort
	// Only the agent goroutine changes runtime fields. Commands write the session;
	// each request reads a fresh snapshot, after the preceding tool batch finishes.
	r.agent.BeforeRequest = func(requestCtx context.Context) error {
		for {
			r.act.mu.Lock()
			if r.act.gen != r.myGen || requestCtx.Err() != nil {
				r.act.mu.Unlock()
				return context.Canceled
			}
			nextModel := r.act.record.Model
			nextOptions := normalizedOptions(r.act.record.Options)
			r.act.mu.Unlock()
			if nextModel != r.modelInfo.ID {
				r.modelInfo = gatewayModel(requestCtx, r.cfg.GatewayURL, r.cfg.DaemonToken, nextModel)
			}
			// Metadata lookup may take time: re-read choices before building the request.
			r.act.mu.Lock()
			if r.act.gen != r.myGen || requestCtx.Err() != nil {
				r.act.mu.Unlock()
				return context.Canceled
			}
			if r.act.record.Model != nextModel {
				r.act.mu.Unlock()
				continue
			}
			nextOptions = normalizedOptions(r.act.record.Options)
			if r.modelInfo.ID != nextModel {
				r.act.record.Model = r.modelInfo.ID
				_ = r.d.saveSession(r.act.record)
				_ = r.d.sendWS(map[string]any{"type": "session_data", "hostId": r.cfg.HostID, "session": liveSessionPayload(r.act)})
			}
			r.act.mu.Unlock()
			requestModel := r.modelInfo
			if nextOptions.Effort != "none" {
				requestModel.Reasoning = true
			}
			r.client = provider.NewGatewayAnthropic(r.cfg.APIKey, apiBase, requestModel)
			r.modelToUse = r.modelInfo.ID
			r.agent.Client, r.agent.Model, r.agent.Reasoning = r.client, r.modelToUse, nextOptions.Effort
			r.agent.MaxTokens = maxOutputTokens(r.modelInfo)
			r.d.configMu.RLock()
			system := systemPromptWithBrain(*r.d.config, r.sessionCWD, nextOptions, brainDir)
			r.d.configMu.RUnlock()
			r.agent.SetSystem(system)
			available := core.Registry{}
			for name, tool := range r.reg {
				available[name] = tool
			}
			restrictModeTools(available, nextOptions.Mode)
			r.agent.SetTools(available)
			return nil
		}
	}
	r.agent.Temperature = &r.cfg.Settings.Temperature
	r.agent.MaxTokens = maxOutputTokens(r.modelInfo)
	r.act.mu.Lock()
	if r.act.gen != r.myGen || r.ctx.Err() != nil {
		r.act.mu.Unlock()
		return false
	}
	if len(r.act.record.Messages) > 0 {
		r.agent.SetMessages(r.act.record.Messages)
	}
	r.agent.SeedCost(r.act.record.Usage)
	r.agent.SeedCompactionState(r.act.record.Compaction)
	r.act.agent = r.agent
	r.act.mu.Unlock()

	// Read the live session access policy before every tool, including reads.
	r.agent.BeforeToolExecute = r.d.toolApprovalHook(r.ctx, r.act, r.myGen, r.cfg.HostID)

	// Persistent transcript hook: whenever a message is added, record it
	r.agent.OnMessageAppended = func(m provider.Message) {
		r.act.mu.Lock()
		if r.act.gen != r.myGen {
			r.act.mu.Unlock()
			return
		}
		if m.Role == provider.RoleAssistant {
			r.act.live = nil
		}
		if m.TurnIndex == 0 {
			m.TurnIndex = r.turnIndex
		}
		r.act.record.Messages = append(r.act.record.Messages, m)
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		_ = r.d.saveSession(r.act.record)
		r.act.mu.Unlock()
	}

	// Persistent compaction hook: the chain head
	// advanced — history is append-only and never touched, so the only
	// state to persist is the anchor + summary + file ops. Broadcasts
	// the full history; the UI renders older messages as summarized.
	r.agent.OnCompactionState = func(state *core.CompactionState) {
		if state == nil {
			return
		}
		r.act.mu.Lock()
		if r.act.gen != r.myGen {
			r.act.mu.Unlock()
			return
		}
		r.act.record.Compaction = state
		r.act.record.Usage = r.agent.Cost()
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		r.act.record.Context = estimateContext(r.agent, r.modelInfo)
		rec := *r.act.record
		_ = r.d.saveSession(r.act.record)
		r.act.mu.Unlock()
		_ = r.d.sendWS(map[string]any{
			"type":       "session_compacted",
			"hostId":     r.cfg.HostID,
			"sessionId":  rec.ID,
			"messages":   rec.Messages,
			"context":    rec.Context,
			"compaction": rec.Compaction,
			"usage":      rec.Usage,
			"auto":       true,
		})
	}
	r.agent.OnUsage = func(cumulative provider.Usage) {
		r.act.mu.Lock()
		if r.act.gen == r.myGen {
			r.act.record.Usage = cumulative
			_ = r.d.saveSession(r.act.record)
		}
		r.act.mu.Unlock()
	}
	// Proactive in-run compaction. Checked by the agent loop before EVERY
	// model request, including mid-run after tool results: long runs
	// compact without first burning a request that overflows upstream.
	// The trigger (last-turn usage + trailing estimate vs.
	// window minus reserve) is authoritative; the configured threshold
	// (%) and usable-budget formula stay as early-trip wires.
	r.agent.AutoCompact = func(cctx context.Context, esink func(core.AgentEvent)) error {
		if cctx.Err() != nil {
			return nil
		}
		window := r.modelInfo.ContextWindow
		if window <= 0 {
			return nil
		}
		r.act.mu.Lock()
		genOK := r.act.gen == r.myGen
		historyLen := len(r.act.record.Messages)
		r.act.mu.Unlock()
		if !genOK || historyLen <= 4 {
			return nil
		}
		threshold := r.cfg.Settings.AutoCompactThreshold
		usage := r.agent.LastTurnUsage()
		msgs := r.agent.Messages() // projected context
		needs := core.ShouldCompact(window, core.UsageTotal(usage), core.TrailingTokens(msgs, usage))
		if !needs && threshold > 0 {
			used := core.UsageTotal(usage) + core.TrailingTokens(msgs, usage)
			needs = used*100 >= threshold*window
		}
		if !needs {
			// Usable formula stays as a final safety net:
			// contextWindow - outputBudget - 20,000 buffer.
			if usable := window - maxOutputTokens(r.modelInfo) - 20000; usable > 0 {
				used := core.UsageTotal(usage) + core.TrailingTokens(msgs, usage)
				needs = used >= usable
			}
		}
		if !needs {
			return nil
		}
		esink(core.EvToolProgress{Text: "Compacting older context…"})
		_, err := r.agent.MaybeAutoCompact(cctx, window, func(delta string) {
			esink(core.EvToolProgress{Text: delta})
		})
		return err
	}

	// Context must not depend on a turn being in flight: a fresh session
	// (or one cancelled before the first usage row) would otherwise show
	// 0/0% until the next usage event. Seed an estimate once; accurate
	// usage rows keep overwriting it afterwards.
	r.act.mu.Lock()
	if r.act.record.Context == nil {
		r.act.record.Context = estimateContext(r.agent, r.modelInfo)
		_ = r.d.saveSession(r.act.record)
	}
	r.act.mu.Unlock()

	return true
}

// handleEvent streams agent events to the WebSocket foreground.
func (r *turnRun) handleEvent(ev core.AgentEvent) {
	r.act.mu.Lock()
	defer r.act.mu.Unlock()
	if r.act.gen != r.myGen {
		return
	}
	trackLiveEvent(r.act, ev)
	payload := map[string]any{
		"type":      "agent_event",
		"hostId":    r.cfg.HostID,
		"sessionId": r.sessionID,
	}

	switch e := ev.(type) {
	case core.EvTurnStart:
		payload["event"] = map[string]any{"type": "turn_start", "step": e.Step}
	case core.EvAssistantMessage:
		payload["event"] = map[string]any{"type": "assistant_message", "message": e.Message, "index": len(r.act.record.Messages) - 1}
	case core.EvAssistantStart:
		payload["event"] = map[string]any{"type": "assistant_start"}
	case core.EvTextDelta:
		payload["event"] = map[string]any{"type": "text_delta", "delta": e.Delta}
	case core.EvReasoningDelta:
		payload["event"] = map[string]any{"type": "reasoning_delta", "delta": e.Delta}
	case core.EvToolUseStart:
		payload["event"] = map[string]any{"type": "tool_use_start", "id": e.ID, "name": e.Name}
	case core.EvToolUseArgs:
		payload["event"] = map[string]any{"type": "tool_use_args", "id": e.ID, "delta": e.Delta}
	case core.EvToolUseEnd:
		payload["event"] = map[string]any{"type": "tool_use_end", "id": e.ID}
	case core.EvToolProgress:
		payload["event"] = map[string]any{"type": "tool_progress", "id": e.ID, "text": e.Text}
	case core.EvToolCall:
		payload["event"] = map[string]any{
			"type": "tool_call", "id": e.ID, "name": e.Name, "args": e.Args,
		}
	case core.EvToolResult:
		var sb strings.Builder
		for _, c := range e.Result.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				sb.WriteString(tb.Text)
			}
		}
		contentStr := strings.ReplaceAll(sb.String(), tools.LinePrefixNotice, "")
		ev := map[string]any{
			"type": "tool_result", "id": e.ID, "content": contentStr, "isError": e.Result.IsError, "startedAt": e.Result.StartedAt, "durationMs": e.Result.DurationMs,
		}
		// Live incoming-changes preview: after each finished tool,
		// broadcast the current changed view. The tracker has its own
		// mutex, so this is safe under r.act.mu (sendWS locks wsMu, never
		// r.act.mu). Debounced to every 3rd tool result.
		r.previewTick++
		if r.tfc != nil && r.tfc.tracker.Count() > 0 && r.previewTick%5 == 0 {
			r.d.broadcastLiveChanges(r.cfg.HostID, r.sessionID, r.tfc)
			r.persistIncoming()
		}
		if e.Details != nil {
			if raw, err := json.Marshal(e.Details); err == nil {
				ev["details"] = json.RawMessage(raw)
			}
		}
		payload["event"] = ev
	case core.EvToolExecutionStart:
		payload["event"] = map[string]any{"type": "tool_execution_start", "id": e.ID, "startedAt": e.StartedAt}
	case core.EvUsage:
		r.act.record.Usage = e.Cumulative
		// An aborted stream reports an all-zero row (sendDone on cancel);
		// it carries no occupancy information and must not clobber a good
		// estimate (or an earlier accurate row) with zeros.
		contextUsage := r.act.record.Context
		if !isEmptyUsage(e.Usage) {
			contextUsage = contextFromUsage(e.Usage, r.modelInfo)
			r.act.record.Context = contextUsage
		}
		_ = r.d.saveSession(r.act.record)
		payload["event"] = map[string]any{
			"type": "usage", "usage": e.Usage, "cumulative": e.Cumulative, "context": contextUsage,
		}
	case core.EvTurnEnd:
		evMap := map[string]any{"type": "turn_end", "stop": string(e.Stop)}
		if r.ctx.Err() != nil {
			evMap["cancelled"] = true
		} else if e.Err != nil {
			evMap["error"] = e.Err.Error()
		}
		if r.agent != nil {
			evMap["usage"] = r.agent.LastTurnUsage()
			evMap["cumulative"] = r.agent.Cost()
		}
		payload["event"] = evMap
	case core.EvRetry:
		// Ignored by current frontends (if/else chain, no default):
		// metadata for future reconnecting UX, zero visual change.
		errText := ""
		if e.Err != nil {
			errText = e.Err.Error()
		}
		payload["event"] = map[string]any{
			"type": "retry", "attempt": e.Attempt,
			"delayMs": int64(e.Delay / time.Millisecond), "error": errText,
		}
	case core.EvDone:
		return // Task completion is emitted only after compaction and persistence.
	default:
		return
	}

	_ = r.d.sendWS(payload)
}

// finishTurn runs when the turn truly ends (AI finished, user cancelled):
// final balloon, journal removal (incoming and final never coexist on
// disk), idle flip, persistence and completion broadcast. Provider
// errors never reach a third ending — they retry inside the loop until
// success or cancellation.
func (r *turnRun) finishTurn() {
	// Snapshot-based file changes: build the final balloon, reset
	// incoming, persist, and broadcast. The balloon is persistent.
	if balloon := r.d.finishTurnTracking(r.act, r.tfc); balloon != nil {
		r.d.broadcastFileBalloon(r.cfg.HostID, r.sessionID, balloon)
	}
	// The turn truly ended: drop the crash journal. Incoming (journal)
	// and final (record balloon) never coexist on disk; a crash between
	// the balloon save above and this delete resumes into the abandon
	// path (balloon already present), never into a duplicate turn.
	r.d.deleteTurnJournal(r.sessionID)
	r.act.mu.Lock()
	r.act.fileChanges = nil
	r.act.mu.Unlock()
	r.act.mu.Lock()
	defer r.act.mu.Unlock()
	if r.act.gen != r.myGen {
		return
	}
	r.act.record.Status = "idle"
	finishTurnActivity(r.act, r.ctx.Err() != nil)
	r.act.pendingApproval = nil
	r.act.question = nil
	r.act.toolProgress = nil
	r.act.toolStarts = nil
	r.act.thinkingStartedAt = 0
	r.act.live = nil
	// Same seed as turn start: a turn cancelled before the first usage
	// row must still leave a context behind, never a nil that renders
	// as 0/0%. Only fills when missing; usage-derived values win.
	if r.act.record.Context == nil && r.agent != nil {
		r.act.record.Context = estimateContext(r.agent, r.modelInfo)
	}
	r.act.record.UpdatedAt = time.Now().UnixMilli()
	_ = r.d.saveSession(r.act.record)
	r.act.cancel = nil
	// Publish completion before a new turn can acquire this session.
	_ = r.d.sendWS(map[string]any{"type": "session_data", "hostId": r.cfg.HostID, "session": sessionPayload(r.act.record)})
	_ = r.d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    r.cfg.HostID,
		"sessionId": r.sessionID,
		"status":    "idle",
	})
}

// isEmptyUsage reports whether a usage row carries no token counts at
// all — the shape sendDone emits when a stream dies before its first
// usage event (e.g. user cancel). Such rows must never zero the context.
func isEmptyUsage(u provider.Usage) bool {
	return u.InputTokens == 0 && u.OutputTokens == 0 &&
		u.ReasoningTokens == 0 && u.CacheReadTokens == 0 && u.CacheWriteTokens == 0
}

// persistIncoming checkpoints the tracker's snapshot to the crash journal
// so a restart can continue tracking (and rebuild the live changes view)
// from it. Called on the live-preview tick, not per write.
func (r *turnRun) persistIncoming() {
	if r.tfc == nil || r.tfc.tracker.Count() == 0 {
		return
	}
	r.d.writeTurnJournal(r.sessionID, &TurnJournal{
		TurnIndex: r.turnIndex,
		StartedAt: r.turnStarted.StartedAt,
		Model:     r.modelToUse,
		Incoming:  r.tfc.tracker.Snapshot(),
	})
}

// resumeAgentTurn continues a turn interrupted by a daemon death: same
// turn index (numbering never advances for a turn that never ended),
// tracker restored from the journal, transcript replayed from disk via
// Continue (no duplicated user message).
func (d *DaemonServer) resumeAgentTurn(act *ActiveSession, j *TurnJournal) {
	d.configMu.RLock()
	cfg := *d.config
	d.configMu.RUnlock()
	now := time.Now().UnixMilli()
	act.mu.Lock()
	act.record.Status = "running"
	act.question = nil
	act.record.Turn = &TurnActivity{StartedAt: now, Status: "running"}
	act.toolProgress = map[string]string{}
	act.toolStarts = map[string]int64{}
	act.thinkingStartedAt = 0
	if act.record.Options.Access == "" {
		act.record.Options.Access = "ask"
	}
	act.record.UpdatedAt = now
	_ = d.saveSession(act.record)
	sessionID, sessionCWD := act.record.ID, act.record.CWD
	modelToUse := act.record.Model
	tfc := &turnFileChanges{
		tracker:   filetrack.RestoreTurnTracker(dropBrainTracked(j.Incoming, d.brainDir(sessionID))),
		turnIndex: j.TurnIndex,
		cwd:       sessionCWD,
		brainDir:  d.brainDir(sessionID),
	}
	act.fileChanges = tfc
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	act.cancel = cancel
	act.gen++
	myGen := act.gen
	options := normalizedOptions(act.record.Options)
	turnStarted := *act.record.Turn
	r := &turnRun{
		d: d, cfg: cfg, act: act,
		sessionID: sessionID, sessionCWD: sessionCWD,
		modelToUse: modelToUse, turnIndex: j.TurnIndex, tfc: tfc,
		ctx: ctx, myGen: myGen, options: options, turnStarted: turnStarted,
	}
	act.mu.Unlock()
	defer r.finishTurn()
	_ = d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    cfg.HostID,
		"sessionId": sessionID,
		"status":    "running",
		"turn":      turnStarted,
	})
	if !r.setupAgent() {
		return
	}
	defer func() {
		if !cfg.Settings.NoAutoTitle && r.ctx.Err() == nil {
			go d.maybeAutoTitle(r.act, r.myGen, r.client, r.modelToUse)
		}
	}()
	// Continue only returns on AI conclusion or context cancellation;
	// provider errors retry inside the loop, never surfacing here.
	if err := r.agent.Continue(r.ctx, func(ev core.AgentEvent) { r.handleEvent(ev) }); err != nil && r.ctx.Err() == nil {
		fmt.Printf("[WARN] resumed turn %d of session %s exited with live context: %v\n", r.turnIndex, r.sessionID, err)
	}
}

// resumeInterruptedTurns replays every crash journal found at boot: the
// turn continues where it died (same index, restored tracker, transcript
// from disk). A turn is only ever finished by the AI or by user cancel,
// never by a dead process, a dropped network, or a dead gateway.
func (d *DaemonServer) resumeInterruptedTurns() {
	for _, sid := range d.scanTurnJournals() {
		j, err := d.readTurnJournal(sid)
		if err != nil || j == nil || j.TurnIndex <= 0 {
			d.deleteTurnJournal(sid)
			continue
		}
		act, err := d.getOrCreateActiveSession(sid)
		if err != nil {
			// Session purged while the daemon was down: orphan journal.
			d.deleteTurnJournal(sid)
			continue
		}
		act.mu.Lock()
		rec := act.record
		abandon := turnResumeAbandoned(rec, j)
		blocked := !abandon && rec.CWD != "" && inspectWorkspace(rec.CWD).Status != "available"
		if !abandon && !blocked {
			rec.Status = "running"
			rec.UpdatedAt = time.Now().UnixMilli()
			_ = d.saveSession(rec)
		}
		act.mu.Unlock()
		switch {
		case abandon:
			fmt.Printf("[INFO] Dropping stale turn journal: %s (turn %d)\n", sid, j.TurnIndex)
			d.deleteTurnJournal(sid)
		case blocked:
			fmt.Printf("[INFO] Turn %d of %s waits for workspace; journal kept\n", j.TurnIndex, sid)
		default:
			fmt.Printf("[INFO] Resuming interrupted turn %d of session %s\n", j.TurnIndex, sid)
			go d.resumeAgentTurn(act, j)
		}
	}
}

// turnResumeAbandoned reports whether a journaled turn must NOT resume: it
// already produced its final balloon (crash landed in the finish window),
// or its opening user message never reached the disk (crash landed before
// the first append — nothing to continue).
func turnResumeAbandoned(rec *SessionRecord, j *TurnJournal) bool {
	for _, b := range rec.FileBalloons {
		if b.TurnIndex == j.TurnIndex {
			return true
		}
	}
	for _, m := range rec.Messages {
		if m.TurnIndex == j.TurnIndex {
			return false
		}
	}
	return true
}
