package main

import (
	"context"
	"crypto/rand"
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

var _ = core.StripLeadingSystemPrompt

// Turn timeout: 15 min per approval/question request (plan §8).
// Overridable via ICD_AWAIT_TIMEOUT (see tuning.go).
var awaitTimeout = tuneAwaitTimeout

// actorState names.
const (
	stateIdle      = "idle"
	stateRunning   = "running"
	stateAwaitAppr = "awaitingApproval"
	stateAwaitQ    = "awaitingQuestion"
	stateCancel    = "cancelling"
	stateOrphaned  = "orphaned"
)

// pendingAsk describes one outstanding human decision.
type pendingAsk struct {
	id       string
	kind     string // "approval" | "question"
	timer    *time.Timer
	deadline int64 // unix milli, persisted in rec.ApprovalDeadlineUnix
	// question resume data
	recommended [][]string
	notice      string
}

// sessionActor owns one SessionRecord. Single goroutine, no locks.
// The turn itself runs in worker (daughter goroutine); all state changes
// come back as mailbox messages.
type sessionActor struct {
	id      string
	store   *diskStore
	wsSend  func(any)
	bg      *bgSupervisor
	supCfg  *configCell // supervisor-owned config; worker reads via load()
	onEvent func(collection string) // change ping fan-out (notifyChange)

	inbox   chan Envelope
	control chan any
	done    chan struct{} // closed when run() returns

	rec   *SessionRecord
	wal   *walWriter
	state string
	gen   int

	cancel context.CancelFunc // worker ctx
	workerDone chan struct{}

	pending *pendingAsk

	// pendingBalloon holds the finished file-changes balloon until the
	// finalizer appends it with the true message count.
	pendingBalloon *filetrack.TurnChanges

	// approvalWaiters correlates workerApprovalReqMsg ids to worker channels.
	approvalWaiters map[string]chan approvalOutcome
	questionWaiters map[string]chan questionOutcome
	convertWaiters  map[string]chan any
	convertServer   func(msg map[string]any)

	// jailed locks the sandbox for future turns (v1 jail flag).
	jailed bool

	// sendNow promotes the queue head after a cancelled turn
	// (queue_send_now semantics: cancel + promote).
	sendNow bool
	// cancelRounds counts consecutive watchdog cancels without worker exit
	// (F3 escalation → quarantine).
	cancelRounds int

	// epoch is this incarnation's spawn number (supervisor assigns;
	// worker mail carrying another epoch is dropped — see handleData).
	epoch int
	// resumeSnap, when non-nil, carries a crash-resume snapshot: after the
	// actor loop starts, the supervisor spawns a Continue worker on the
	// same turn index (v1 resumeAgentTurn parity).
	resumeSnap *workerSnapshot

	lastProgress int64 // unix milli, for watchdog
	residentBytes int64

	// startWorker runs the turn. Production: defaultStartWorker (agent loop).
	// Tests use newTestActor (test-only constructor below) to substitute a
	// stub. The field is set once at construction, never reassigned.
	startWorker func(snap workerSnapshot, env workerEnv, ctx context.Context)
}

func newSessionActor(id string, rec *SessionRecord, store *diskStore, wsSend func(any), bg *bgSupervisor, onEvent func(string)) *sessionActor {
	cfg := new(configCell)
	cfg.store(&DaemonConfig{})
	var jailed bool
	if rec != nil {
		jailed = rec.Jailed
	}
	return &sessionActor{
		id: id, store: store, wsSend: wsSend, bg: bg, onEvent: onEvent, supCfg: cfg, jailed: jailed,
		inbox: make(chan Envelope, inboxCap), control: make(chan any, controlCap),
		rec: rec, state: stateIdle, lastProgress: time.Now().UnixMilli(),
		startWorker: defaultStartWorker,
		approvalWaiters: map[string]chan approvalOutcome{},
		questionWaiters: map[string]chan questionOutcome{},
		convertWaiters:  map[string]chan any{},
	}
}

func (a *sessionActor) touch() { a.lastProgress = time.Now().UnixMilli() }

// setState is the ONLY way to change a.state. Every transition is traced
// (dev) with before/after + gen, so a trace file tells the exact story of
// a session: idle->running->awaitingApproval->running->idle, etc.
func (a *sessionActor) setState(next string) {
	if a.state == next {
		return
	}
	trace("actor.state", map[string]any{"sid": a.id, "from": a.state, "to": next, "gen": a.gen})
	a.state = next
}

func randomID8() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Report item 6: never panic the process on CSPRNG failure in the
		// hot path — fall back to a time-seeded mix (ids stay unique
		// enough; worst case is a queue-id collision, not a crash).
		fmt.Printf("[WARN] crypto/rand failed, using fallback ids: %v\n", err)
		return fallbackID8()
	}
	return fmt.Sprintf("%x", b[:])
}

// run is the actor loop. It terminates on passivate/shutdown.
func (a *sessionActor) run() {
	if a.done == nil {
		a.done = make(chan struct{})
	}
	defer close(a.done)
	flushTick := time.NewTicker(30 * time.Second)
	defer flushTick.Stop()
	for {
		// Drain inbox fully before control: bursty workers (usage +
		// compaction + message + finish in one step) must not leave the
		// finish stranded behind a control ping. Inbox-first also keeps
		// response-vs-timeout ordering single-file.
		select {
		case env := <-a.inbox:
			a.handleData(env)
			continue
		default:
		}
		select {
		case env := <-a.inbox:
			a.handleData(env)
		case msg := <-a.control:
			if done := a.handleControl(msg); done {
				return
			}
		case <-flushTick.C:
			if a.wal != nil {
				_ = a.wal.flush()
			}
		}
	}
}

func (a *sessionActor) handleData(env Envelope) {
	trace("actor.msg", map[string]any{"sid": a.id, "type": msgType(env.Payload), "state": a.state, "gen": a.gen})
	// Epoch gate: worker mail (finish/heartbeat/WAL appends) from a stale
	// incarnation is dropped. Dispatcher/client mail uses epoch 0 and
	// always passes (it carries its own gen/id correlation).
	if env.Epoch != 0 && a.epoch != 0 && env.Epoch != a.epoch {
		return
	}
	switch m := env.Payload.(type) {
	case userPromptMsg:
		a.onUserPrompt(m)
	case queueOpMsg:
		a.onQueueOp(m)
	case transcriptChunkMsg:
		// Legacy protocol surface: the worker streams via the agent sink
		// straight to the ws actor, so this is never sent. Kept for
		// wire-compat; handled as a touch-only no-op.
		a.touch()
	case toolResultMsg:
		// Legacy protocol surface: tool results flow inside the agent loop
		// (agent.RunTool), never as actor messages. Touch-only no-op.
		a.touch()
	case approvalResponseMsg:
		a.onApprovalResponse(m)
	case questionResponseMsg:
		a.onQuestionResponse(m)
	case bgJobFinishedMsg:
		a.touch()
		a.emit(map[string]any{"type": "bg_finished", "sessionId": a.id, "jobId": m.JobID, "exit": m.Exit})
	case stateTimeoutMsg:
		a.onStateTimeout(m)
	case editRegenerateMsg:
		a.onEditRegenerate(m)
	case forkReqMsg:
		a.onFork(m)
	case readReqMsg:
		a.onRead(m)
	case hookMsg:
		m.fn()
	case walAppendMsg:
		a.onWALAppend(m)
	case workerRefreshMsg:
		if m.gen != a.gen {
			select {
			case m.Reply <- workerRefreshResult{stale: true}:
			default:
			}
		} else {
			select {
			case m.Reply <- workerRefreshResult{model: a.rec.Model, options: normalizedOptions(a.rec.Options)}:
			default:
				// Worker stopped waiting (cancelled/timeout): drop.
			}
		}
	case workerApprovalReqMsg:
		a.onWorkerApprovalReq(m)
	case workerQuestionReqMsg:
		a.onWorkerQuestionReq(m)
	case workerConvertReqMsg:
		a.onWorkerConvertReq(m)
	case convertResponseMsg:
		a.onConvertResponse(m)
	case bgNoticeMsg:
		a.onBgNotice(m)
	case turnBalloonMsg:
		// Stashed until finishTurn appends it with the final message count.
		// Gen gate (B1): a zombie worker's balloon must not anchor to a new
		// turn. gen==0 is the legacy/pre-gen caller and is accepted.
		if m.gen != 0 && m.gen != a.gen {
			trace("actor.balloon.stale", map[string]any{"sid": a.id, "gen": m.gen, "cur": a.gen})
			break
		}
		a.pendingBalloon = &m.balloon
	case workerTitleReqMsg:
		var res workerTitleResult
		if m.gen != a.gen {
			res = workerTitleResult{stale: true}
		} else if !needsAutoTitle(a.rec) {
			res = workerTitleResult{stale: true}
		} else {
			res = workerTitleResult{firstText: firstUserText(a.rec), original: a.rec.Title}
		}
		select {
		case m.Reply <- res:
		default:
		}
	case renameMsg:
		a.touch()
		a.rec.Title = m.Title
		a.rec.TitleSource = "manual"
		a.rec.UpdatedAt = time.Now().UnixMilli()
		appendWALEvent(a.wal, walEvent{Type: walTypeTitle, Title: m.Title, TitleSource: "manual"})
		a.pingChange()
		m.Reply <- struct{}{}
	case togglePinMsg:
		a.touch()
		a.rec.Pinned = !a.rec.Pinned
		a.rec.UpdatedAt = time.Now().UnixMilli()
		a.saveOrAppend(walEvent{Type: walTypeMeta})
		a.pingChange()
		// v1 parity: clients track the pin badge from this event (the frozen
		// protocol declares session_pinned). v2 dropped the emit.
		a.emit(map[string]any{"type": "session_pinned", "hostId": a.hostID(), "sessionId": a.id, "pinned": a.rec.Pinned})
	case todosOpenMsg:
		a.touch()
		open := m.Open
		a.rec.TodosOpen = &open
		a.rec.UpdatedAt = time.Now().UnixMilli()
		a.saveOrAppend(walEvent{Type: walTypeMeta})
	case configureMsg:
		a.touch()
		if m.Model != "" {
			a.rec.Model = m.Model
			appendWALEvent(a.wal, walEvent{Type: walTypeModel, Model: m.Model})
		}
		a.rec.Options = normalizedOptions(m.Options)
		opts := a.rec.Options
		appendWALEvent(a.wal, walEvent{Type: walTypeOptions, Options: &opts})
		a.rec.UpdatedAt = time.Now().UnixMilli()
		a.pingChange()
		// v1 parity: configuring a session acks with the updated snapshot so
		// the composer reflects the new options immediately. v2 dropped this
		// and clients saw stale options until the next turn.
		a.emit(map[string]any{"type": "session_data", "hostId": a.hostID(), "session": pagedHistoryBlock(sessionPayload(a.rec), a.rec)})
	case queueSendNowMsg:
		a.onQueueSendNow(m)
	case alwaysAllowMsg:
		a.touch()
		a.rec.Options.Access = "full"
		opts := a.rec.Options
		a.saveOrAppend(walEvent{Type: walTypeOptions, Options: &opts})
		a.pingChange()
		m.Reply <- struct{}{}
	case editApplyMsg:
		m.Reply <- a.onEditApply(m)
	case compactNowMsg:
		a.onCompactNow()
	case slashReplyMsg:
		a.onSlashReply(m)
	case jailMsg:
		a.touch()
		a.jailed = m.Jail
		a.rec.Jailed = m.Jail
		a.saveOrAppend(walEvent{Type: walTypeMeta})
		a.pingChange()
		a.emit(map[string]any{"type": "notice", "sessionId": a.id, "message": jailNotice(m.Jail)})
	case attachUploadMsg:
		m.Reply <- a.onAttachUpload(m)
	case undoMsg:
		m.Reply <- a.onUndo(m)
	case workerTitleMsg:
		if m.gen == a.gen && a.rec.Title == m.original && needsAutoTitle(a.rec) {
			a.rec.Title = m.title
			a.rec.TitleSource = "generated"
			a.rec.UpdatedAt = time.Now().UnixMilli()
			appendWALEvent(a.wal, walEvent{Type: walTypeTitle, Title: m.title, TitleSource: "generated"})
			a.pingChange()
			a.emit(map[string]any{"type": "session_renamed", "sessionId": a.id, "title": m.title, "auto": true})
		}
	case tickFlushMsg:
		if a.wal != nil {
			_ = a.wal.flush()
		}
	case workerHeartbeatMsg:
		if m.gen == a.gen {
			a.touch()
		}
	case workerFinishedMsg:
		a.onWorkerFinished(m)
	}
}

// handleControl returns true when the actor must terminate.
func (a *sessionActor) handleControl(msg any) bool {
	switch m := msg.(type) {
	case cancelTurnMsg:
		a.doCancel(m.Reason)
	case watchdogPingMsg:
		depth := len(a.inbox)
		a.residentBytes = estimateResidentBytes(a.rec)
		m.Reply <- watchdogReport{Alive: true, LastProgress: a.lastProgress, State: a.state, QueueDepth: depth, ResidentBytes: a.residentBytes}
	case passivateMsg:
		a.doPassivate()
		return true
	case shutdownMsg:
		a.doShutdown()
		return true
	case stateTimeoutMsg:
		// Timer fallback path (inbox was full at fire time): requeue to
		// the data lane so response-vs-timeout ordering stays single-file.
		// Non-blocking: if the inbox is STILL full the timeout is dropped
		// — the timer already fired once, and a wedged inbox means the
		// actor is back-pressured, not idle; the next watchdog round
		// observes it. Never lose liveness over this.
		select {
		case a.inbox <- Envelope{Payload: m}:
		default:
		}
	}
	return false
}

// hostID reads the supervisor config nil-safely (tests may leave supCfg empty).
func (a *sessionActor) hostID() string {
	if a == nil || a.supCfg == nil {
		return ""
	}
	if cfg := a.supCfg.load(); cfg != nil {
		return cfg.HostID
	}
	return ""
}

func (a *sessionActor) emit(ev any) {
	if a.wsSend != nil {
		a.wsSend(ev)
	}
}

func (a *sessionActor) pingChange() {
	if a.onEvent != nil {
		a.onEvent("sessions")
	}
}

// ---- prompts & queue ----

func (a *sessionActor) onUserPrompt(m userPromptMsg) {
	a.touch()
	if a.state == stateOrphaned {
		// F3 recovery: a fresh prompt un-quarantines (new turn, new gen,
		// stuck worker's gen is stale so its late finish is ignored).
		a.rec.Status = "idle"
		a.setState(stateIdle)
		a.pingChange()
	}
	if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ {
		if len(a.rec.Queue) >= 30 {
			m.Reply <- promptResult{Error: "queue_full"}
			return
		}
		a.rec.Queue = append(a.rec.Queue, QueuedMessage{ID: randomID8(), Text: m.Text, AttachmentIDs: m.AttachmentIDs, Model: m.Model, YOLO: m.YOLO, CreatedAt: time.Now().UnixMilli()})
		appendWALEvent(a.wal, walEvent{Type: walTypeQueue, Queue: a.rec.Queue})
		a.pingChange()
		m.Reply <- promptResult{Accepted: true, Queued: true}
		return
	}
	if a.state != stateIdle {
		m.Reply <- promptResult{Error: "busy"}
		return
	}
	if err := validateAttachmentIDs(a.rec, m.AttachmentIDs); err != nil {
		m.Reply <- promptResult{Error: err.Error()}
		return
	}
	if m.Model != "" {
		a.rec.Model = m.Model
		appendWALEvent(a.wal, walEvent{Type: walTypeModel, Model: m.Model})
	}
	if m.Options != nil {
		a.rec.Options = normalizedOptions(*m.Options)
		opts := a.rec.Options
		appendWALEvent(a.wal, walEvent{Type: walTypeOptions, Options: &opts})
	}
	// Instant provisional title (v1 startPrompt parity): sidebar feedback
	// before the LLM title lands.
	if t := instantTitle(m.Text); t != "" && (a.rec.Title == "" || a.rec.Title == "New conversation") {
		a.rec.Title = t
		a.rec.TitleSource = "pending"
		a.emit(map[string]any{"type": "session_renamed", "sessionId": a.id, "title": t, "auto": true})
	}
	a.startTurn(m.Text, m.AttachmentIDs, m.Model, m.YOLO, m.Options)
	m.Reply <- promptResult{Accepted: true}
}

func (a *sessionActor) onQueueOp(m queueOpMsg) {
	switch m.Op {
	case "add":
		if len(a.rec.Queue) >= 30 {
			m.Reply <- queueOpResult{Error: "queue_full"}
			return
		}
		a.rec.Queue = append(a.rec.Queue, QueuedMessage{ID: randomID8(), Text: m.Text, AttachmentIDs: m.AttachmentIDs, Model: m.Model, YOLO: m.YOLO, CreatedAt: time.Now().UnixMilli()})
	case "update":
		found := false
		for i, q := range a.rec.Queue {
			if q.ID == m.ID {
				if m.Text != "" {
					a.rec.Queue[i].Text = m.Text
				}
				if m.AttachmentIDs != nil {
					a.rec.Queue[i].AttachmentIDs = m.AttachmentIDs
				}
				if m.Model != "" {
					a.rec.Queue[i].Model = m.Model
				}
				found = true
				break
			}
		}
		if !found {
			m.Reply <- queueOpResult{Error: "not found"}
			return
		}
	case "remove":
		kept := a.rec.Queue[:0]
		for _, q := range a.rec.Queue {
			if q.ID != m.ID {
				kept = append(kept, q)
			}
		}
		a.rec.Queue = kept
	case "reorder":
		byID := map[string]QueuedMessage{}
		for _, q := range a.rec.Queue {
			byID[q.ID] = q
		}
		var out []QueuedMessage
		for _, id := range m.IDs {
			if q, ok := byID[id]; ok {
				out = append(out, q)
			}
		}
		a.rec.Queue = out
	case "clear":
		a.rec.Queue = nil
	default:
		m.Reply <- queueOpResult{Error: "unknown op"}
		return
	}
	appendWALEvent(a.wal, walEvent{Type: walTypeQueue, Queue: a.rec.Queue})
	a.pingChange()
	m.Reply <- queueOpResult{Items: a.rec.Queue}
}

// ---- turn lifecycle ----

func (a *sessionActor) startTurn(prompt string, attachmentIDs []string, model string, yolo bool, options *SessionOptions) {
	if yolo && a.rec.Options.Access == "ask" {
		a.rec.Options.Access = "full"
		opts := a.rec.Options
		appendWALEvent(a.wal, walEvent{Type: walTypeOptions, Options: &opts})
	}
	if options != nil {
		a.rec.Options = normalizedOptions(*options)
		opts := a.rec.Options
		appendWALEvent(a.wal, walEvent{Type: walTypeOptions, Options: &opts})
	}
	a.startTurnWithMeta(prompt, attachmentIDs, model, nil)
}

// startTurnWithMeta seeds the opening user message with extra meta (used by
// background wake-up turns for background_delivery). Refuses when not idle:
// callers racing a fresh user turn fold the notice as late-result instead.
func (a *sessionActor) startTurnWithMeta(prompt string, attachmentIDs []string, model string, meta map[string]string) {
	if a.state != stateIdle {
		return
	}
	a.gen++
	if model != "" {
		a.rec.Model = model
	}
	a.rec.TurnSeq++
	a.rec.Status = "running"
	a.rec.Turn = &TurnActivity{StartedAt: time.Now().UnixMilli(), Status: "running"}
	a.rec.UpdatedAt = time.Now().UnixMilli()
	h := &walHeader{TurnIndex: a.rec.TurnSeq, StartedAt: a.rec.Turn.StartedAt, Model: a.rec.Model, Prompt: prompt, AttachmentIDs: attachmentIDs}
	wal, err := a.store.openWAL(a.id, h)
	if err == nil {
		a.wal = wal
	}
	// NOTE (v1 parity): the actor does NOT seed the user message here.
	// The worker's agent.PromptWithMeta appends it (fires OnMessageAppended
	// → walAppendMsg → record + WAL). Seeding here AND in the agent would
	// duplicate the user turn (caught by live E2E: 2× user + 1× assistant).
	_ = meta
	a.setState(stateRunning)
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.workerDone = make(chan struct{})
	// Race discipline: snapshot on-loop (snapshotTurn copies act.* while
	// we own this goroutine). The goroutine below captures ONLY values —
	// the pre-split code closed over `a` and raced with the loop's next
	// mutation (caught by -race in TestQuarantinePath).
	gen := a.gen
	snap, env := snapshotTurn(a, gen, prompt, meta)
	startFn := a.startWorker
	workerDone := a.workerDone
	go func() {
		defer close(workerDone)
		startFn(snap, env, ctx)
	}()
	a.pingChange()
	// Foreground contract (v1 parity): running status so the UI flips to
	// Stop immediately, not only when the first delta arrives.
	hostID := a.hostID()
	a.emit(map[string]any{
		"type": "session_status", "hostId": hostID, "sessionId": a.id,
		"status": "running", "turn": map[string]any{"startedAt": a.rec.Turn.StartedAt},
	})
}

// defaultStartWorker runs the real agent turn (values only — the snapshot
// ran on-loop in startTurnWithMeta, so this never touches the actor).
func defaultStartWorker(snap workerSnapshot, env workerEnv, ctx context.Context) {
	go runTurnWorker(ctx, env, snap)
}

// hookMsg runs fn on the actor goroutine. Production use: none yet;
// tests use it to drive the actor into awaiting* deterministically.
type hookMsg struct {
	fn func()
}

// workerHeartbeatMsg proves the worker is alive and making progress.
// Sent periodically by the turn loop (stream deltas, tool events); the
// actor only touches lastProgress. Never triggers any state change.
type workerHeartbeatMsg struct {
	gen int
}

// workerFinishedMsg is sent by the worker when it exits.
type workerFinishedMsg struct {
	gen       int
	cancelled bool
	err       string
}

func (a *sessionActor) onWorkerFinished(m workerFinishedMsg) {
	if m.gen != a.gen {
		return // stale worker
	}
	if a.state == stateOrphaned {
		return // quarantined: the stuck worker's late exit changes nothing
	}
	a.cancelRounds = 0
	a.finishTurn(!m.cancelled && m.err == "")
}

// finishTurn commits (or retries) the WAL and promotes the queue head.
func msgType(p any) string { return fmt.Sprintf("%T", p) }

func (a *sessionActor) finishTurn(ok bool) {
	a.clearPending()
	if a.cancel != nil {
		a.cancel = nil
	}
	if a.rec.Turn != nil {
		a.rec.Turn.Status = "done"
		a.rec.Turn.EndedAt = time.Now().UnixMilli()
	}
	if a.pendingBalloon != nil {
		b := *a.pendingBalloon
		b.MessageIndex = len(a.rec.Messages)
		a.rec.FileBalloons = append(a.rec.FileBalloons, b)
		a.pendingBalloon = nil
	}
	a.rec.Status = "idle"
	a.rec.ApprovalDeadlineUnix = 0
	// Commit with retry (3x, v1 semantic). On persistent failure stay
	// running-with-WAL is NOT possible here (worker exited) — record the
	// commit error visibly and keep the WAL for the next boot/respawn.
	var err error
	for i := 0; i < 3; i++ {
		if err = a.store.commitWAL(a.id, a.rec, a.wal); err == nil {
			break
		}
		time.Sleep(time.Duration(i+1) * 200 * time.Millisecond)
	}
	a.wal = nil
	if err != nil {
		a.emit(map[string]any{"type": "commit_error", "sessionId": a.id, "error": err.Error()})
	}
	a.setState(stateIdle)
	a.pingChange()
	// Foreground contract (v1 parity): completion snapshot first (closing
	// metadata + last two turns + history cursor — the client merges by id),
	// then session_status idle (drives the Stop button + turn notify).
	// turn_finished is kept for compat with v2-only listeners.
	snapshot := completionPayload(a.rec)
	hostID := a.hostID()
	if b := lastBalloon(a.rec); b != nil {
		a.emit(map[string]any{
			"type": "turn_file_changes", "hostId": hostID, "sessionId": a.id,
			"live": false, "balloon": fileBalloonPayload(*b),
		})
	}
	a.emit(map[string]any{"type": "session_data", "hostId": hostID, "session": snapshot})
	a.emit(map[string]any{"type": "session_status", "hostId": hostID, "sessionId": a.id, "status": "idle"})
	a.emit(map[string]any{"type": "turn_finished", "sessionId": a.id, "ok": ok})
	// Promote queue head (only the finalizer promotes): a normally
	// completed turn promotes the head; a cancelled turn promotes only
	// when flagged send-now (queue_send_now semantics).
	if len(a.rec.Queue) > 0 && (ok || a.sendNow) {
		head := a.rec.Queue[0]
		a.rec.Queue = a.rec.Queue[1:]
		a.sendNow = false
		a.startTurn(head.Text, head.AttachmentIDs, head.Model, head.YOLO, nil)
	} else {
		a.sendNow = false
	}
}

func (a *sessionActor) doCancel(reason string) {
	trace("actor.cancel", map[string]any{"sid": a.id, "reason": reason, "state": a.state, "gen": a.gen})
	if a.state == stateIdle {
		return
	}
	// F3: cancelling escalation. Each watchdog cancel bumps cancelRounds;
	// a fresh worker exit (finishTurn) resets it. Past the limit the worker
	// is declared stuck: quarantine instead of pinning the session forever.
	a.cancelRounds++
	// Wake blocked workers as stale so no worker hangs forever.
	for id, ch := range a.approvalWaiters {
		delete(a.approvalWaiters, id)
		select {
		case ch <- approvalOutcome{stale: true}:
		default:
		}
	}
	for id, ch := range a.questionWaiters {
		delete(a.questionWaiters, id)
		select {
		case ch <- questionOutcome{stale: true}:
		default:
		}
	}
	for id, ch := range a.convertWaiters {
		delete(a.convertWaiters, id)
		a.emit(map[string]any{"type": "convert_resolved", "sessionId": a.id, "requestId": id})
		select {
		case ch <- convertOutcome{stale: true}:
		default:
		}
	}
	a.clearPending()
	if reason == "watchdog_quarantine" && a.cancelRounds >= maxCancelRounds {
		a.quarantine()
		return
	}
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	// Worker exit funnels through workerFinishedMsg → finishTurn(cancelled).
	// If no worker is running (awaiting* with dead worker), finish directly.
	if a.workerDone == nil {
		a.finishTurn(false)
		return
	}
	a.setState(stateCancel)
	_ = reason
}

// ---- approval / question ----

// enterAwait moves the actor to awaiting* and arms the 15-min timer.
// The deadline is persisted so a respawn recomputes the remainder.
func (a *sessionActor) enterAwait(kind, id string, recommended [][]string) {
	now := time.Now().UnixMilli()
	deadline := now + int64(awaitTimeout/time.Millisecond)
	// Respawn clamp (plan §8): a persisted deadline from before the crash
	// wins over a fresh 15-min window — a restart never extends the wait.
	if a.rec.ApprovalDeadlineUnix > 0 && a.rec.ApprovalDeadlineUnix < deadline {
		deadline = a.rec.ApprovalDeadlineUnix
	}
	a.rec.ApprovalDeadlineUnix = deadline
	appendWALEvent(a.wal, walEvent{Type: walTypeMeta, UpdatedAt: now, ApprovalDeadlineUnix: deadline})
	myID := id
	if myID == "" {
		myID = randomID8()
	}
	remaining := time.Duration(deadline - time.Now().UnixMilli())
	if remaining < 0 {
		remaining = 0
	}
	a.pending = &pendingAsk{id: myID, kind: kind, deadline: deadline, recommended: recommended}
	a.pending.timer = time.AfterFunc(remaining*time.Millisecond, func() {
		select {
		case a.inbox <- Envelope{Payload: stateTimeoutMsg{ID: myID}}:
		default:
			// inbox full: route via control lane so the timeout is never lost
			select {
			case a.control <- stateTimeoutMsg{ID: myID}:
			default:
			}
		}
	})
	if kind == "approval" {
		a.setState(stateAwaitAppr)
	} else {
		a.setState(stateAwaitQ)
	}
}

func (a *sessionActor) clearPending() {
	if a.pending != nil && a.pending.timer != nil {
		a.pending.timer.Stop()
	}
	a.pending = nil
	a.rec.ApprovalDeadlineUnix = 0
}

func (a *sessionActor) onApprovalResponse(m approvalResponseMsg) {
	if a.state != stateAwaitAppr || a.pending == nil || m.ID != a.pending.id {
		// Visible stale: without this line a 3am "approval stuck" debug
		// cannot tell stale-response from lost-waiter from dead-worker.
		cur := ""
		if a.pending != nil {
			cur = a.pending.id
		}
		trace("actor.approval.stale", map[string]any{"sid": a.id, "id": m.ID, "state": a.state, "pending": cur})
		return
	}
	a.touch()
	approved := m.Approved
	trace("actor.approval", map[string]any{"sid": a.id, "id": m.ID, "approved": approved})
	a.clearPending()
	a.setState(stateRunning)
	a.wakeApproval(m.ID, approved)
	a.emit(map[string]any{"type": "approval_resolved", "sessionId": a.id, "callId": m.ID, "approved": approved})
}

func (a *sessionActor) onQuestionResponse(m questionResponseMsg) {
	if a.state != stateAwaitQ || a.pending == nil || m.ID != a.pending.id {
		cur := ""
		if a.pending != nil {
			cur = a.pending.id
		}
		trace("actor.question.stale", map[string]any{"sid": a.id, "id": m.ID, "state": a.state, "pending": cur})
		return
	}
	a.touch()
	trace("actor.question", map[string]any{"sid": a.id, "id": m.ID, "nAnswers": len(m.Answers)})
	a.clearPending()
	a.setState(stateRunning)
	a.wakeQuestion(m.ID, m.Answers)
	a.emit(map[string]any{"type": "question_resolved", "sessionId": a.id, "questionId": m.ID})
}

func (a *sessionActor) onStateTimeout(m stateTimeoutMsg) {
	if a.pending == nil || m.ID != a.pending.id {
		return // loser of response-vs-timeout race
	}
	a.touch()
	switch a.pending.kind {
	case "question":
		id := a.pending.id
		rec := append([][]string{}, a.pending.recommended...)
		a.clearPending()
	a.setState(stateRunning)
		a.emit(map[string]any{"type": "system_notice", "sessionId": a.id, "text": "User didn't respond in 15min — proceeding with recommended."})
		trace("actor.timeout", map[string]any{"sid": a.id, "kind": "question", "id": id})
		a.wakeQuestion(id, rec)
		a.emit(map[string]any{"type": "question_resolved", "sessionId": a.id, "questionId": id})
	case "approval":
		timeoutID := a.pending.id
		a.clearPending()
		trace("actor.timeout", map[string]any{"sid": a.id, "kind": "approval", "id": timeoutID})
		a.emit(map[string]any{"type": "system_notice", "sessionId": a.id, "text": "Approval timed out after 15min — turn cancelled."})
		// Approval timeout cancels the turn but keeps the queue intact.
		// Do NOT drain the inbox here (B2): the timeout message was already
		// delivered, so there is nothing to "requeue" — and the next slot
		// is arbitrary mail (a blocking walAppendMsg, workerFinishedMsg, or
		// a user prompt). Consuming it silently lost transcripts, wedged
		// sessions in `cancelling`, and dropped user prompts. The actor
		// loop continues with the mailbox untouched.
		a.doCancel("approval_timeout")
	}
}

// ---- edit / fork / read ----

func (a *sessionActor) onEditRegenerate(m editRegenerateMsg) {
	if a.state != stateIdle {
		m.Reply <- promptResult{Error: "stop the turn first"}
		return
	}
	a.touch()
	a.gen++
	keep := m.Keep
	if keep < 0 {
		keep = 0
	}
	if keep > len(a.rec.Messages) {
		keep = len(a.rec.Messages)
	}
	a.rec.Messages = append([]provider.Message(nil), a.rec.Messages[:keep]...)
	a.rec.Status = "idle"
	a.rec.UpdatedAt = time.Now().UnixMilli()
	keepTurn := dropTurnForPrefix(a.rec.Messages)
	if err := a.store.truncateTail(a.id, keepTurn, recordMeta(a.rec)); err != nil {
		m.Reply <- promptResult{Error: err.Error()}
		return
	}
	a.pingChange()
	m.Reply <- promptResult{Accepted: true}
}

func (a *sessionActor) onFork(m forkReqMsg) {
	// Snapshot the prefix (actor-local; never stops the source).
	if m.Keep < 0 || m.Keep >= len(a.rec.Messages) {
		m.Reply <- forkResult{Error: "Select a completed message to fork"}
		return
	}
	boundary := a.rec.Messages[m.Keep]
	if boundary.Role != provider.RoleUser && boundary.Role != provider.RoleAssistant {
		m.Reply <- forkResult{Error: "Select a user or assistant message to fork"}
		return
	}
	end := m.Keep + 1
	if boundary.Role == provider.RoleAssistant {
		for end < len(a.rec.Messages) && a.rec.Messages[end].Role == provider.RoleTool {
			end++
		}
	}
	now := time.Now().UnixMilli()
	rec := &SessionRecord{
		ID: "sess_" + randomID8() + randomID8(), CWD: resolvePath(a.rec.CWD),
		Title: a.rec.Title + " (fork)", TitleSource: "manual", Model: a.rec.Model,
		Options: normalizedOptions(a.rec.Options), Status: "idle",
		CreatedAt: now, UpdatedAt: now, TurnSeq: a.rec.TurnSeq,
	}
	brainDir := a.store.brainDir(a.id)
	for _, b := range stripBrainBalloonFiles(a.rec.FileBalloons, brainDir) {
		if b.MessageIndex > 0 && b.MessageIndex <= end {
			rec.FileBalloons = append(rec.FileBalloons, b)
		}
	}
	attachments := append([]AttachmentRef{}, a.rec.Attachments...)
	for _, msg := range a.rec.Messages[:end] {
		data, err := json.Marshal(msg)
		if err != nil {
			m.Reply <- forkResult{Error: "Could not copy the conversation: " + err.Error()}
			return
		}
		cp, err := core.HydrateMessageObject(data)
		if err != nil {
			m.Reply <- forkResult{Error: "Could not copy the conversation: " + err.Error()}
			return
		}
		rec.Messages = append(rec.Messages, cp)
	}
	if st := a.rec.Compaction; st != nil && st.KeepFrom >= 0 && st.KeepFrom <= end {
		cp := *st
		rec.Compaction = &cp
	}
	used := map[string]bool{}
	for _, msg := range rec.Messages {
		for _, id := range messageAttachmentIDs(msg, attachments) {
			used[id] = true
		}
	}
	dir := filepath.Join(a.store.sessionsDir(), rec.ID, "attachments")
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(filepath.Dir(dir))
		}
	}()
	for _, attachment := range attachments {
		if !used[attachment.ID] {
			continue
		}
		attachment.UploadKey = ""
		paths := map[string]string{}
		ok := true
		for _, pair := range []struct {
			source string
			target *string
		}{{attachment.Path, &attachment.Path}, {attachment.TextPath, &attachment.TextPath}} {
			if pair.source == "" {
				continue
			}
			target := filepath.Join(dir, filepath.Base(pair.source))
			if err := copyForkAttachment(pair.source, target); err != nil {
				m.Reply <- forkResult{Error: "Could not copy attachment " + attachment.Name}
				ok = false
				break
			}
			paths[pair.source] = target
			*pair.target = target
		}
		if !ok {
			return
		}
		for i := range rec.Messages {
			rec.Messages[i].Content = forkContentPaths(rec.Messages[i].Content, paths)
		}
		rec.Attachments = append(rec.Attachments, attachment)
	}
	if err := a.store.saveSessionSync(rec); err != nil {
		m.Reply <- forkResult{Error: "Could not save the fork: " + err.Error()}
		return
	}
	committed = true
	m.Reply <- forkResult{NewID: rec.ID}
}

func (a *sessionActor) onRead(m readReqMsg) {
	// Served from actor RAM (plan §6/§7.2). Payloads are COPIES: the
	// caller reads off-goroutine, so handing out the live *SessionRecord
	// (or its backing array) is a data race. Copies are cheap next to the
	// disk/network work around them.
	switch m.What {
	case "session", "data":
		cp := *a.rec
		cp.Messages = append([]provider.Message(nil), a.rec.Messages...)
		cp.Queue = append([]QueuedMessage(nil), a.rec.Queue...)
		cp.Attachments = append([]AttachmentRef(nil), a.rec.Attachments...)
		cp.FileBalloons = append([]filetrack.TurnChanges(nil), a.rec.FileBalloons...)
		m.Reply <- readResult{Payload: &cp}
	case "history":
		msgs := a.rec.Messages
		if m.Limit > 0 && len(msgs) > m.Limit {
			msgs = msgs[len(msgs)-m.Limit:]
		}
		m.Reply <- readResult{Payload: append([]provider.Message(nil), msgs...)}
	case "historyBlock":
		block := sliceHistoryBlock(a.rec.Messages, a.rec.FileBalloons, m.BeforeTurn)
		block.Attachments = append([]AttachmentRef(nil), a.rec.Attachments...)
		m.Reply <- readResult{Payload: block}
	default:
		m.Reply <- readResult{Error: "unknown read"}
	}
}

// onWALAppend applies one worker event to the in-memory record + WAL.
// Runs on the actor goroutine: single ownership, no locks.
func (a *sessionActor) onWALAppend(m walAppendMsg) {
	// Gen gate (B1): a zombie worker from a quarantined incarnation keeps
	// the same epoch but an older gen. Without this check its late appends
	// pass the epoch gate and are written into the NEW turn's WAL — durable
	// corruption. gen==0 is the legacy/pre-gen caller (tests, older wire
	// shapes) and is accepted.
	if m.gen != 0 && m.gen != a.gen {
		trace("actor.wal.stale", map[string]any{"sid": a.id, "gen": m.gen, "cur": a.gen})
		return
	}
	// State gate: apply worker appends while the turn owns the open WAL.
	// stateCancel is included on purpose — a cancelled worker still emits
	// its partial assistant message (agent preserves visible text on abort)
	// before exiting, and dropping it lost that content (v1 kept it).
	if a.state != stateRunning && a.state != stateAwaitAppr && a.state != stateAwaitQ && a.state != stateCancel {
		return
	}
	a.touch()
	ev := m.ev
	switch ev.Type {
	case walTypeMsg:
		if len(ev.Msg) > 0 {
			// Hydrate through core (content blocks are interfaces —
			// plain Unmarshal yields nil Content and drops the text).
			if msg, err := core.HydrateMessageObject(ev.Msg); err == nil {
				a.rec.Messages = append(a.rec.Messages, msg)
			} else {
				fmt.Printf("[WARN] session %s: bad WAL msg: %v\n", a.id, err)
			}
		}
	case walTypeUsage:
		if ev.Usage != nil {
			a.rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			a.rec.Context = ev.Context
		}
	case walTypeTodos:
		a.rec.Todos = append([]tools.TodoItem{}, ev.Todos...)
	case walTypeCompaction:
		if ev.Compaction != nil {
			cp := *ev.Compaction
			a.rec.Compaction = &cp
		}
		if ev.Usage != nil {
			a.rec.Usage = *ev.Usage
		}
		if ev.Context != nil {
			a.rec.Context = ev.Context
		}
	case walTypeIncoming:
		// tracker snapshot only; no record change.
	case walTypeQueue, walTypeTitle, walTypeModel, walTypeOptions, walTypeTurnState, walTypeMeta, walTypeAttach:
		a.applyControlWAL(ev)
	}
	a.rec.UpdatedAt = time.Now().UnixMilli()
	trace("actor.wal", map[string]any{"sid": a.id, "type": ev.Type, "turn": a.rec.TurnSeq, "msgs": len(a.rec.Messages)})
	appendWALEvent(a.wal, ev)
}

// applyControlWAL applies non-transcript WAL events to the record.
func (a *sessionActor) applyControlWAL(ev walEvent) {
	switch ev.Type {
	case walTypeQueue:
		a.rec.Queue = append([]QueuedMessage(nil), ev.Queue...)
	case walTypeTitle:
		if ev.Title != "" {
			a.rec.Title = ev.Title
		}
		if ev.TitleSource != "" {
			a.rec.TitleSource = ev.TitleSource
		}
	case walTypeModel:
		if ev.Model != "" {
			a.rec.Model = ev.Model
		}
	case walTypeOptions:
		if ev.Options != nil {
			a.rec.Options = *ev.Options
		}
	case walTypeTurnState:
		if a.rec.Turn != nil && ev.TurnStatus != "" {
			a.rec.Turn.Status = ev.TurnStatus
		}
	case walTypeAttach:
		// v1 has no attach WAL event in practice; attachments persist via commit.
		_ = ev.Attachments
	case walTypeMeta:
		// Commit marker / deadline persistence + LastDate/LastMode (date/mode
		// directives fire once per change).
		if ev.LastDate != "" {
			a.rec.LastDate = ev.LastDate
		}
		if ev.LastMode != "" {
			a.rec.LastMode = ev.LastMode
		}
	}
}

// onWorkerApprovalReq moves to awaitingApproval, emits the WS request and
// arms the 15-min timer. The worker blocks on m.reply until the human
// answers, the timer fires, or the turn is cancelled.
func (a *sessionActor) onWorkerApprovalReq(m workerApprovalReqMsg) {
	if m.gen != a.gen || (a.state != stateRunning) {
		m.reply <- approvalOutcome{stale: true}
		return
	}
	a.touch()
	a.approvalWaiters[m.id] = m.reply
	trace("actor.wait", map[string]any{"sid": a.id, "kind": "approval", "id": m.id, "tool": m.tool})
	a.enterAwait("approval", m.id, nil)
	a.emit(map[string]any{"type": "tool_approval_request", "sessionId": a.id, "callId": m.callID, "tool": m.tool, "args": m.args})
}

// onWorkerQuestionReq: same for the question tool.
func (a *sessionActor) onWorkerQuestionReq(m workerQuestionReqMsg) {
	if m.gen != a.gen || (a.state != stateRunning) {
		m.reply <- questionOutcome{stale: true}
		return
	}
	a.touch()
	trace("actor.wait", map[string]any{"sid": a.id, "kind": "question", "id": m.id})
	a.questionWaiters[m.id] = m.reply
	var rec [][]string
	for _, q := range m.req.Questions {
		if len(q.Options) > 0 {
			rec = append(rec, []string{q.Options[0].Label})
		} else {
			rec = append(rec, nil)
		}
	}
	a.enterAwait("question", m.id, rec)
	a.emit(map[string]any{"type": "question_request", "sessionId": a.id, "questionId": m.id, "question": m.req})
}

// wakeApproval delivers the human decision to the blocked worker.
func (a *sessionActor) wakeApproval(id string, approved bool) {
	ch, ok := a.approvalWaiters[id]
	if !ok {
		trace("actor.waiter.lost", map[string]any{"sid": a.id, "kind": "approval", "id": id})
		return
	}
	delete(a.approvalWaiters, id)
	select {
	case ch <- approvalOutcome{approved: approved}:
	default:
	}
}

func (a *sessionActor) wakeQuestion(id string, answers [][]string) {
	ch, ok := a.questionWaiters[id]
	if !ok {
		trace("actor.waiter.lost", map[string]any{"sid": a.id, "kind": "question", "id": id})
		return
	}
	delete(a.questionWaiters, id)
	select {
	case ch <- questionOutcome{answers: answers}:
	default:
	}
}

// onBgNotice folds a completion/cancellation notice into the stream.
// v1 semantics: late-result into the live turn when running, otherwise a
// wake-up turn on the idle session carrying the notice as its prompt.
func (a *sessionActor) onBgNotice(m bgNoticeMsg) {
	a.touch()
	a.emit(map[string]any{"type": "bg_notice", "sessionId": a.id, "jobId": m.JobID, "text": noticePreview(m.Text), "finished": m.Finished})
	if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ {
		msg := provider.Message{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: m.Text}}, TurnIndex: a.rec.TurnSeq, Meta: map[string]string{"background_delivery": m.JobID}}
		a.rec.Messages = append(a.rec.Messages, msg)
		appendWALEvent(a.wal, walMsgEvent(msg))
		a.pingChange()
		return
	}
	if a.state != stateIdle {
		return
	}
	// Idle: wake-up turn. At most one per session: if a fresh user turn won
	// the race between our state check and startTurn, startTurn refuses
	// (state != idle) and we fold the notice as late-result instead.
	// The notice text is the turn prompt with background_delivery meta, so
	// the model sees exactly what v1 delivered via runAgentTurnWithMeta.
	a.startTurnWithMeta(m.Text, nil, "", map[string]string{"background_delivery": m.JobID})
}

func noticePreview(text string) string {
	if len(text) > 500 {
		return text[:500] + "…"
	}
	return text
}

// saveOrAppend persists a control event: WAL when running, direct save idle.
func (a *sessionActor) saveOrAppend(ev walEvent) {
	if a.state == stateRunning || a.state == stateAwaitAppr || a.state == stateAwaitQ {
		appendWALEvent(a.wal, ev)
		return
	}
	a.rec.UpdatedAt = time.Now().UnixMilli()
	_ = a.store.saveSessionSync(a.rec)
}

// onWorkerConvertReq emits convert_request to the browser and arms a 60s
// timer. First valid response wins; stale replies can't answer a later
// request; cancel wakes the worker as stale.
func (a *sessionActor) onWorkerConvertReq(m workerConvertReqMsg) {
	if m.gen != a.gen {
		m.reply <- convertOutcome{stale: true}
		return
	}
	a.touch()
	a.convertWaiters[m.id] = m.reply
	if a.convertServer != nil {
		a.convertServer(map[string]any{"type": "convert_request", "sessionId": a.id, "requestId": m.id, "filename": m.filename, "data": m.data})
	}
	id := m.id
	time.AfterFunc(convertTimeout, func() {
		select {
		case a.inbox <- Envelope{Payload: convertResponseMsg{id: id, err: "no browser available for conversion"}}:
		default:
			select {
			case a.control <- convertResponseMsg{id: id, err: "no browser available for conversion"}:
			default:
			}
		}
	})
}

func (a *sessionActor) onConvertResponse(m convertResponseMsg) {
	ch, ok := a.convertWaiters[m.id]
	if !ok {
		return
	}
	delete(a.convertWaiters, m.id)
	a.emit(map[string]any{"type": "convert_resolved", "sessionId": a.id, "requestId": m.id})
	select {
	case ch <- convertOutcome{text: m.text, err: m.err, stale: m.stale}:
	default:
	}
}

// ---- passivate / shutdown ----

// quarantine (F3): the worker ignores context. Close the WAL, mark the
// record orphaned, go idle-but-refusing. route() surfaces stateOrphaned as
// an explicit error; a fresh prompt may un-quarantine (new turn, new gen).
func (a *sessionActor) quarantine() {
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	for i := 0; i < 3; i++ {
		if err := a.store.commitWAL(a.id, a.rec, a.wal); err == nil {
			break
		}
		time.Sleep(time.Duration(i+1) * 200 * time.Millisecond)
	}
	rounds := a.cancelRounds
	a.wal = nil
	a.cancelRounds = 0
	a.sendNow = false
	a.clearPending()
	a.rec.Status = "orphaned"
	a.rec.UpdatedAt = time.Now().UnixMilli()
	_ = a.store.saveSessionSync(a.rec)
	trace("actor.quarantine", map[string]any{"sid": a.id, "gen": a.gen, "rounds": rounds})
	a.setState(stateOrphaned)
	a.pingChange()
	a.emit(map[string]any{"type": "session_status", "hostId": a.hostID(), "sessionId": a.id, "status": "orphaned",
		"error": "turn worker stuck: context ignored for ~2min; session quarantined, start a new turn to recover"})
}

func (a *sessionActor) doPassivate() {
	a.clearPending()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	for i := 0; i < 3; i++ {
		if err := a.store.commitWAL(a.id, a.rec, a.wal); err == nil {
			break
		}
		time.Sleep(time.Duration(i+1) * 200 * time.Millisecond)
	}
	a.wal = nil
}

func (a *sessionActor) doShutdown() { a.doPassivate() }

// instantTitle is the provisional sidebar title from the prompt's own first
// 6 content words (v1 startPrompt parity); the LLM title replaces it later.
func instantTitle(text string) string {
	clean := strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if r == '/' || r == '"' || r == '\'' || r == '`' {
			return -1
		}
		return r
	}, strings.TrimSpace(text))
	words := strings.Fields(clean)
	if len(words) == 0 {
		return ""
	}
	cut := false
	if len(words) > 6 {
		words = words[:6]
		cut = true
	}
	out := strings.TrimSpace(strings.Join(words, " "))
	if cut {
		out += "…"
	}
	if r := []rune(out); len(r) > 60 {
		out = strings.TrimSpace(string(r[:60])) + "…"
	}
	return out
}

// estimateResidentBytes is the LRU-budget heuristic: serialized message
// bytes + attachment sizes + queue + WAL buffer estimate. Cheap (no JSON
// marshal — walks content blocks by length), refined with real numbers in
// load tests.
func estimateResidentBytes(rec *SessionRecord) int64 {
	if rec == nil {
		return 0
	}
	var n int64
	for _, m := range rec.Messages {
		n += estimateMessageBytes(m)
	}
	for _, a := range rec.Attachments {
		n += a.Size
	}
	for _, q := range rec.Queue {
		n += int64(len(q.Text))
	}
	for _, b := range rec.FileBalloons {
		n += int64(len(b.Files) * 512)
	}
	// WAL buffer + record overhead slack.
	n += 256 * 1024
	return n
}

// estimateMessageBytes sums every content block of a message, recursing
// into tool results (nested Content + frontend Details). B3: the old
// top-level TextBlock-only walk ignored tool output and images, which
// dominate real sessions — a 2 MB tool result counted as ~0, so the LRU
// budget never tripped and the daemon could blow past its memory cap.
func estimateMessageBytes(m provider.Message) int64 {
	var n int64
	for _, c := range m.Content {
		n += estimateContentBytes(c)
	}
	for k, v := range m.Meta {
		n += int64(len(k) + len(v))
	}
	return n
}

func estimateContentBytes(c provider.Content) int64 {
	switch b := c.(type) {
	case provider.TextBlock:
		return int64(len(b.Text))
	case provider.ImageBlock:
		return int64(len(b.Data))
	case provider.ReasoningBlock:
		return int64(len(b.Summary) + len(b.Encrypted))
	case provider.ToolCallBlock:
		return int64(len(b.Name) + len(b.Arguments))
	case provider.ToolResultBlock:
		var n int64
		for _, inner := range b.Content {
			n += estimateContentBytes(inner)
		}
		// Details is frontend-only rendering data (persisted with the
		// transcript), so it counts against RAM like any other field.
		if b.Details != nil {
			if raw, err := json.Marshal(b.Details); err == nil {
				n += int64(len(raw))
			}
		}
		return n
	}
	return 0
}
