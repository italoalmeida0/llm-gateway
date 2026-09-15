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
	Prompt        string                  `json:"prompt,omitempty"`
	AttachmentIDs []string                `json:"attachmentIds,omitempty"`
	TurnIndex     int                     `json:"turnIndex"`
	StartedAt     int64                   `json:"startedAt"`
	Model         string                  `json:"model,omitempty"`
	Incoming      []filetrack.TrackedFile `json:"incoming,omitempty"`
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
	mcp         map[string]*mcpConnection
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
}

// setupAgent builds the provider client, tools, registry, agent and all
// turn hooks. Returns false when the turn was superseded before the first
// model call (caller must return; the deferred finalizer still runs).
func (r *turnRun) setupAgent() bool {
	r.tfc.tracker.OnChange = func() {
		r.act.mu.Lock()
		defer r.act.mu.Unlock()
		if r.act.gen == r.myGen {
			r.persistIncoming()
		}
	}
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
		&tools.ReadTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir, Convert: func(tctx context.Context, filename string, b64data string) (string, error) {
			return r.d.requestFileConvert(tctx, r.act, r.myGen, r.cfg.HostID, filename, b64data)
		}},
		&tools.WriteTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir},
		&tools.EditTool{CWD: r.sessionCWD, Sandbox: sb, Changes: r.tfc.tracker, BrainDir: brainDir},
		&tools.BashTool{CWD: r.sessionCWD, Sandbox: sb, Slow: r.d.slowHook(r.sessionID)},
		&tools.GlobTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.SearchTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.InspectTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.SearchWebTool{CWD: r.sessionCWD, Sandbox: sb},
		&tools.FetchURLTool{CWD: r.sessionCWD, Sandbox: sb},
	}
	// The python tool is only advertised when a Python 3 interpreter exists
	// on this machine (PythonAvailable probes PATH once and caches).
	if _, err := tools.PythonAvailable(); err == nil {
		baseTools = append(baseTools, &tools.PythonTool{CWD: r.sessionCWD, Sandbox: sb, Slow: r.d.slowHook(r.sessionID)})
	}
	// bg_cancel lets the model force-stop one of its own background tasks
	// (same plan/build/learning gating as sleep). Terminal tasks are
	// followed via their .log file in the brain scratch space — there is
	// deliberately no polling tool.
	bgCancelTool := &tools.BgCancelTool{Host: r.d, SessionID: r.sessionID}
	// sleep parks the model for a bounded wait and wakes early when any
	// of the session's background tasks finishes (the "wait for the bg
	// task" primitive instead of polling).
	sleepTool := &tools.SleepTool{Host: r.d, SessionID: r.sessionID}

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
	markTaskTool := &tools.MarkTaskAsCompleteTool{}
	markPlanTool := &tools.MarkPlanAsReadyToExecuteTool{}
	r.reg = core.NewRegistry(append(append(append(baseTools, questionTool), todoTool, markTaskTool, markPlanTool), bgCancelTool, sleepTool)...)

	initTools := core.Registry{}
	for name, tool := range r.reg {
		initTools[name] = tool
	}
	restrictModeTools(initTools, r.options.Mode)

	r.agent = core.NewAgent(r.client, r.modelToUse, systemPromptWithBrain(r.cfg, r.sessionCWD, r.options, brainDir), initTools)
	r.agent.TurnIndex = r.turnIndex
	r.agent.PersistentTurns = true
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
			liveConfig := *r.d.config
			system := systemPromptWithBrain(liveConfig, r.sessionCWD, nextOptions, brainDir)
			r.d.configMu.RUnlock()
			available := core.Registry{}
			for name, tool := range r.reg {
				available[name] = tool
			}
			r.syncMCP(requestCtx, liveConfig, nextOptions, available)
			r.agent.SetSystem(system + r.mcpAvailability())
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

	// Quiet-context hook: background completion notices injected into the
	// live turn (AppendUserContextQuiet — the caller holds act.mu, so the
	// loud hook above would self-deadlock). Persist the record and push
	// the updated transcript so every client sees the notice immediately
	// (the frontend filters it from rendering) and it survives reloads.
	r.agent.OnContextAppended = func(m provider.Message) {
		r.act.mu.Lock()
		if r.act.gen != r.myGen {
			r.act.mu.Unlock()
			return
		}
		if m.TurnIndex == 0 {
			m.TurnIndex = r.turnIndex
		}
		r.act.record.Messages = append(r.act.record.Messages, m)
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		_ = r.d.saveSession(r.act.record)
		r.act.mu.Unlock()
		_ = r.d.sendWS(map[string]any{
			"type":       "session_content",
			"hostId":     r.cfg.HostID,
			"sessionId":  r.sessionID,
			"messages":   sanitizeMessagesForFrontend(r.act.record.Messages, r.act.record.Attachments),
			"compaction": r.act.record.Compaction,
		})
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
			"messages":   sanitizeMessagesForFrontend(rec.Messages, rec.Attachments),
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
	case core.EvUserMessage:
		payload["event"] = map[string]any{"type": "user_message", "message": sanitizeMessagesForFrontend([]provider.Message{e.Message})[0], "index": len(r.act.record.Messages) - 1}
	case core.EvAssistantMessage:
		payload["event"] = map[string]any{"type": "assistant_message", "message": e.Message, "index": len(r.act.record.Messages) - 1}
	case core.EvAssistantStart:
		payload["event"] = map[string]any{"type": "assistant_start", "index": len(r.act.record.Messages)}
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
		// Publish after each result; path-keyed clients retain open diff state.
		if r.tfc != nil && r.tfc.tracker.Count() > 0 {
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
			"type": "retry", "attempt": e.Attempt, "index": len(r.act.record.Messages),
			"delayMs": int64(e.Delay / time.Millisecond), "error": errText,
		}
	case core.EvDone:
		return // Task completion is emitted only after compaction and persistence.
	default:
		return
	}

	if event, ok := payload["event"].(map[string]any); ok {
		event["turnIndex"] = r.turnIndex
	}
	_ = r.d.sendWS(payload)
}

// finishTurn runs when the turn truly ends (AI finished, user cancelled):
// final balloon, journal removal (incoming and final never coexist on
// disk), idle flip, persistence and completion broadcast. Provider
// errors never reach a third ending — they retry inside the loop until
// success or cancellation.
func (r *turnRun) finishTurn() {
	r.closeMCP()
	r.act.mu.Lock()
	// NOTE: no defer Unlock here — the tail below unlocks manually so queue
	// promotion (which re-acquires the session lock) can run synchronously
	// before returning. Every return path must unlock explicitly.
	// Shutdown/purge/new generations own the journal now. A stale finalizer
	// must not touch files, history, or the replacement turn's recovery data.
	if r.act.gen != r.myGen {
		r.act.mu.Unlock()
		return
	}
	var balloon *filetrack.TurnChanges
	alreadyCommitted := false
	for _, b := range r.act.record.FileBalloons {
		if r.tfc != nil && b.TurnIndex == r.tfc.turnIndex {
			alreadyCommitted = true
		}
	}
	if !alreadyCommitted {
		balloon = r.d.finishTurnTrackingLocked(r.act, r.tfc)
	}
	r.act.fileChanges = nil
	r.act.record.Status = "idle"
	cancelled := r.ctx.Err() != nil
	finishTurnActivity(r.act, cancelled)
	r.act.pendingApproval = nil
	r.act.question = nil
	r.act.convert = nil
	sendNow := r.act.sendNow
	r.act.sendNow = false
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
	if err := r.d.saveSession(r.act.record); err != nil {
		r.act.mu.Unlock()
		return // Keep the journal until completion is durably committed.
	}
	r.d.deleteTurnJournal(r.sessionID)
	if balloon != nil {
		r.d.broadcastFileBalloon(r.cfg.HostID, r.sessionID, balloon)
	}
	r.act.cancel = nil
	// Publish completion before a new turn can acquire this session.
	_ = r.d.sendWS(map[string]any{"type": "session_data", "hostId": r.cfg.HostID, "session": sessionPayload(r.act.record)})
	_ = r.d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    r.cfg.HostID,
		"sessionId": r.sessionID,
		"status":    "idle",
	})
	sessionID := r.sessionID
	// Queue drain: a normally completed turn promotes the head; a
	// send-now promotes the head after a cancelled turn. A plain
	// cancelled turn never drains. Unlock first: promotion re-acquires.
	r.act.mu.Unlock()
	if !cancelled || sendNow {
		r.d.promoteQueueHead(sessionID)
	}
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
// from it. Called before tracked writes and after tool results.
func (r *turnRun) persistIncoming() {
	if r.tfc == nil || r.tfc.tracker.Count() == 0 {
		return
	}
	j, _ := r.d.readTurnJournal(r.sessionID)
	if j == nil {
		j = &TurnJournal{TurnIndex: r.turnIndex, StartedAt: r.turnStarted.StartedAt, Model: r.modelToUse}
	}
	j.Incoming = r.tfc.tracker.Snapshot()
	r.d.writeTurnJournal(r.sessionID, j)
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
	d.sessionsMu.RLock()
	act.mu.Lock()
	valid := d.sessions[act.record.ID] == act && act.cancel == nil && !turnResumeAbandoned(act.record, j)
	d.sessionsMu.RUnlock()
	if !valid {
		act.mu.Unlock()
		return
	}
	act.record.Status = "running"
	act.record.TurnSeq = max(act.record.TurnSeq, j.TurnIndex)
	act.question = nil
	act.convert = nil
	act.sendNow = false
	act.record.Turn = &TurnActivity{StartedAt: j.StartedAt, Status: "running"}
	if act.record.Turn.StartedAt <= 0 {
		act.record.Turn.StartedAt = now
	}
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
	sink := func(ev core.AgentEvent) { r.handleEvent(ev) }
	var err error
	freshPrompt := !turnHasMessages(r.agent.History(), j.TurnIndex)
	// After the Prompt-vs-Continue decision (never before — the injected
	// notice carries this turn index and would flip an empty history into
	// Continue, swallowing the opening prompt): tell the resumed turn
	// about background tasks the previous process dropped.
	r.injectRestartNotices()
	if freshPrompt {
		prompt, images := d.turnPrompt(act, j.Prompt, j.AttachmentIDs, options.Mode)
		err = r.agent.PromptWithMeta(r.ctx, prompt, images, d.promptMeta(act, j.Prompt, j.AttachmentIDs), sink)
	} else {
		err = r.agent.Continue(r.ctx, sink)
	}
	if err != nil && r.ctx.Err() == nil {
		fmt.Printf("[WARN] resumed turn %d of session %s exited with live context: %v\n", r.turnIndex, r.sessionID, err)
	}
}

// resumeInterruptedTurns replays every crash journal found at boot: the
// turn continues where it died (same index, restored tracker, transcript
// from disk). A turn is only ever finished by the AI or by user cancel,
// never by a dead process, a dropped network, or a dead gateway.
func (d *DaemonServer) resumeInterruptedTurns() {
	d.configMu.RLock()
	hostID := d.config.HostID
	d.configMu.RUnlock()
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
		stopped := abandon && rec.TurnSeq == j.TurnIndex && rec.Turn != nil &&
			(rec.Turn.Status == "cancelling" || rec.Turn.Status == "cancelled")
		cwd, gen := rec.CWD, act.gen
		act.mu.Unlock()
		switch {
		case abandon:
			if stopped {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				r := &turnRun{d: d, cfg: DaemonConfig{HostID: hostID}, act: act, sessionID: sid, myGen: gen, ctx: ctx,
					tfc: &turnFileChanges{tracker: filetrack.RestoreTurnTracker(j.Incoming), turnIndex: j.TurnIndex, cwd: cwd, brainDir: d.brainDir(sid)}}
				r.finishTurn()
				continue
			}
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
// was explicitly stopped, or has neither persisted messages nor a pending
// opening prompt (an old journal created before the first message append).
func turnResumeAbandoned(rec *SessionRecord, j *TurnJournal) bool {
	if rec.TurnSeq > j.TurnIndex {
		return true
	}
	if rec.TurnSeq == j.TurnIndex && rec.Turn != nil &&
		(rec.Turn.Status == "completed" || rec.Turn.Status == "cancelled" || rec.Turn.Status == "cancelling") {
		return true
	}
	for _, b := range rec.FileBalloons {
		if b.TurnIndex == j.TurnIndex {
			return true
		}
	}
	return !turnHasMessages(rec.Messages, j.TurnIndex) && j.Prompt == "" && len(j.AttachmentIDs) == 0
}

func turnHasMessages(messages []provider.Message, turnIndex int) bool {
	for _, m := range messages {
		if m.TurnIndex == turnIndex {
			return true
		}
	}
	return false
}
