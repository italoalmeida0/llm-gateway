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
	What string // "session" | "data" | "history" | "historyBlock"
	Limit      int
	BeforeTurn int // historyBlock cursor
	Reply      chan any // readResult
}

// tickFlushMsg flushes the WAL buffer (periodic self-timer).
type tickFlushMsg struct{}

// ---- control lane (control, always accepted) ----

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
type passivateMsg struct{}

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
}

// watchdogReport is the session actor's liveness answer.
type watchdogReport struct {
	Alive         bool
	LastProgress  int64 // unix milli of last useful message
	State         string
	QueueDepth    int
	ResidentBytes int64
}

// ---- results shared with the supervisor ----

// spawnResult answers a route request. Done closes when the actor loop
// returns, so callers can wait for passivate/shutdown to finish.
type spawnResult struct {
	Inbox   chan Envelope
	Control chan any
	Done    <-chan struct{}
	Error   string
	// Resumed reports a crash-resume spawn (Continue worker on the WAL
	// turn). Traced at route; informational for dashboards.
	Resumed bool
}

// ---- worker -> actor (sent by the turn worker, handled on the actor loop) ----

// walAppendMsg appends one WAL event + applies it to the in-memory record.
type walAppendMsg struct {
	ev             walEvent
	liveReset      bool // assistant message started: clear live tail
	contextNotice  provider.Message
	hasContext     bool
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

// turnBalloonMsg carries the finished file-changes balloon.
type turnBalloonMsg struct {
	balloon filetrack.TurnChanges
}

// workerTitleReqMsg / workerTitleMsg: gen-guarded auto-title handshake.
type workerTitleReqMsg struct {
	gen   int
	Reply chan any
}

type workerTitleResult struct {
	stale      bool
	firstText  string
	original   string
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
