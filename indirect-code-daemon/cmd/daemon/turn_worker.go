package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// turnWorker runs one agent turn on a daughter goroutine of the session
// actor. It NEVER touches actor state directly: every mutation is a message
// sent to act.inbox, processed in order by the actor loop. Reads of actor
// state happen through snapshots taken at worker start (model, options,
// messages) — mid-turn changes (configureSession) are picked up via
// BeforeRequest round-trips through the actor.
//
// Lifecycle: startTurnWorker returns immediately; completion (success,
// cancel, error) is reported as workerFinishedMsg. A stale worker (gen
// mismatch) is ignored by the actor.

// workerSnapshot is the actor state a turn needs, copied at start.
type workerSnapshot struct {
	gen         int
	jailed      bool
	promptMeta  map[string]string
	lastDate    string
	lastMode    string
	turnIndex   int
	model       string
	options     SessionOptions
	messages    []provider.Message
	usage       provider.Usage
	compaction  *core.CompactionState
	context     *SessionContext
	attachments []AttachmentRef
	cwd         string
	prompt      string
	attachIDs   []string
	incoming    []filetrack.TrackedFile
	// resume, when True, continues the fused transcript via agent.Continue
	// instead of opening a new user turn (crash/watchdog resume path).
	resume    bool
	resumeGen int
}

// workerEnv are the actor services the worker may call. All are
// goroutine-safe by construction (mailbox or atomic).
type workerEnv struct {
	cfg      *configCell
	store    *diskStore
	emit     func(any)
	inbox    chan Envelope // actor inbox (for state-change messages)
	actorID  string
	bg       *bgSupervisor
	hostID   func() string
	brainDir func(sessionID string) string
}

func startTurnWorker(act *sessionActor, ctx context.Context, gen int, prompt string, meta map[string]string) {
	snap := workerSnapshot{
		gen: gen, turnIndex: act.rec.TurnSeq, jailed: act.jailed,
		model: act.rec.Model, options: normalizedOptions(act.recordOptions()),
		messages:    append([]provider.Message(nil), act.rec.Messages...),
		usage:       act.rec.Usage,
		compaction:  act.rec.Compaction,
		context:     act.rec.Context,
		attachments: append([]AttachmentRef(nil), act.rec.Attachments...),
		cwd:         act.rec.CWD,
		prompt:      prompt,
		promptMeta:  meta,
	}
	env := workerEnv{
		cfg: act.cfgRef(), store: act.store, emit: act.emit, inbox: act.inbox,
		actorID: act.id, bg: act.bg,
		hostID:   func() string { return act.cfgRef().load().HostID },
		brainDir: func(sid string) string { return act.store.ensureBrainDir(sid) },
	}
	go runTurnWorker(ctx, env, snap)
}

// recordOptions reads options without locking: called on the actor
// goroutine only.
func (a *sessionActor) recordOptions() SessionOptions { return a.rec.Options }

// cfgRef exposes the supervisor config cell to the worker.
func (a *sessionActor) cfgRef() *configCell { return a.supCfg }

// runTurnWorker executes the agent loop. Terminal: exactly one
// workerFinishedMsg to env.inbox.
func runTurnWorker(ctx context.Context, env workerEnv, snap workerSnapshot) {
	finished := func(cancelled bool, errStr string) {
		// The actor drains continuously, but under a burst the inbox may be
		// momentarily full. Retry briefly: a dropped finish would leak a
		// session in running forever (disk shows only the user turn).
		for i := 0; i < 100; i++ {
			select {
			case env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: cancelled, err: errStr}}:
				return
			case <-ctx.Done():
				// Actor gone; nothing to report to.
				return
			default:
			}
			time.Sleep(50 * time.Millisecond)
		}
		fmt.Printf("[WARN] turn %d of session %s could not deliver finish (inbox full)\n", snap.turnIndex, env.actorID)
	}
	cfg := env.cfg.load()
	if cfg == nil {
		finished(false, "no config")
		return
	}
	w := &turnBridge{env: env, snap: snap, cfg: *cfg, ctx: ctx}
	if err := w.run(); err != nil {
		if ctx.Err() != nil {
			finished(true, "")
			return
		}
		finished(false, err.Error())
		return
	}
	finished(ctx.Err() != nil, "")
}

// turnBridge holds per-turn execution state: agent, hooks, tracker.
type turnBridge struct {
	env workerEnv
	snap workerSnapshot
	cfg DaemonConfig
	ctx context.Context

	sessionCWD string
	modelToUse string
	agent      *core.Agent
	client     provider.Client
	modelInfo  provider.Model
	reg        core.Registry
	tfc        *turnFileChanges
	live       *liveTracker
}

func (w *turnBridge) run() error {
	cfg := w.cfg
	w.sessionCWD = w.snap.cwd
	if w.sessionCWD != "" && inspectWorkspace(w.sessionCWD).Status != "available" {
		w.emit(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": pagedHistoryBlock(sessionPayload(w.recordView()), w.recordView())})
		return fmt.Errorf("workspace unavailable")
	}
	apiBase := strings.TrimRight(cfg.GatewayURL, "/") + "/anthropic/v1"
	w.modelInfo = gatewayModel(w.ctx, cfg.GatewayURL, cfg.DaemonToken, w.snap.model)
	if effort := canonicalReasoning(w.snap.options.Effort); effort != "" && effort != "none" {
		w.modelInfo.Reasoning = true
	}
	w.client = provider.NewGatewayAnthropic(cfg.APIKey, apiBase, w.modelInfo)
	w.modelToUse = w.modelInfo.ID

	sb := tools.NewSandbox(w.sessionCWD)
	brainDir := w.env.brainDir(w.env.actorID)
	if brainDir != "" {
		sb.AllowExtra(brainDir)
	}
	if cfg.Settings.JailByDefault || w.snap.jailed {
		sb.Lock()
	}
	w.tfc = beginTurnTracking(w.sessionCWD, w.snap.turnIndex, brainDir)
	if len(w.snap.incoming) > 0 {
		w.tfc.tracker = filetrack.RestoreTurnTracker(dropBrainTracked(w.snap.incoming, brainDir))
	}
	w.live = &liveTracker{turnSeq: w.snap.turnIndex}

	baseTools := []core.Tool{
		&tools.ReadTool{CWD: w.sessionCWD, Sandbox: sb, Changes: w.tfc.tracker, BrainDir: brainDir, Convert: w.requestConvert},
		&tools.WriteTool{CWD: w.sessionCWD, Sandbox: sb, Changes: w.tfc.tracker, BrainDir: brainDir},
		&tools.EditTool{CWD: w.sessionCWD, Sandbox: sb, Changes: w.tfc.tracker, BrainDir: brainDir},
		&tools.BashTool{CWD: w.sessionCWD, Sandbox: sb, Slow: w.slowHook()},
		&tools.GlobTool{CWD: w.sessionCWD, Sandbox: sb},
		&tools.SearchTool{CWD: w.sessionCWD, Sandbox: sb},
		&tools.InspectTool{CWD: w.sessionCWD, Sandbox: sb},
		&tools.SearchWebTool{CWD: w.sessionCWD, Sandbox: sb},
		&tools.FetchURLTool{CWD: w.sessionCWD, Sandbox: sb},
	}
	if _, err := tools.PythonAvailable(); err == nil {
		baseTools = append(baseTools, &tools.PythonTool{CWD: w.sessionCWD, Sandbox: sb, Slow: w.slowHook()})
	}
	bgCancelTool := &tools.BgCancelTool{Host: w, SessionID: w.env.actorID}
	sleepTool := &tools.SleepTool{Host: w, SessionID: w.env.actorID}
	questionTool := &tools.QuestionTool{Ask: w.askQuestions}
	todoTool := &tools.TodoTool{Update: w.updateTodos}
	markTaskTool := &tools.MarkTaskAsCompleteTool{}
	markPlanTool := &tools.MarkPlanAsReadyToExecuteTool{}
	w.reg = core.NewRegistry(append(append(append(baseTools, questionTool), todoTool, markTaskTool, markPlanTool), bgCancelTool, sleepTool)...)

	initTools := core.Registry{}
	for name, tool := range w.reg {
		initTools[name] = tool
	}
	restrictModeTools(initTools, w.snap.options.Mode)

	w.agent = core.NewAgent(w.client, w.modelToUse, systemPromptWithBrain(cfg, w.sessionCWD, w.snap.options, brainDir), initTools)
	w.agent.TurnIndex = w.snap.turnIndex
	w.agent.PersistentTurns = true
	w.agent.Reasoning = w.snap.options.Effort
	w.agent.BeforeRequest = w.beforeRequest
	w.agent.Temperature = &cfg.Settings.Temperature
	w.agent.MaxTokens = maxOutputTokens(w.modelInfo)
	if len(w.snap.messages) > 0 {
		w.agent.SetMessages(w.snap.messages)
	}
	w.agent.SeedCost(w.snap.usage)
	w.agent.SeedCompactionState(w.snap.compaction)
	w.agent.BeforeToolExecute = w.approveTool
	w.agent.OnMessageAppended = w.onMessageAppended
	w.agent.OnContextAppended = w.onContextAppended
	w.agent.OnCompactionState = w.onCompactionState
	w.agent.OnUsage = w.onUsage
	w.agent.AutoCompact = w.autoCompact
	if w.snap.context == nil {
		if est := estimateContext(w.agent, w.modelInfo); est != nil {
			w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeUsage, Context: est}})
		}
	}

	// v1 turnPrompt parity: date/mode system directives are prepended to the
	// opening prompt (and persisted via LastDate/LastMode, so they fire once
	// per change — not on every turn). Without this the model never learns
	// the date or its operational mode.
	sysBlock := buildTurnSystemDirectives(&w.snap, time.Now())
	w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeMeta, LastDate: w.snap.lastDate, LastMode: w.snap.lastMode}})
	sink := func(ev core.AgentEvent) { w.handleEvent(ev) }
	if w.snap.resume {
		// Resume: no new user message — the fused transcript (disk + WAL
		// replay) already holds everything; Continue picks up the pending
		// assistant/tool loop where it died. Same turn index (numbering
		// never advances for a turn that never ended).
		if err := w.agent.Continue(w.ctx, sink); err != nil && w.ctx.Err() == nil {
			fmt.Printf("[WARN] resumed turn %d of session %s exited with live context: %v\n", w.snap.turnIndex, w.env.actorID, err)
		}
	} else {
		fullPrompt, images := buildTurnPrompt(w.snap.attachments, w.snap.prompt, w.snap.attachIDs, w.snap.options.Mode)
		if sysBlock != "" {
			if fullPrompt == "" {
				fullPrompt = sysBlock
			} else {
				fullPrompt = sysBlock + "\n\n" + fullPrompt
			}
		}
		meta := attachmentMessageMeta(w.snap.prompt, w.snap.attachIDs, w.snap.attachments)
		if err := w.agent.PromptWithMeta(w.ctx, fullPrompt, images, meta, sink); err != nil && w.ctx.Err() == nil {
			fmt.Printf("[WARN] turn %d of session %s exited with live context: %v\n", w.snap.turnIndex, w.env.actorID, err)
		}
	}
	// Final balloon computed here; the actor appends it at finish.
	if b := finishTurnTracking(w.tfc, -1); b != nil {
		w.sendInbox(turnBalloonMsg{balloon: *b})
	}
	// Auto-title in background (fire-and-forget goroutine, gen-guarded).
	if !cfg.Settings.NoAutoTitle && w.ctx.Err() == nil {
		go w.maybeAutoTitle()
	}
	return nil
}

func (w *turnBridge) emit(ev any) {
	if w.env.emit != nil {
		w.env.emit(ev)
	}
}

// sendInbox delivers a state-change message to the actor (non-blocking;
// worker drops only transcript deltas under extreme pressure — state
// messages use the control lane fallback inside the actor's timer path;
// here we block briefly since the worker has nothing better to do).
func (w *turnBridge) sendInbox(payload any) {
	// Transcript integrity beats loop pacing: walAppendMsg carries the
	// authoritative transcript (WAL + in-memory record), so it must NEVER
	// be dropped — block until delivered or the turn is cancelled. Control
	// traffic (bgJobFinishedMsg) stays non-blocking via the select below.
	if _, ok := payload.(walAppendMsg); ok {
		select {
		case w.env.inbox <- Envelope{Payload: payload}:
		case <-w.ctx.Done():
		}
		return
	}
	select {
	case w.env.inbox <- Envelope{Payload: payload}:
	case <-w.ctx.Done():
	default:
		fmt.Printf("[WARN] turn %d of session %s dropped inbox message %T (inbox full)\n", w.snap.turnIndex, w.env.actorID, payload)
	}
}

// heartbeat sends a non-blocking liveness ping for the current gen.
func (w *turnBridge) heartbeat() {
	select {
	case w.env.inbox <- Envelope{Payload: workerHeartbeatMsg{gen: w.snap.gen}}:
	default:
	}
}

// recordView builds a minimal record for payload helpers (workspace-gated
// error path only).
func (w *turnBridge) recordView() *SessionRecord {
	return &SessionRecord{ID: w.env.actorID, CWD: w.snap.cwd, Title: "", Model: w.modelToUse, Status: "running", Messages: w.snap.messages, Attachments: w.snap.attachments, Options: w.snap.options, Usage: w.snap.usage, Context: w.snap.context}
}

// ---- agent hooks (all run on the worker goroutine) ----

func (w *turnBridge) beforeRequest(requestCtx context.Context) error {
	// Refresh model/options/system/tools from the actor (round-trip with
	// timeout). Stale gen or cancelled ctx aborts the request.
	type refresh struct {
		model   string
		options SessionOptions
	}
	reply := make(chan any, 1)
	select {
	case w.env.inbox <- Envelope{Payload: workerRefreshMsg{gen: w.snap.gen, Reply: reply}}:
	case <-requestCtx.Done():
		return requestCtx.Err()
	case <-w.ctx.Done():
		return context.Canceled
	}
	var rf refresh
	select {
	case r := <-reply:
		rr, ok := r.(workerRefreshResult)
		if !ok || rr.stale {
			return context.Canceled
		}
		rf.model, rf.options = rr.model, rr.options
	case <-requestCtx.Done():
		return requestCtx.Err()
	case <-w.ctx.Done():
		return context.Canceled
	}
	if rf.model != "" && rf.model != w.modelInfo.ID {
		w.modelInfo = gatewayModel(requestCtx, w.cfg.GatewayURL, w.cfg.DaemonToken, rf.model)
	}
	requestModel := w.modelInfo
	if rf.options.Effort != "none" {
		requestModel.Reasoning = true
	}
	apiBase := strings.TrimRight(w.cfg.GatewayURL, "/") + "/anthropic/v1"
	w.client = provider.NewGatewayAnthropic(w.cfg.APIKey, apiBase, requestModel)
	w.modelToUse = w.modelInfo.ID
	w.agent.Client, w.agent.Model, w.agent.Reasoning = w.client, w.modelToUse, rf.options.Effort
	w.agent.MaxTokens = maxOutputTokens(w.modelInfo)
	liveCfg := w.env.cfg.load()
	var cfg DaemonConfig
	if liveCfg != nil {
		cfg = *liveCfg
	} else {
		cfg = w.cfg
	}
	brainDir := w.env.brainDir(w.env.actorID)
	system := systemPromptWithBrain(cfg, w.sessionCWD, rf.options, brainDir)
	available := core.Registry{}
	for name, tool := range w.reg {
		available[name] = tool
	}
	w.agent.SetSystem(system)
	restrictModeTools(available, rf.options.Mode)
	w.agent.SetTools(available)
	return nil
}

// approveTool blocks the worker until the human answers (or timeout/cancel).
// The actor moves to awaitingApproval and arms the 15-min timer; the reply
// arrives as approvalResponseMsg → the actor wakes this hook via the
// per-call channel.
func (w *turnBridge) approveTool(call provider.ToolCallBlock) (bool, string, json.RawMessage) {
	if w.ctx.Err() != nil {
		return false, "Turn cancelled", nil
	}
	if reason := modeToolRestriction(w.snap.options.Mode, call.Name); reason != "" {
		return false, reason, nil
	}
	if w.snap.options.Access == "full" || call.Name == "question" || call.Name == "todo" || call.Name == "mark_task_as_complete" || call.Name == "mark_plan_as_ready_to_execute" {
		return true, "", nil
	}
	ch := make(chan approvalOutcome, 1)
	id := randomID8()
	select {
	case w.env.inbox <- Envelope{Payload: workerApprovalReqMsg{gen: w.snap.gen, id: id, tool: call.Name, args: call.Arguments, callID: call.ID, reply: ch}}:
	case <-w.ctx.Done():
		return false, "Turn cancelled", nil
	}
	select {
	case out := <-ch:
		if out.stale || w.ctx.Err() != nil {
			return false, "Turn cancelled", nil
		}
		if !out.approved {
			return false, "User rejected tool execution", nil
		}
		return true, "", nil
	case <-w.ctx.Done():
		return false, "Turn cancelled", nil
	}
}

type approvalOutcome struct {
	approved bool
	stale    bool
}

func (w *turnBridge) askQuestions(ctx context.Context, req tools.QuestionRequest) ([][]string, error) {
	ch := make(chan questionOutcome, 1)
	id := randomID8()
	select {
	case w.env.inbox <- Envelope{Payload: workerQuestionReqMsg{gen: w.snap.gen, id: id, req: req, reply: ch}}:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.ctx.Done():
		return nil, w.ctx.Err()
	}
	select {
	case out := <-ch:
		if out.stale || w.ctx.Err() != nil {
			return nil, context.Canceled
		}
		return out.answers, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.ctx.Done():
		return nil, w.ctx.Err()
	}
}

type questionOutcome struct {
	answers [][]string
	stale   bool
}

func (w *turnBridge) requestConvert(ctx context.Context, filename string, b64data string) (string, error) {
	// Browser-assisted conversion (v1 convert.go semantics): emit
	// convert_request, wait for convert_response (60s), stale gen aborts.
	// No browser (or timeout) falls back to the binary error — never hangs.
	id := fmt.Sprintf("%x", randomConvertID())
	reply := make(chan any, 1)
	select {
	case w.env.inbox <- Envelope{Payload: workerConvertReqMsg{gen: w.snap.gen, id: id, filename: filename, data: b64data, reply: reply}}:
	case <-ctx.Done():
		return "", ctx.Err()
	case <-w.ctx.Done():
		return "", w.ctx.Err()
	}
	select {
	case r := <-reply:
		out, _ := r.(convertOutcome)
		if out.stale || w.ctx.Err() != nil {
			return "", context.Canceled
		}
		if out.err != "" {
			return "", fmt.Errorf("%s", out.err)
		}
		return out.text, nil
	case <-time.After(convertTimeout):
		return "", fmt.Errorf("no browser available for conversion")
	case <-ctx.Done():
		return "", ctx.Err()
	case <-w.ctx.Done():
		return "", w.ctx.Err()
	}
}

func (w *turnBridge) updateTodos(items []tools.TodoItem) error {
	if w.ctx.Err() != nil {
		return context.Canceled
	}
	cp := append([]tools.TodoItem{}, items...)
	w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeTodos, Todos: cp}})
	w.emit(map[string]any{"type": "agent_event", "hostId": w.cfg.HostID, "sessionId": w.env.actorID, "event": map[string]any{"type": "todo_update", "items": items}})
	return nil
}

// SleepHost: wake early when any session job finishes (push from bg supervisor).
func (w *turnBridge) WaitForAnyJob(sessionID string, done <-chan struct{}) <-chan struct{} {
	if w.env.bg == nil {
		return nil
	}
	return w.env.bg.subscribeFinish(sessionID, done)
}

func (w *turnBridge) RecentBgFinish(sessionID string) (string, time.Duration, bool) {
	if w.env.bg == nil {
		return "", 0, false
	}
	return w.env.bg.recentFinish(sessionID)
}

// BgCancelHost.
func (w *turnBridge) CancelBackgroundJob(callerSessionID, jobID string) (tools.BgCancelOutcome, error) {
	if w.env.bg == nil {
		return tools.BgCancelOutcome{}, fmt.Errorf("no background support")
	}
	return w.env.bg.cancelJob(callerSessionID, jobID)
}

// slowHook registers a bg job on the supervisor and returns the
// (id, logPath, stream, finish) tuple. Stream appends to the .log and
// emits live bg_output; finish reports the terminal state exactly once.
func (w *turnBridge) slowHook() tools.SlowHook {
	return func(kind, label string, stop func()) (string, string, func(string), func(string, bool)) {
		if w.env.bg == nil {
			// No supervisor (tests): local stub that still detaches.
			id := "bg_" + randomID8()
			finish := func(result string, isError bool) {
				_ = result
				_ = isError
				w.sendInbox(bgJobFinishedMsg{JobID: id})
			}
			return id, "", func(string) {}, finish
		}
		logPath := ""
		if dir := w.env.brainDir(w.env.actorID); dir != "" {
			_ = os.MkdirAll(dir, 0o700)
			// temp name; real id comes from register
			logPath = dir + "/bg_pending.log"
		}
		reply := make(chan any, 1)
		pid := 0
		if v := ctxPID(w.ctx); v > 0 {
			pid = v
		}
		select {
		case w.env.bg.inbox <- Envelope{Payload: bgRegisterMsg{Kind: kind, SessionID: w.env.actorID, Label: label, LogPath: logPath, PID: pid, Stop: stop, Reply: reply}}:
		case <-w.ctx.Done():
			return "bg_cancelled", "", func(string) {}, func(string, bool) {}
		}
		var reg bgRegisterResult
		select {
		case r := <-reply:
			reg, _ = r.(bgRegisterResult)
		case <-w.ctx.Done():
			return "bg_cancelled", "", func(string) {}, func(string, bool) {}
		case <-time.After(replyTimeout):
			return "bg_cancelled", "", func(string) {}, func(string, bool) {}
		}
		id := reg.JobID
		if logPath != "" {
			final := strings.Replace(logPath, "bg_pending.log", id+".log", 1)
			_ = os.Rename(logPath, final)
			logPath = final
			// fix the registered path via finish-time pidfile rewrite is
			// unnecessary: pidfile stores logPath at register; update it.
			select {
			case w.env.bg.inbox <- Envelope{Payload: bgLogPathMsg{JobID: id, LogPath: logPath}}:
			case <-w.ctx.Done():
			case <-time.After(replyTimeout):
			}
		}
		stream := func(chunk string) {
			if chunk == "" {
				return
			}
			bgAppendLogLine(logPath, chunk)
			w.emit(map[string]any{"type": "bg_output", "sessionId": w.env.actorID, "jobId": id, "text": chunk})
		}
		var once sync.Once
		finish := func(result string, isError bool) {
			once.Do(func() {
				status := BgStatusDone
				if isError {
					status = BgStatusError
				}
				select {
				case w.env.bg.inbox <- Envelope{Payload: bgFinishMsg{JobID: id, Status: status, Result: result}}:
				case <-w.ctx.Done():
				case <-time.After(replyTimeout):
				}
				w.sendInbox(bgJobFinishedMsg{JobID: id})
			})
		}
		return id, logPath, stream, finish
	}
}

// ctxPID extracts a process pid stashed in the context by callers that
// manage real OS processes (bash/python tools pass it when known).
func ctxPID(ctx context.Context) int {
	if v := ctx.Value(ctxPidKey{}); v != nil {
		if n, ok := v.(int); ok {
			return n
		}
	}
	return 0
}

type ctxPidKey struct{}

// ---- message persistence hooks ----

func (w *turnBridge) onMessageAppended(m provider.Message) {
	if m.TurnIndex == 0 {
		m.TurnIndex = w.snap.turnIndex
	}
	w.sendInbox(walAppendMsg{ev: walMsgEvent(m), liveReset: m.Role == provider.RoleAssistant})
}

func (w *turnBridge) onContextAppended(m provider.Message) {
	if m.TurnIndex == 0 {
		m.TurnIndex = w.snap.turnIndex
	}
	w.sendInbox(walAppendMsg{ev: walMsgEvent(m), contextNotice: m})
}

func (w *turnBridge) onCompactionState(state *core.CompactionState) {
	if state == nil {
		return
	}
	cp := *state
	usage := w.agent.Cost()
	var ctxCopy *SessionContext
	func() {
		defer func() { _ = recover() }()
		if w.agent != nil {
			ctxCopy = estimateContext(w.agent, w.modelInfo)
		}
	}()
	w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeCompaction, Compaction: &cp, Usage: &usage, Context: ctxCopy}})
	w.emit(tailContentEvent(w.cfg.HostID, w.env.actorID, "session_compacted", w.compactionView(&cp, usage, ctxCopy), 0, map[string]any{
		"context": ctxCopy, "usage": usage, "auto": true,
	}))
}

func (w *turnBridge) compactionView(state *core.CompactionState, usage provider.Usage, ctxCopy *SessionContext) *SessionRecord {
	return &SessionRecord{ID: w.env.actorID, Model: w.modelToUse, Status: "running", Messages: w.agent.History(), Compaction: state, Usage: usage, Context: ctxCopy, Attachments: w.snap.attachments}
}

func (w *turnBridge) onUsage(cumulative provider.Usage) {
	cp := cumulative
	// estimateContext runs btdby4 over the full transcript+tools (SLOW on
	// big sessions — it runs on the worker, never the actor). Recover the
	// turn if counting panics: usage is telemetry, never worth a crash.
	var ctxCopy *SessionContext
	func() {
		defer func() { _ = recover() }()
		if w.agent != nil {
			ctxCopy = estimateContext(w.agent, w.modelInfo)
		}
	}()
	w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeUsage, Usage: &cp, Context: ctxCopy}})
}

func (w *turnBridge) autoCompact(cctx context.Context, esink func(core.AgentEvent)) error {
	if cctx.Err() != nil {
		return nil
	}
	window := w.modelInfo.ContextWindow
	if window <= 0 {
		return nil
	}
	msgs := w.agent.Messages()
	system, tls := w.agent.ContextTools()
	used := provider.ContextTokens(system, tls, msgs)
	needs := core.ShouldCompact(window, used)
	if !needs {
		if threshold := w.cfg.Settings.AutoCompactThreshold; threshold > 0 {
			needs = used*100 >= threshold*window
		}
	}
	if !needs {
		if usable := window - maxOutputTokens(w.modelInfo) - 20000; usable > 0 {
			needs = used >= usable
		}
	}
	if !needs {
		return nil
	}
	esink(core.EvToolProgress{Text: "Compacting older context…"})
	_, err := w.agent.MaybeAutoCompact(cctx, window, func(delta string) {
		esink(core.EvToolProgress{Text: delta})
	})
	return err
}

// ---- event streaming ----

func (w *turnBridge) handleEvent(ev core.AgentEvent) {
	w.live.track(ev)
	// Heartbeat: every stream/tool event proves the worker is alive, so a
	// long healthy stream never looks stale to the watchdog. Non-blocking:
	// a full inbox means the actor is back-pressured, not dead.
	w.heartbeat()
	payload := map[string]any{"type": "agent_event", "hostId": w.cfg.HostID, "sessionId": w.env.actorID}
	switch e := ev.(type) {
	case core.EvTurnStart:
		payload["event"] = map[string]any{"type": "turn_start", "step": e.Step}
	case core.EvUserMessage:
		payload["event"] = map[string]any{"type": "user_message", "message": sanitizeMessagesForFrontend([]provider.Message{e.Message})[0]}
	case core.EvAssistantMessage:
		payload["event"] = map[string]any{"type": "assistant_message", "message": e.Message}
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
		payload["event"] = map[string]any{"type": "tool_call", "id": e.ID, "name": e.Name, "args": e.Args}
	case core.EvToolResult:
		var sb strings.Builder
		for _, c := range e.Result.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				sb.WriteString(tb.Text)
			}
		}
		contentStr := strings.ReplaceAll(sb.String(), tools.LinePrefixNotice, "")
		event := map[string]any{"type": "tool_result", "id": e.ID, "content": contentStr, "isError": e.Result.IsError, "startedAt": e.Result.StartedAt, "durationMs": e.Result.DurationMs}
		if w.tfc != nil && w.tfc.tracker.Count() > 0 {
			broadcastLiveChanges(w.emit, w.cfg.HostID, w.env.actorID, w.tfc)
			w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeIncoming, Incoming: w.tfc.tracker.Snapshot()}})
		}
		if e.Details != nil {
			if raw, err := json.Marshal(e.Details); err == nil {
				event["details"] = json.RawMessage(raw)
			}
		}
		payload["event"] = event
	case core.EvToolExecutionStart:
		payload["event"] = map[string]any{"type": "tool_execution_start", "id": e.ID, "startedAt": e.StartedAt}
	case core.EvUsage:
		// Same recover-guard as onUsage: counting must never kill a turn.
		var ctxUsage *SessionContext
		func() {
			defer func() { _ = recover() }()
			if counted := estimateContext(w.agent, w.modelInfo); counted != nil {
				ctxUsage = counted
			}
		}()
		usageCopy := e.Cumulative
		w.sendInbox(walAppendMsg{ev: walEvent{Type: walTypeUsage, Usage: &usageCopy, Context: ctxUsage}})
		payload["event"] = map[string]any{"type": "usage", "usage": e.Usage, "cumulative": e.Cumulative, "context": ctxUsage}
	case core.EvTurnEnd:
		evMap := map[string]any{"type": "turn_end", "stop": string(e.Stop)}
		if w.ctx.Err() != nil {
			evMap["cancelled"] = true
		} else if e.Err != nil {
			evMap["error"] = e.Err.Error()
		}
		evMap["usage"] = w.agent.LastTurnUsage()
		evMap["cumulative"] = w.agent.Cost()
		payload["event"] = evMap
	case core.EvRetry:
		errText := ""
		if e.Err != nil {
			errText = e.Err.Error()
		}
		payload["event"] = map[string]any{"type": "retry", "attempt": e.Attempt, "delayMs": int64(e.Delay / time.Millisecond), "error": errText}
	case core.EvDone:
		return
	default:
		return
	}
	if event, ok := payload["event"].(map[string]any); ok {
		event["turnIndex"] = w.snap.turnIndex
	}
	w.emit(payload)
}

func (w *turnBridge) maybeAutoTitle() {
	// Gen-guarded auto-title: reads the first user text via a refresh
	// round-trip, asks the model, and sends the rename as a message.
	reply := make(chan any, 1)
	select {
	case w.env.inbox <- Envelope{Payload: workerTitleReqMsg{gen: w.snap.gen, Reply: reply}}:
	case <-w.ctx.Done():
		return
	}
	select {
	case r := <-reply:
		tr, ok := r.(workerTitleResult)
		if !ok || tr.stale || tr.firstText == "" {
			return
		}
		title := autoTitleFor(tr.firstText, w.client, w.modelToUse)
		if title == "" {
			return
		}
		w.sendInbox(workerTitleMsg{gen: w.snap.gen, title: title, original: tr.original})
	case <-w.ctx.Done():
	case <-time.After(60 * time.Second):
	}
}

// buildTurnPrompt resolves attachments into images + context text.
func buildTurnPrompt(attachments []AttachmentRef, promptText string, attachmentIDs []string, mode string) (string, []provider.ImageBlock) {
	_ = mode
	var images []provider.ImageBlock
	var contextParts []string
	if len(attachmentIDs) > 0 {
		byID := map[string]AttachmentRef{}
		for _, a := range attachments {
			byID[a.ID] = a
		}
		const maxInlineChars = 48 * 1024
		for _, id := range attachmentIDs {
			ref, ok := byID[id]
			if !ok {
				continue
			}
			data, err := os.ReadFile(ref.Path)
			if err != nil {
				contextParts = append(contextParts, fmt.Sprintf("[Attachment %q could not be read: %s]", ref.Name, err.Error()))
				continue
			}
			if strings.HasPrefix(strings.ToLower(ref.Mime), "image/") {
				images = append(images, provider.ImageBlock{MimeType: ref.Mime, Data: data})
				contextParts = append(contextParts, fmt.Sprintf("[Attached image: %s]", ref.Name))
				continue
			}
			text := ""
			if ref.TextPath != "" {
				if tdata, err := os.ReadFile(ref.TextPath); err == nil {
					text = string(tdata)
				}
			}
			if text == "" && isTextMime(ref.Mime, ref.Name) {
				text = string(data)
			}
			if text != "" {
				runes := []rune(text)
				note := ""
				if len(runes) > maxInlineChars {
					text = string(runes[:maxInlineChars])
					note = fmt.Sprintf(" (truncated to %d chars)", maxInlineChars)
				}
				contextParts = append(contextParts, fmt.Sprintf("[Attached file: %s%s]\n%s", ref.Name, note, text))
				continue
			}
			contextParts = append(contextParts, fmt.Sprintf("[Attached binary file: %s (%d bytes, stored at %s) — use tools to inspect it]", ref.Name, len(data), ref.Path))
		}
	}
	full := promptText
	if len(contextParts) > 0 {
		full += "\n\n" + strings.Join(contextParts, "\n\n")
	}
	_ = filetrack.TurnChanges{}
	return full, images
}

// runResumeWorker runs a crash-resume turn: same snapshot the supervisor
// built from disk + WAL replay, agent.Continue picks up the pending loop.
func runResumeWorker(act *sessionActor, ctx context.Context, snap *workerSnapshot) {
	env := workerEnv{
		cfg: act.cfgRef(), store: act.store, emit: act.emit, inbox: act.inbox,
		actorID: act.id, bg: act.bg,
		hostID:   func() string { return act.cfgRef().load().HostID },
		brainDir: func(sid string) string { return act.store.ensureBrainDir(sid) },
	}
	runTurnWorker(ctx, env, *snap)
}
