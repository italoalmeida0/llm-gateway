package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

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
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		// WAL mode: memory + append, zero JSON rewrites mid-turn.
		r.d.appendWALEvent(r.act, walEvent{Type: walTypeTodos, Todos: append([]tools.TodoItem{}, items...)})
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
				r.act.record.UpdatedAt = time.Now().UnixMilli()
				r.d.appendWALEvent(r.act, walEvent{Type: walTypeModel, Model: r.modelInfo.ID})
				_ = r.d.sendWS(map[string]any{"type": "session_data", "hostId": r.cfg.HostID, "session": pagedHistoryBlock(liveSessionPayload(r.act), r.act.record)})
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
	// in memory + WAL append (the frozen JSON is untouched until the
	// turn commits). Recovery replays the WAL, so no message is lost.
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
		r.d.appendWALEvent(r.act, walMsgEvent(m))
		r.act.mu.Unlock()
	}

	// Quiet-context hook: background completion notices injected into the
	// live turn (AppendUserContextQuiet — the caller holds act.mu, so the
	// loud hook above would self-deadlock). Persist the record and push
	// just the new message so every client sees the notice immediately
	// (the frontend filters it from rendering) and it survives reloads.
	// Full-transcript push here used to resend the whole session on every
	// background notice — same unbounded-payload problem as the old
	// end-of-turn snapshot (5s write deadline on slow uplinks).
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
		r.d.appendWALEvent(r.act, walMsgEvent(m))
		msgCopy := m
		comp := r.act.record.Compaction
		r.act.mu.Unlock()
		// Single-message event with the same cursor shape: the client
		// appends by id instead of replacing the list. The cursor
		// covers the notice's turn so get_history stays consistent.
		block := sliceLastTurns(r.act.record.Messages, r.act.record.FileBalloons, 1)
		_ = r.d.sendWS(map[string]any{
			"type":       "session_content",
			"hostId":     r.cfg.HostID,
			"sessionId":  r.sessionID,
			"messages":   sanitizeMessagesForFrontend([]provider.Message{msgCopy}, r.act.record.Attachments),
			"compaction": comp,
			"history":    historyCursorMap(block),
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
		usageCopy := rec.Usage
		ctxCopy := rec.Context
		stateCopy := *state
		r.d.appendWALEvent(r.act, walEvent{Type: walTypeCompaction, Compaction: &stateCopy, Usage: &usageCopy, Context: ctxCopy})
		r.act.mu.Unlock()
		// Tail turns + cursor (same merge path as the end-of-turn
		// snapshot): compaction rewrites how older messages render, so
		// the client needs the fresh tail, never the full transcript.
		_ = r.d.sendWS(tailContentEvent(r.cfg.HostID, rec.ID, "session_compacted", &rec, 0, map[string]any{
			"context": rec.Context,
			"usage":   rec.Usage,
			"auto":    true,
		}))
	}
	r.agent.OnUsage = func(cumulative provider.Usage) {
		r.act.mu.Lock()
		if r.act.gen == r.myGen {
			r.act.record.Usage = cumulative
			r.act.record.UpdatedAt = time.Now().UnixMilli()
			usageCopy := cumulative
			r.d.appendWALEvent(r.act, walEvent{Type: walTypeUsage, Usage: &usageCopy})
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
		msgs := r.agent.Messages() // projected context
		system, tools := r.agent.ContextTools()
		used := provider.ContextTokens(system, tools, msgs)
		needs := core.ShouldCompact(window, used)
		if !needs && threshold > 0 {
			needs = used*100 >= threshold*window
		}
		if !needs {
			// Usable formula stays as a final safety net:
			// contextWindow - outputBudget - 20,000 buffer.
			if usable := window - maxOutputTokens(r.modelInfo) - 20000; usable > 0 {
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
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		ctxCopy := r.act.record.Context
		r.d.appendWALEvent(r.act, walEvent{Type: walTypeUsage, Context: ctxCopy})
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
		// Provider usage is metrics only (cost display, session stats):
		// it accumulates into Usage/Cost and never drives context
		// occupancy. The context gauge is always the counted request
		// payload (btdby4), refreshed here so the UI tracks the latest
		// turn without waiting for the next one.
		r.act.record.Usage = e.Cumulative
		contextUsage := r.act.record.Context
		if r.agent != nil {
			if counted := estimateContext(r.agent, r.modelInfo); counted != nil {
				contextUsage = counted
				r.act.record.Context = counted
			}
		}
		r.act.record.UpdatedAt = time.Now().UnixMilli()
		usageCopy := e.Cumulative
		r.d.appendWALEvent(r.act, walEvent{Type: walTypeUsage, Usage: &usageCopy, Context: contextUsage})
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
// final balloon, then the SINGLE full JSON commit of the turn (WAL mode)
// and WAL removal. Provider errors never reach a third ending — they
// retry inside the loop until success or cancellation.
func (r *turnRun) finishTurn() {
	r.closeMCP()
	r.act.mu.Lock()
	// NOTE: no defer Unlock here — the tail below unlocks manually so queue
	// promotion (which re-acquires the session lock) can run synchronously
	// before returning. Every return path must unlock explicitly.
	// Shutdown/purge/new generations own the WAL now. A stale finalizer
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
	// Single commit: the frozen JSON is rewritten once with the complete
	// post-turn state, then the WAL is deleted. A crash before the
	// commit replays the WAL; a crash after it is detected by the
	// commit-window check and drops the stale log.
	// Transient disk failures (Windows AV locks, Linux IO pressure) must
	// not strand a finished turn as running-with-WAL: the in-memory
	// record is already final, so retry a few times before giving up.
	// commitWAL is idempotent (same turn number + message count skips
	// the turn line and only rewrites meta), so retries are safe.
	commitErr := r.d.commitWAL(r.act)
	for i := 0; i < 3 && commitErr != nil; i++ {
		time.Sleep(time.Duration(100*(i+1)) * time.Millisecond)
		commitErr = r.d.commitWAL(r.act)
	}
	if commitErr != nil {
		fmt.Printf("[WARN] turn %d of session %s: commit failed (%v), keeping WAL for retry/resume\n", r.turnIndex, r.sessionID, commitErr)
		r.act.mu.Unlock()
		return // Keep the WAL until completion is durably committed.
	}
	touchSession(r.act)
	r.d.notifyChange("sessions")
	if balloon != nil {
		r.d.broadcastFileBalloon(r.cfg.HostID, r.sessionID, balloon)
	}
	r.act.cancel = nil
	// Snapshot the completion payload UNDER the lock, but publish it
	// AFTER unlocking: sendWS takes the socket lock with a write
	// deadline, and a slow/dead relay must never stall the session
	// lock (or the queued promotion below) — that stall is what used
	// to surface as "failed to close the turn" + host offline.
	// Completion tail, never the full transcript: the foreground client
	// already received every turn message as deltas, so the snapshot
	// carries the full closing metadata (usage, compaction, context,
	// todos, model/options, queue, attachments) plus only the last two
	// whole turns + the get_history cursor. The client merges the fresh
	// turns by id; older turns are untouched and the payload stops
	// growing with session age.
	snapshot := completionPayload(r.act.record)
	sessionID := r.sessionID
	hostID := r.cfg.HostID
	// Queue drain: a normally completed turn promotes the head; a
	// send-now promotes the head after a cancelled turn. A plain
	// cancelled turn never drains. Unlock first: promotion re-acquires.
	r.act.mu.Unlock()
	_ = r.d.sendWS(map[string]any{"type": "session_data", "hostId": hostID, "session": snapshot})
	_ = r.d.sendWS(map[string]any{
		"type":      "session_status",
		"hostId":    hostID,
		"sessionId": sessionID,
		"status":    "idle",
	})
	if !cancelled || sendNow {
		r.d.promoteQueueHead(sessionID)
	}
}

// persistIncoming checkpoints the tracker's snapshot to the WAL so a
// restart can continue tracking (and rebuild the live changes view)
// from it. Called before tracked writes and after tool results.
// Append-only: one small line instead of a full JSON rewrite.
func (r *turnRun) persistIncoming() {
	if r.tfc == nil || r.tfc.tracker.Count() == 0 {
		return
	}
	r.d.appendWALEvent(r.act, walEvent{Type: walTypeIncoming, Incoming: r.tfc.tracker.Snapshot()})
}

// resumeAgentTurn continues a turn interrupted by a daemon death: same
// turn index (numbering never advances for a turn that never ended),
// tracker restored from the WAL header, transcript replayed from the
// fused record via Continue (no duplicated user message). The resumed
// turn checkpoints to a fresh header-only WAL and appends from there.
func (d *DaemonServer) resumeAgentTurn(act *ActiveSession, j *walHeader) {
	// Tests override turn execution: background wake-ups AND resumes call
	// the hook instead of hitting a provider, so tests never need one.
	// Narrowly scoped: only when the session is a valid resume candidate
	// (registered, no live worker, not abandoned) — otherwise fall
	// through to the real path (which fails fast on misconfiguration
	// instead of hanging the test).
	if d.runTurnHook != nil {
		d.sessionsMu.RLock()
		act.mu.Lock()
		valid := d.sessions[act.record.ID] == act && act.cancel == nil && !turnResumeAbandoned(act.record, j)
		d.sessionsMu.RUnlock()
		prompt := j.Prompt
		act.mu.Unlock()
		if valid {
			d.runTurnHook(act, prompt)
			return
		}
	}
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
	sessionID, sessionCWD := act.record.ID, act.record.CWD
	modelToUse := act.record.Model
	// Resume keeps the existing WAL file and appends to it: the fused
	// record lives in memory, the frozen JSONL on disk is untouched (no
	// partial turn line), and the commit appends the complete turn line
	// once. A second crash replays header + body exactly once.
	// Update the header's tracker snapshot to the latest body state so a
	// crash before the next incoming event still restores tracking.
	if act.wal != nil {
		d.discardWAL(act)
	}
	ww, werr := d.openWALAppend(sessionID)
	if os.IsNotExist(werr) {
		// No WAL file (header-only session): create fresh.
		ww, werr = d.openWAL(sessionID, &walHeader{TurnIndex: j.TurnIndex, StartedAt: act.record.Turn.StartedAt, Model: modelToUse, Prompt: j.Prompt, AttachmentIDs: j.AttachmentIDs, Incoming: j.Incoming})
	}
	if werr != nil {
		fmt.Printf("[WARN] cannot reopen WAL for %s: %v\n", sessionID, werr)
		act.mu.Unlock()
		return
	}
	act.wal = ww
	// Freeze the resumed running state (meta rewrite only); deltas append.
	meta := recordMeta(act.record)
	if err := d.rewriteMetaOnly(sessionID, meta); err != nil {
		// No JSONL yet (fresh session crashed before first commit):
		// full write of the fused record.
		if err := d.saveSessionSync(act.record); err != nil {
			d.discardWAL(act)
			_ = os.Remove(d.walPath(sessionID))
			act.wal = nil
			act.mu.Unlock()
			return
		}
	}
	touchSession(act)
	d.notifyChange("sessions")
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

// resumeInterruptedTurns replays every WAL found at boot: the turn
// continues where it died (same index, restored tracker, fused
// transcript via Continue). A turn is only ever finished by the AI or by
// user cancel, never by a dead process, a dropped network, or a dead
// gateway.
func (d *DaemonServer) resumeInterruptedTurns() {
	d.configMu.RLock()
	hostID := d.config.HostID
	d.configMu.RUnlock()
	for _, sid := range d.scanWALs() {
		header, herr := d.readWALHeader(sid)
		if herr != nil || header == nil || header.TurnIndex <= 0 {
			fmt.Printf("[INFO] Dropping corrupt WAL: %s (%v)\n", sid, herr)
			_ = os.Remove(d.walPath(sid))
			continue
		}
		// Fuse frozen JSON + WAL before deciding: the fused record is
		// what the turn will continue from.
		fused, _, ferr := d.loadSessionFused(sid)
		if ferr != nil {
			fmt.Printf("[INFO] Dropping unreadable WAL: %s (%v)\n", sid, ferr)
			_ = os.Remove(d.walPath(sid))
			continue
		}
		// The WAL body may carry a newer tracker snapshot than the
		// header: the last incoming event wins.
		j := header
		if data, rerr := os.ReadFile(d.walPath(sid)); rerr == nil {
			j = cloneWALHeader(header)
			j.Incoming = walLatestIncoming(data, header.Incoming)
		}
		// Commit-window detection: the JSON already carries the finished
		// turn (commit landed, WAL removal did not). Drop the stale log.
		if fused.TurnSeq > j.TurnIndex ||
			(fused.TurnSeq == j.TurnIndex && fused.Turn != nil &&
				(fused.Turn.Status == "completed" || fused.Turn.Status == "cancelled")) {
			fmt.Printf("[INFO] Dropping committed WAL: %s (turn %d)\n", sid, j.TurnIndex)
			_ = os.Remove(d.walPath(sid))
			continue
		}
		act, err := d.getOrCreateActiveSession(sid)
		if err != nil {
			// Session purged while the daemon was down: orphan WAL.
			_ = os.Remove(d.walPath(sid))
			continue
		}
		act.mu.Lock()
		// Swap in the fused record so the resumed turn sees the full
		// pre-crash transcript (frozen JSON + replayed WAL).
		act.record = fused
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
			fmt.Printf("[INFO] Dropping stale WAL: %s (turn %d)\n", sid, j.TurnIndex)
			_ = os.Remove(d.walPath(sid))
		case blocked:
			fmt.Printf("[INFO] Turn %d of %s waits for workspace; WAL kept\n", j.TurnIndex, sid)
		default:
			fmt.Printf("[INFO] Resuming interrupted turn %d of session %s\n", j.TurnIndex, sid)
			go d.resumeAgentTurn(act, j)
		}
	}
}

// walLatestIncoming folds walTypeIncoming snapshots in order; the last
// one wins. Falls back to the header seed when the body has none.
func walLatestIncoming(data []byte, fallback []filetrack.TrackedFile) []filetrack.TrackedFile {
	out := fallback
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		line = bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var ev walEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			continue
		}
		if ev.Type == walTypeIncoming && ev.Incoming != nil {
			out = ev.Incoming
		}
	}
	return out
}

// turnResumeAbandoned reports whether a WAL turn must NOT resume: it
// already produced its final balloon (crash landed in the finish window),
// was explicitly stopped, or has neither persisted messages nor a pending
// opening prompt (a header written before the first message append).
func turnResumeAbandoned(rec *SessionRecord, j *walHeader) bool {
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
