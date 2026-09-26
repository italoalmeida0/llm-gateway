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

	lastFinish int64 // unix milli of terminal transition (freshness)
	finishName string
}

// noticePath is the readable log the completion notice points at: the
// brain copy when the runner produced one, else the live path (V2R-010).
func (j *bgJob) noticePath() string {
	if j.BrainLog != "" {
		return j.BrainLog
	}
	return j.LogPath
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

type bgListMsg struct {
	Reply chan any
}

type bgReadMsg struct {
	JobID string
	Max   int
	Reply chan any
}

type bgSubscribeMsg struct {
	SessionID string
	Done      <-chan struct{} // host done (turn end): unsubscribe
	Reply     chan any        // chan struct{} closed on first finish
}

type bgRecentMsg struct {
	SessionID string
	Reply     chan any
}

type bgRecentResult struct {
	Label string
	Age   time.Duration
	OK    bool
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
	case bgListMsg:
		m.Reply <- b.snapshot()
	case bgReadMsg:
		text, ok := bgReadTail(m.JobID, b, m.Max)
		m.Reply <- map[string]any{"text": text, "ok": ok}
	case bgLogPathMsg:
		if j, ok := b.jobs[m.JobID]; ok && j.Status == BgStatusRunning {
			j.LogPath = m.LogPath
			b.writePidfile(j)
		}
	case bgSubscribeMsg:
		m.Reply <- b.onSubscribe(m.SessionID, m.Done)
	case bgUnsubscribeMsg:
		b.unsubscribe(m.ch)
	case bgRecentMsg:
		m.Reply <- b.onRecent(m.SessionID)
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
	b.broadcast()
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
	j.lastFinish = j.EndedAt
	j.finishName = j.Label
	_ = os.Remove(b.pidPath(jobID))
	trace("bg.finish", map[string]any{"job": j.ID, "sid": j.SessionID, "status": status, "resultLen": len(result)})
	b.broadcast()
	b.deliver(j, status == BgStatusDone || status == BgStatusError || status == BgStatusOrphaned)
	b.wakeSession(j.SessionID)
	trace("bg.wake", map[string]any{"job": j.ID, "sid": j.SessionID, "woke": 1})
	j.closeDone()
}

func (b *bgSupervisor) onCancel(jobID, by string) bool {
	j, ok := b.jobs[jobID]
	if !ok || j.Status != BgStatusRunning {
		return false
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
	// V2R-001: record the durable disposition. An assistant cancel is
	// SILENT (its caller learns from the tool result); a user/dashboard
	// cancel notifies. Recovery must replay exactly this.
	if j.Runner {
		if by == "assistant" {
			_ = runner.WriteDisposition(b.rootDir(), j.ID, runner.DispSuppressed)
		} else {
			_ = runner.WriteDisposition(b.rootDir(), j.ID, runner.DispBackground)
		}
	}
	b.broadcast()
	if by == "user" {
		b.deliver(j, false)
	}
	j.lastFinish, j.finishName = j.EndedAt, j.Label
	b.wakeSession(j.SessionID)
	trace("bg.wake", map[string]any{"job": j.ID, "sid": j.SessionID, "woke": 1})
	j.closeDone()
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
	if _, _, ok := b.recentLocked(sessionID); ok {
		close(ch)
		return ch
	}
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

func (b *bgSupervisor) onRecent(sessionID string) bgRecentResult {
	label, age, ok := b.recentLocked(sessionID)
	return bgRecentResult{Label: label, Age: age, OK: ok}
}

func (b *bgSupervisor) recentLocked(sessionID string) (string, time.Duration, bool) {
	var bestLabel string
	var bestEnd int64
	for _, j := range b.jobs {
		if j.SessionID != sessionID {
			continue
		}
		if j.Status == BgStatusRunning {
			return "", 0, false // running jobs own the wait
		}
		if j.lastFinish > bestEnd {
			bestEnd = j.lastFinish
			bestLabel = j.finishName
		}
	}
	if bestEnd <= 0 {
		return "", 0, false
	}
	if age := time.Since(time.UnixMilli(bestEnd)); age <= 60*time.Second {
		return bestLabel, age, true
	}
	return "", 0, false
}

func (b *bgSupervisor) recentFinish(sessionID string) (string, time.Duration, bool) {
	if b == nil {
		return "", 0, false
	}
	reply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgRecentMsg{SessionID: sessionID, Reply: reply}}:
	case <-time.After(replyTimeout):
		return "", 0, false
	}
	select {
	case r := <-reply:
		if res, ok := r.(bgRecentResult); ok {
			return res.Label, res.Age, res.OK
		}
	case <-time.After(replyTimeout):
	}
	return "", 0, false
}

// ---- cancel API (turnBridge.CancelBackgroundJob + dashboard) ----

func (b *bgSupervisor) cancelJob(callerSessionID, jobID string) (tools.BgCancelOutcome, error) {
	if b == nil {
		return tools.BgCancelOutcome{}, fmt.Errorf("no background support")
	}
	reply := make(chan any, 1)
	select {
	case b.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}:
	case <-time.After(replyTimeout):
		return tools.BgCancelOutcome{}, fmt.Errorf("bg supervisor unreachable")
	}
	var status, label, owner string
	select {
	case r := <-reply:
		for _, p := range r.([]map[string]any) {
			if p["id"] == jobID {
				status, _ = p["status"].(string)
				label, _ = p["label"].(string)
				owner, _ = p["sessionId"].(string)
			}
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
		if p := j.noticePath(); p != "" {
			fmt.Fprintf(&sb, "The output is NOT included here — read the full log at: %s\n", p)
		}
		if j.StderrPath != "" {
			fmt.Fprintf(&sb, "Standard error is in: %s\n", j.StderrPath)
		}
		sb.WriteString("Continue your work based on what the log shows.</system-reminder>")
		text = sb.String()
	} else {
		var sb strings.Builder
		sb.WriteString("<system-reminder>\n")
		fmt.Fprintf(&sb, "Background task %s was cancelled by the user.\n", j.Label)
		if p := j.noticePath(); p != "" {
			fmt.Fprintf(&sb, "Partial output (if any) is in the .log at: %s\n", p)
		}
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

// ---- snapshot / broadcast / tail ----

func (b *bgSupervisor) snapshot() []map[string]any {
	out := make([]map[string]any, 0, len(b.jobs))
	for _, j := range b.jobs {
		out = append(out, map[string]any{
			"id": j.ID, "kind": j.Kind, "sessionId": j.SessionID,
			"label": j.Label, "status": j.Status,
			"startedAt": j.StartedAt, "endedAt": j.EndedAt,
			"result": j.Result, "logPath": j.LogPath, "stderrPath": j.StderrPath,
		})
	}
	return out
}

func (b *bgSupervisor) broadcast() {
	if b.emit == nil {
		return
	}
	host := ""
	if b.hostID != nil {
		host = b.hostID()
	}
	b.emit(map[string]any{"type": "bg_update", "hostId": host, "jobs": b.snapshot()})
}

func bgReadTail(jobID string, b *bgSupervisor, max int) (string, bool) {
	if max <= 0 || max > 256*1024 {
		max = 64 * 1024
	}
	j, ok := b.jobs[jobID]
	if !ok || j.LogPath == "" {
		return "", false
	}
	return bgReadTailPath(j.LogPath, max)
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
