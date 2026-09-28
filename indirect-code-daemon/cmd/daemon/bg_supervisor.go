package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Background job kinds + statuses (same wire values as v1).
const (
	BgKindBash   = "bash"
	BgKindPython = "python"

	BgStatusRunning   = "running"
	BgStatusDone      = "done"
	BgStatusError     = "error"
	BgStatusCancelled = "cancelled"
	BgStatusOrphaned  = "orphaned"
)

const (
	bgResultCap = 50 * 1024
	bgStreamCap = 16 * 1024
	bgLabelMax  = 300
)

// bgJob is one background task. The supervisor goroutine owns the TABLE;
// each job's mutable fields are written only by terminal transitions that
// funnel through the supervisor mailbox (finish/cancel), plus the waiter
// goroutine's single exit report. stop/cancel/done are set at register
// and never mutated afterwards (safe for concurrent read).
type bgJob struct {
	ID         string
	Kind       string
	SessionID  string
	Label      string
	PID        int
	Identity   string
	// Runner marks a crash-only runner-backed job (V2R-003): its durable
	// state file under runners/ is the SOLE recovery authority, so the
	// legacy pidfile path must never re-adopt or finalize it.
	Runner   bool
	Status   string
	StartedAt  int64
	EndedAt    int64
	Result     string
	StderrPath string
	LogPath    string
	// BrainLog is the readable final log (the notice points here); empty
	// on the direct path, where LogPath is already readable.
	BrainLog string

	ctx    context.Context
	cancel context.CancelFunc
	stop   func()

	done     chan struct{}
	doneOnce sync.Once
}

func (j *bgJob) closeDone() {
	j.doneOnce.Do(func() { close(j.done) })
}

// bgPidfile is written per job so a supervisor (re)start can re-adopt live
// processes. Jobs are NEVER re-run: re-adoption only.
type bgPidfile struct {
	JobID      string `json:"jobId"`
	PID        int    `json:"pid"`
	SessionID  string `json:"sessionId"`
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	Identity   string `json:"identity,omitempty"`
	Runner     bool   `json:"runner,omitempty"`
	StderrPath string `json:"stderrPath,omitempty"`
	LogPath    string `json:"logPath"`
	StartedAt  int64  `json:"startedAt"`
}

// ---- supervisor messages ----

type bgRegisterMsg struct {
	Kind       string
	SessionID  string
	Label      string
	StderrPath string
	LogPath    string
	PID        int
	// JobID adopts the runner's pre-generated identity when set
	// (crash-only tasks exist from spawn in runners/<jobId>.state.json).
	JobID string
	// BrainLog is the readable final log destination (the runner copies
	// there at terminal). The completion notice points HERE so a jailed
	// session can read it (V2R-010); the live tail keeps using LogPath.
	BrainLog string
	Stop     func()
	Reply    chan any
}

type bgRegisterResult struct {
	Error string
	JobID string
	Done  <-chan struct{}
}

type bgFinishMsg struct {
	JobID  string
	Status string // done | error
	Result string
}

type bgCancelMsg struct {
	JobID string
	By    string // "user" | "assistant" | "" silent
	Reply chan any
}

type bgSubscribeMsg struct {
	SessionID string
	Done      <-chan struct{} // host done (turn end): unsubscribe
	Reply     chan any        // chan struct{} closed on first finish
}

// bgLogPathMsg corrects the log path after the worker renames the pending
// file to the final <jobID>.log.
type bgLogPathMsg struct {
	JobID   string
	LogPath string
}

// ---- supervisor ----

type bgSupervisor struct {
	dataDir string
	inbox   chan Envelope
	control chan any

	emit    func(any)
	hostID  func() string
	session func(id string) (chan Envelope, chan any, bool) // route to session actor

	jobs        map[string]*bgJob
	subscribers map[chan struct{}]string
	// notices tracks completion/cancellation delivery INDEPENDENTLY of
	// job completion (V2-003): a notice is retained, retried and only
	// dropped once the session acknowledges folding it into its
	// transcript. Keyed by job id — redelivery is idempotent.
	notices map[string]*pendingNotice
	done    chan struct{}
}

// pendingNotice is one undelivered/unacknowledged session notice.
type pendingNotice struct {
	JobID     string `json:"jobId"`
	SessionID string `json:"sessionId"`
	Text      string `json:"text"`
	Finished  bool   `json:"finished"`
	Attempts  int    `json:"attempts"`
}

func newBGSupervisor(dataDir string) *bgSupervisor {
	return &bgSupervisor{
		dataDir:     dataDir,
		inbox:       make(chan Envelope, inboxCap),
		control:     make(chan any, controlCap),
		jobs:        map[string]*bgJob{},
		subscribers: map[chan struct{}]string{},
		notices:     map[string]*pendingNotice{},
		done:        make(chan struct{}),
	}
}

func (b *bgSupervisor) bgDir() string { return filepath.Join(b.dataDir, "bg") }

func (b *bgSupervisor) pidPath(jobID string) string {
	return filepath.Join(b.bgDir(), jobID+".pid.json")
}

func (b *bgSupervisor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	defer close(b.done)
	defer func() {
		for ch := range b.subscribers {
			b.unsubscribe(ch)
		}
	}()
	b.readopt()
	b.loadNotices()
	b.adoptRunners()
	retry := time.NewTicker(bgNoticeRetryEvery)
	gc := time.NewTicker(time.Hour) // F8: hourly runner GC + boot
	defer retry.Stop()
	defer gc.Stop()
	for {
		select {
		case env := <-b.inbox:
			b.handle(env)
		case <-gc.C:
			b.gcRunners(time.Now().UnixMilli())
		case <-retry.C:
			// V2-003: independent, non-blocking redelivery of retained
			// notices — a busy session never blocks listing/cancel/finish.
			b.flushNotices()
		case msg := <-b.control:
			switch msg.(type) {
			case shutdownMsg:
				return
			default:
				_ = msg
			}
		}
	}
}

func (b *bgSupervisor) handle(env Envelope) {
	switch m := env.Payload.(type) {
	case bgRegisterMsg:
		b.onRegister(m)
	case bgAckMsg:
		b.onAck(m)
	case bgDropNoticesMsg:
		b.dropNoticesFor(m.SessionID)
	case bgFinishMsg:
		b.onFinish(m.JobID, m.Status, m.Result)
	case bgCancelMsg:
		m.Reply <- b.onCancel(m.JobID, m.By)
	case bgQueryMsg:
		m.Reply <- b.onQuery(m.JobID)
	case bgJobsOfMsg:
		var ids []string
		for _, j := range b.jobs {
			if j.Status != BgStatusRunning {
				continue
			}
			if m.SessionID != "" && j.SessionID != m.SessionID {
				continue
			}
			ids = append(ids, j.ID)
		}
		m.Reply <- ids
	case bgLogPathMsg:
		if j, ok := b.jobs[m.JobID]; ok && j.Status == BgStatusRunning {
			j.LogPath = m.LogPath
			b.writePidfile(j)
		}
	case bgSubscribeMsg:
		m.Reply <- b.onSubscribe(m.SessionID, m.Done)
	case bgUnsubscribeMsg:
		b.unsubscribe(m.ch)
	}
}

// ---- register / finish / cancel (all on the supervisor goroutine) ----

func (b *bgSupervisor) onRegister(m bgRegisterMsg) {
	jobCtx, cancel := context.WithCancel(context.Background())
	jobID := m.JobID
	if jobID == "" {
		jobID = "bg_" + randomID8()
	}
	j := &bgJob{
		ID:        jobID,
		Kind:      m.Kind,
		SessionID: m.SessionID,
		Label:     truncateBgLabel(m.Label),
		PID:       m.PID, Identity: tools.ProcessIdentity(m.PID),
		Runner:    m.JobID != "",
		Status:    BgStatusRunning,
		StartedAt: time.Now().UnixMilli(),
		LogPath:   m.LogPath, StderrPath: m.StderrPath, BrainLog: m.BrainLog,
		ctx:    jobCtx,
		cancel: cancel,
		stop:   m.Stop,
		done:   make(chan struct{}),
	}
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	if err := b.writePidfile(j); err != nil {
		if j.stop != nil { j.stop() }
		cancel()
		m.Reply <- bgRegisterResult{Error: err.Error()}
		return
	}
	b.jobs[j.ID] = j
	trace("bg.register", map[string]any{"job": j.ID, "sid": j.SessionID, "kind": j.Kind, "labelLen": len(j.Label)})
	m.Reply <- bgRegisterResult{JobID: j.ID, Done: j.done}
}

func (b *bgSupervisor) onFinish(jobID, status, result string) {
	j, ok := b.jobs[jobID]
	if !ok || j.Status != BgStatusRunning {
		return
	}
	if len(result) > bgResultCap {
		result = result[:bgResultCap] + "\n…[truncated]"
	}
	j.Status = status
	j.EndedAt = time.Now().UnixMilli()
	j.Result = result
	_ = os.Remove(b.pidPath(jobID))
	trace("bg.finish", map[string]any{"job": j.ID, "sid": j.SessionID, "status": status, "resultLen": len(result)})
	b.deliver(j, status == BgStatusDone || status == BgStatusError || status == BgStatusOrphaned)
	b.wakeSession(j.SessionID)
	trace("bg.wake", map[string]any{"job": j.ID, "sid": j.SessionID, "woke": 1})
	j.closeDone()
	// Logs are durable in the session BgTask (RAM + WAL) from here: the
	// runner files (state/disposition/launch/out/brain) are removed NOW,
	// not after 7 days. Best-effort: the session is the source of truth.
	b.cleanupRunnerFiles(j)
}

// cleanupRunnerFiles removes every per-job file once its output is durable
// in the session BgTask: state, disposition, launch claim, live out log,
// and the brain copy. Binaries are untouched (gcRunners owns them).
func (b *bgSupervisor) cleanupRunnerFiles(j *bgJob) {
	if j == nil || j.ID == "" {
		return
	}
	root := b.rootDir()
	_ = os.Remove(runner.StatePath(root, j.ID))
	_ = os.Remove(runner.DispositionPath(root, j.ID))
	_ = os.Remove(filepath.Join(runner.RunnersDir(root), j.ID+".launch"))
	if j.LogPath != "" {
		_ = os.Remove(j.LogPath)
	}
	if j.BrainLog != "" && j.BrainLog != j.LogPath {
		_ = os.Remove(j.BrainLog)
	}
	if j.StderrPath != "" && j.StderrPath != j.LogPath && j.StderrPath != j.BrainLog {
		_ = os.Remove(j.StderrPath)
	}
	trace("bg.files.cleaned", map[string]any{"job": j.ID, "sid": j.SessionID})
}

func (b *bgSupervisor) onCancel(jobID, by string) bool {
	j, ok := b.jobs[jobID]
	if !ok || j.Status != BgStatusRunning {
		return false
	}
	// Persist the delivery decision before stopping or dropping recovery
	// metadata. A failed write must not turn a silent cancel into a wake-up.
	if j.Runner {
		disp := runner.DispBackground
		if by == "assistant" {
			disp = runner.DispSuppressed
		}
		if err := runner.WriteDisposition(b.rootDir(), j.ID, disp); err != nil {
			trace("bg.cancel.persist_failed", map[string]any{"job": j.ID, "error": err.Error()})
			return false
		}
	}
	if j.stop != nil {
		j.stop()
	}
	if j.cancel != nil {
		j.cancel()
	}
	j.Status = BgStatusCancelled
	j.EndedAt = time.Now().UnixMilli()
	if by != "" {
		j.Result = fmt.Sprintf("Background task %s cancelled by %s.", j.Label, by)
		if j.LogPath != "" {
			j.Result += fmt.Sprintf("\nPartial output (if any) is in the .log at: %s", j.LogPath)
		}
		bgAppendLogLine(j.LogPath, fmt.Sprintf("\n[cancelled by %s]\n", by))
	}
	_ = os.Remove(b.pidPath(jobID))
	trace("bg.cancel", map[string]any{"job": j.ID, "sid": j.SessionID, "by": by})
	if by == "user" {
		b.deliver(j, false)
	}
	b.wakeSession(j.SessionID)
	trace("bg.wake", map[string]any{"job": j.ID, "sid": j.SessionID, "woke": 1})
	j.closeDone()
	// Same as finish: output is durable in the session BgTask.
	b.cleanupRunnerFiles(j)
	return true
}

// ---- sleep/wake (push, no polling) ----

type bgUnsubscribeMsg struct{ ch chan struct{} }

// Only the supervisor closes subscriptions. Jobs never own shared channels.
func (b *bgSupervisor) unsubscribe(ch chan struct{}) {
	if _, ok := b.subscribers[ch]; ok {
		delete(b.subscribers, ch)
		close(ch)
	}
}

func (b *bgSupervisor) wakeSession(sessionID string) {
	for ch, owner := range b.subscribers {
		if owner == sessionID {
			b.unsubscribe(ch)
		}
	}
}

func (b *bgSupervisor) onSubscribe(sessionID string, hostDone <-chan struct{}) any {
	ch := make(chan struct{})
	b.subscribers[ch] = sessionID
	if hostDone != nil {
		go func() {
			select {
			case <-hostDone:
				select {
				case b.inbox <- Envelope{Payload: bgUnsubscribeMsg{ch}}:
				case <-b.done:
				}
			case <-ch:
			case <-b.done:
			}
		}()
	}
	return ch
}

// subscribeFinish is the worker-facing API (turnBridge.WaitForAnyJob).
func (b *bgSupervisor) subscribeFinish(sessionID string, done <-chan struct{}) <-chan struct{} {
	if b == nil {
		c := make(chan struct{})
		return c
	}
	reply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgSubscribeMsg{SessionID: sessionID, Done: done, Reply: reply}}:
	case <-done:
		c := make(chan struct{})
		close(c)
		return c
	}
	select {
	case r := <-reply:
		if ch, ok := r.(chan struct{}); ok {
			return ch
		}
	case <-done:
	case <-time.After(replyTimeout):
	}
	c := make(chan struct{})
	return c
}

// bgJobsOfMsg asks the supervisor for the running job ids of one session
// (purge path).

type bgJobsOfMsg struct {
	SessionID string
	Reply     chan any
}

// bgQueryMsg asks the supervisor for one job's identity (cancel path).

type bgQueryMsg struct {
	JobID string
	Reply chan any
}

type bgQueryResult struct {
	Status  string
	Label   string
	Owner   string
	Running bool
	Found   bool
}

// ---- cancel API (turnBridge.CancelBackgroundJob + dashboard) ----

func (b *bgSupervisor) cancelJob(callerSessionID, jobID string) (tools.BgCancelOutcome, error) {
	if b == nil {
		return tools.BgCancelOutcome{}, fmt.Errorf("no background support")
	}
	reply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgQueryMsg{JobID: jobID, Reply: reply}}:
	case <-time.After(replyTimeout):
		return tools.BgCancelOutcome{}, fmt.Errorf("bg supervisor unreachable")
	}
	var status, label, owner string
	select {
	case r := <-reply:
		if q, ok := r.(bgQueryResult); ok && q.Found {
			status, label, owner = q.Status, q.Label, q.Owner
		}
	case <-time.After(replyTimeout):
		return tools.BgCancelOutcome{}, fmt.Errorf("bg supervisor unreachable")
	}
	if owner == "" || owner != callerSessionID {
		return tools.BgCancelOutcome{}, fmt.Errorf("bg_cancel: no background task %q in this session", jobID)
	}
	if status != BgStatusRunning {
		return tools.BgCancelOutcome{OK: false, Status: status, Notice: fmt.Sprintf("Background task %s already finished (status %s) — nothing to cancel.", label, status)}, nil
	}
	creply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgCancelMsg{JobID: jobID, By: "assistant", Reply: creply}}:
	case <-time.After(replyTimeout):
		return tools.BgCancelOutcome{}, fmt.Errorf("bg supervisor unreachable")
	}
	select {
	case r := <-creply:
		if ok, _ := r.(bool); !ok {
			return tools.BgCancelOutcome{OK: false, Status: status, Notice: fmt.Sprintf("Background task %s already finished — nothing to cancel.", label)}, nil
		}
	case <-time.After(replyTimeout):
		return tools.BgCancelOutcome{}, fmt.Errorf("bg supervisor unreachable")
	}
	return tools.BgCancelOutcome{OK: true, Status: BgStatusCancelled, Notice: fmt.Sprintf("Background task %s cancelled: the work is stopped and its result will NOT be delivered. Re-run it differently instead of waiting.", label)}, nil
}

// ---- delivery (completion/cancel notices to the owner session) ----

func (b *bgSupervisor) deliver(j *bgJob, finished bool) {
	trace("bg.deliver", map[string]any{"job": j.ID, "sid": j.SessionID, "finished": finished})
	var text string
	if finished {
		state := "finished"
		if j.Status == BgStatusError {
			state = "finished with an error"
		}
		if j.Status == BgStatusOrphaned {
			state = "ended after daemon restart; its exit status is unavailable"
		}
		var sb strings.Builder
		sb.WriteString("<system-reminder>\n")
		fmt.Fprintf(&sb, "Background task %s %s.\n", j.Label, state)
		// Logs live in the session BgTask: read them with bg_check
		// (job_id %s). The runner files are already cleaned.
		fmt.Fprintf(&sb, "Read the output with bg_check (job_id %s) — it pages by lines, tail by default.\n", j.ID)
		if j.StderrPath != "" {
			fmt.Fprintf(&sb, "Standard error is in: %s\n", j.StderrPath)
		}
		sb.WriteString("Continue your work based on what the log shows.</system-reminder>")
		text = sb.String()
	} else {
		var sb strings.Builder
		sb.WriteString("<system-reminder>\n")
		fmt.Fprintf(&sb, "Background task %s was cancelled by the user.\n", j.Label)
		fmt.Fprintf(&sb, "Partial output (if any) is in the session task — read it with bg_check (job_id %s).\n", j.ID)
		sb.WriteString("Do not wait for it — continue your work another way.</system-reminder>")
		text = sb.String()
	}
	// V2-003: delivery is tracked independently of job completion. The
	// notice is retained (and persisted) until the session acknowledges
	// folding it into its transcript; failed sends are retried by the
	// run() ticker. Keyed by job id: redelivery is idempotent.
	n := b.retainNotice(j.ID, j.SessionID, text, finished)
	b.tryNotice(n)
}

// ---- pending notice delivery (V2-003) ----

func (b *bgSupervisor) noticePath(jobID string) string {
	return filepath.Join(b.bgDir(), jobID+".notice.json")
}

// retainNotice records (idempotently) a notice awaiting delivery + ack.
func (b *bgSupervisor) retainNotice(jobID, sessionID, text string, finished bool) *pendingNotice {
	if n, ok := b.notices[jobID]; ok {
		return n
	}
	n := &pendingNotice{JobID: jobID, SessionID: sessionID, Text: text, Finished: finished}
	b.notices[jobID] = n
	if raw, err := json.Marshal(n); err == nil {
		_ = os.MkdirAll(b.bgDir(), 0o700)
		_ = os.WriteFile(b.noticePath(jobID), raw, 0o600)
	}
	return n
}

// tryNotice attempts one non-blocking delivery. The notice STAYS pending
// until the session acks it — a successful send is not the ack.
func (b *bgSupervisor) tryNotice(n *pendingNotice) {
	if b.session == nil {
		return
	}
	inbox, _, ok := b.session(n.SessionID)
	if !ok {
		return
	}
	n.Attempts++
	select {
	case inbox <- Envelope{SessionID: n.SessionID, Payload: bgNoticeMsg{JobID: n.JobID, Text: n.Text, Finished: n.Finished}}:
	default:
	}
}

// flushNotices retries every retained notice (non-blocking: one busy
// session can never stall the BG supervisor).
func (b *bgSupervisor) flushNotices() {
	for _, n := range b.notices {
		b.tryNotice(n)
	}
}

// onAck retires a notice the session has folded into its transcript.
func (b *bgSupervisor) onAck(m bgAckMsg) {
	if _, ok := b.notices[m.JobID]; !ok {
		return
	}
	delete(b.notices, m.JobID)
	_ = os.Remove(b.noticePath(m.JobID))
	trace("bg.notice.acked", map[string]any{"job": m.JobID})
}

// dropNoticesFor terminates pending delivery for a deleted session —
// deletion must never be undone by a late notice (no resurrection).
func (b *bgSupervisor) dropNoticesFor(sessionID string) {
	for id, n := range b.notices {
		if n.SessionID == sessionID {
			delete(b.notices, id)
			_ = os.Remove(b.noticePath(id))
		}
	}
}

// loadNotices recovers unacknowledged notices after a restart (V2-003:
// terminal metadata is retained on disk — never the already-deleted
// pidfile). The original process is NOT re-run.
func (b *bgSupervisor) loadNotices() {
	entries, err := os.ReadDir(b.bgDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".notice.json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(b.bgDir(), e.Name()))
		if err != nil {
			continue
		}
		var n pendingNotice
		if json.Unmarshal(raw, &n) != nil || n.JobID == "" {
			_ = os.Remove(filepath.Join(b.bgDir(), e.Name()))
			continue
		}
		if _, exists := b.notices[n.JobID]; !exists {
			notice := n
			b.notices[n.JobID] = &notice
		}
	}
}

// onQuery answers the cancel path with one job's identity.

func (b *bgSupervisor) onQuery(jobID string) bgQueryResult {
	if j, ok := b.jobs[jobID]; ok {
		return bgQueryResult{Status: j.Status, Label: j.Label, Owner: j.SessionID, Running: j.Status == BgStatusRunning, Found: true}
	}
	return bgQueryResult{}
}

func bgAppendLogLine(logPath, line string) {
	if logPath == "" || line == "" {
		return
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

func truncateBgLabel(s string) string {
	r := []rune(s)
	if len(r) <= bgLabelMax {
		return s
	}
	return string(r[:bgLabelMax]) + "…"
}
