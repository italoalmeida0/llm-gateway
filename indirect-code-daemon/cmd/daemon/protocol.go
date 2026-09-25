package main

import (
	"encoding/json"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Session actor message protocol.
//
// The session actor owns its SessionRecord outright: no lock, no shared
// access. Everyone else sends one of these messages. The actor processes
// them one at a time from its mailbox; "paused" (waiting for a human) is a
// value in state.name, never a blocked goroutine — the mailbox stays live
// while awaiting approval/question.

// ---- data lane (inbox) ----

// userPromptMsg starts a turn, or queues behind the running one.
type userPromptMsg struct {
	Text          string
	AttachmentIDs []string
	Model         string
	YOLO          bool
	Options       *SessionOptions // nil = keep current (v1 startPrompt parity)
	Reply         chan any        // promptResult
}

// queueOpMsg mutates the waiting queue. Served only when it cannot disturb
// a running turn.
type queueOpMsg struct {
	Op            string // "add" | "remove" | "reorder" | "clear"
	Text          string
	AttachmentIDs []string
	Model         string
	YOLO          bool
	ID            string   // remove
	IDs           []string // reorder
	Reply         chan any // queueOpResult
}

// transcriptChunkMsg carries one streamed delta from the turn worker to the
// frontend. Forwarded even while state is awaiting* — streaming is not
// blocked by a pending human decision.
type transcriptChunkMsg struct {
	Delta any // opaque to the actor; serialized by the ws actor
}

// toolResultMsg feeds a finished tool batch back into the pending turn.
type toolResultMsg struct {
	CallID  string
	Payload any
}

// approvalResponseMsg answers a pending tool approval. Correlated by id;
// a stale id (turn moved on) is dropped.
type approvalResponseMsg struct {
	ID       string
	Approved bool
}

// questionResponseMsg answers a pending question. Correlated by id.
type questionResponseMsg struct {
	ID      string
	Answers [][]string
}

// bgAckMsg acknowledges that a background notice was folded into the
// session transcript (V2-003) — the pending delivery may be retired.
type bgAckMsg struct {
	JobID string
}

// bgDropNoticesMsg terminates pending notice delivery for a deleted
// session (V2-003): deletion is never undone by a late notice.
type bgDropNoticesMsg struct {
	SessionID string
}

// bgJobFinishedMsg is forwarded by the bg supervisor when a job of this
// session terminates. Folded into the transcript; wakes a sleeping worker.
type bgJobFinishedMsg struct {
	JobID string
	Exit  int
}

// stateTimeoutMsg fires when a 15-min approval/question timer elapses.
// The timer is armed on entering awaiting* and stopped on exit; whoever
// reaches the mailbox first (response or timeout) wins, the loser finds a
// mismatched id and is dropped.
type stateTimeoutMsg struct {
	ID string
}

// editRegenerateMsg truncates the tail and starts a fresh turn.
// Accepted ONLY in idle (simpler than v1's branches).
type editRegenerateMsg struct {
	Keep          int
	AttachmentIDs []string
	Model         string
	Reply         chan any // promptResult
}

// forkReqMsg snapshots a prefix of this session into a new session id.
type forkReqMsg struct {
	NewID string
	Keep  int
	Title string
	Reply chan any // forkResult
}

// readReqMsg serves history_page/session_data from actor RAM. If the session
// is passivated the supervisor loads it from disk first (see supervisor.go).
type readReqMsg struct {
	What       string // "session" | "data" | "history" | "historyBlock"
	Limit      int
	BeforeTurn int      // historyBlock cursor
	Reply      chan any // readResult
}

// tickFlushMsg flushes the WAL buffer (periodic self-timer).
type tickFlushMsg struct{}

// ---- control lane (control, priority: senders wait or answer busy,
// cancellations are never silently dropped) ----

// cancelTurnMsg aborts the running turn. Discards awaiting* state.
type cancelTurnMsg struct {
	Reason string
}

// watchdogPingMsg asks for a liveness report. Answered immediately.
type watchdogPingMsg struct {
	Reply chan any // watchdogReport
}

// passivateMsg commits the WAL, closes it and terminates the actor.
// State persists on disk; the next message re-spawns transparently.
type passivateMsg struct{ Reply chan bool }

// shutdownMsg commits the WAL and terminates the actor.
type shutdownMsg struct{}

// ---- replies ----

type promptResult struct {
	Accepted bool
	Queued   bool
	Error    string
}

type queueOpResult struct {
	Error string
	Items []QueuedMessage
}

type forkResult struct {
	Error string
	NewID string
}

type readResult struct {
	Error   string
	Payload any
	// Extra carries the actor-owned transient client overlay (V2-004):
	// the outstanding decision (if any) + live turn state, answered from
	// the actor's own loop so it is ordered with surrounding stream events.
	Extra map[string]any
}

// watchdogReport is the session actor's liveness answer.
type watchdogReport struct {
	Alive         bool
	LastProgress  int64  // unix milli of last useful message
	State         string
	QueueDepth    int
	ResidentBytes int64
	// V2-001: expected blocking wait in effect — WaitUntil > now means the
	// watchdog must not judge this worker by missing progress events.
	WaitOp    string
	WaitUntil int64 // unix milli
}

// ---- results shared with the supervisor ----

// spawnResult answers a route request. Done closes when the actor loop
// returns, so callers can wait for passivate/shutdown to finish.
type spawnResult struct {
	Inbox   chan Envelope
	Control chan any
	Done    <-chan struct{}
	Error   string
}

// ---- worker -> actor (sent by the turn worker, handled on the actor loop) ----

// walAppendMsg appends one WAL event + applies it to the in-memory record.
// gen is the worker's turn generation (set by turnBridge.sendInbox). A
// quarantined worker keeps its old incarnation: after recovery a fresh
// prompt bumps gen without changing epoch, so gen is the guard that stops
// a zombie worker's late appends from landing in the NEW turn (B1).
type walAppendMsg struct {
	gen           int
	ev            walEvent
	liveReset     bool // assistant message started: clear live tail
	contextNotice provider.Message
	hasContext    bool
}

// workerRefreshMsg asks the actor for current model/options (BeforeRequest).
type workerRefreshMsg struct {
	gen   int
	Reply chan any
}

type workerRefreshResult struct {
	stale   bool
	model   string
	options SessionOptions
	context []provider.Message
}

// workerApprovalReqMsg: worker blocked in approveTool; actor moves to
// awaitingApproval, emits tool_approval_request, arms the 15-min timer.
type workerApprovalReqMsg struct {
	gen    int
	id     string
	tool   string
	args   json.RawMessage
	callID string
	reply  chan approvalOutcome
}

// workerQuestionReqMsg: same for the question tool.
type workerQuestionReqMsg struct {
	gen   int
	id    string
	req   tools.QuestionRequest
	reply chan questionOutcome
}

// workerConvertReqMsg: worker blocked in requestConvert; the actor emits
// convert_request to the browser, arms a 60s timer, and wakes the worker on
// convert_response/timeout/cancel.
type workerConvertReqMsg struct {
	gen      int
	id       string
	filename string
	data     string
	reply    chan any // convertOutcome
}

// convertResponseMsg routes a browser convert_response to the actor.
type convertResponseMsg struct {
	id    string
	text  string
	err   string
	stale bool // worker gone: just emit convert_resolved
}

// turnBalloonMsg carries the finished file-changes balloon. gen guard as
// in walAppendMsg: a zombie worker's balloon must not anchor to a new turn.
type turnBalloonMsg struct {
	gen     int
	balloon filetrack.TurnChanges
}

// workerTitleReqMsg / workerTitleMsg: gen-guarded auto-title handshake.
type workerTitleReqMsg struct {
	gen   int
	Reply chan any
}

type workerTitleResult struct {
	stale     bool
	firstText string
	original  string
}

type workerTitleMsg struct {
	gen      int
	title    string
	original string
}

// ---- V2.3 session commands (ws_server -> session actor) ----

// renameMsg renames the session (TitleSource=manual).
type renameMsg struct {
	Title string
	Reply chan any
}

// togglePinMsg flips Pinned.
type togglePinMsg struct{}

// todosOpenMsg sets TodosOpen.
type todosOpenMsg struct {
	Open bool
}

// configureMsg applies model + options (BeforeRequest picks them up).
type configureMsg struct {
	Model   string
	Options SessionOptions
}

// queueSendNowMsg moves a queued item to the head; the finalizer path
// promotes it (cancelling the running turn first, v1 semantics).
type queueSendNowMsg struct {
	QueueID string
}

// alwaysAllowMsg upgrades access to full (approval "always allow").
type alwaysAllowMsg struct {
	Reply chan any
}

// editApplyMsg applies a saved (non-regen) edit to message Index.
type editApplyMsg struct {
	Index         int
	Text          string
	AttachmentIDs []string
	Reply         chan any
}

type editApplyResult struct {
	Error string
}

// compactNowMsg triggers manual compaction (runs inside the turn worker
// when idle: starts a compaction-only turn).
type compactNowMsg struct{}

// slashReplyMsg appends a deterministic user/assistant pair (a slash
// command and its canned reply) with no model call — v1 /help parity.
// It is the only deterministic transcript seeder, so the black-box tests
// rely on it; keeping it actor-owned keeps the record single-writer.
type slashReplyMsg struct {
	Command string
	Reply   string
	Ack     chan any
}

// jailMsg locks/unlocks the sandbox for future turns.
type jailMsg struct {
	Jail bool
}

// attachUploadMsg stores an attachment upload.
type attachUploadMsg struct {
	Name  string
	Mime  string
	Data  string
	Text  string
	Reply chan any
}

type attachUploadResult struct {
	Error      string
	Attachment messageAttachment
}

// undoMsg runs undo of turn changes.
type undoMsg struct {
	TurnIndex int
	Path      string
	Reply     chan any
}

type undoResult struct {
	Error    string
	Warning  string
	Results  []any
	Complete bool
}

// workerEmitMsg fences streaming events from a quarantined turn.
type workerEmitMsg struct {
	gen   int
	event any
}
