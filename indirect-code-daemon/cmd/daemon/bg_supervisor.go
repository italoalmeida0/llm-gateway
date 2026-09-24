package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
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
	ID        string
	Kind      string
	SessionID string
	Label     string
	PID       int
	Status    string
	StartedAt int64
	EndedAt   int64
	Result    string
	LogPath   string

	ctx    context.Context
	cancel context.CancelFunc
	stop   func()

	done     chan struct{}
	doneOnce sync.Once

	// sleepers are closed when the job leaves running (push wake-up, plan §4).
	sleepers   map[chan struct{}]struct{}
	lastFinish int64 // unix milli of terminal transition (freshness)
	finishName string
}

func (j *bgJob) closeDone() {
	j.doneOnce.Do(func() { close(j.done) })
}

// bgPidfile is written per job so a supervisor (re)start can re-adopt live
// processes (plan §5.3). Jobs are NEVER re-run: re-adoption only.
type bgPidfile struct {
	JobID     string `json:"jobId"`
	PID       int    `json:"pid"`
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	LogPath   string `json:"logPath"`
	StartedAt int64  `json:"startedAt"`
}

// ---- supervisor messages ----

type bgRegisterMsg struct {
	Kind      string
	SessionID string
	Label     string
	LogPath   string
	PID       int
	Stop      func()
	Reply     chan any
}

type bgRegisterResult struct {
	JobID string
	Done  <-chan struct{}
}

type bgFinishMsg struct {
	JobID  string
	Status string // done | error
	Result string
}

type bgCancelMsg struct {
	JobID  string
	By     string // "user" | "assistant" | "" silent
	Reply  chan any
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

	jobs map[string]*bgJob
}

func newBGSupervisor(dataDir string) *bgSupervisor {
	return &bgSupervisor{
		dataDir: dataDir,
		inbox:   make(chan Envelope, inboxCap),
		control: make(chan any, controlCap),
		jobs:    map[string]*bgJob{},
	}
}

func (b *bgSupervisor) bgDir() string { return filepath.Join(b.dataDir, "bg") }

func (b *bgSupervisor) pidPath(jobID string) string {
	return filepath.Join(b.bgDir(), jobID+".pid.json")
}

func (b *bgSupervisor) run(wg *sync.WaitGroup) {
	defer wg.Done()
	b.readopt()
	for {
		select {
		case env := <-b.inbox:
			b.handle(env)
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
	case bgRecentMsg:
		m.Reply <- b.onRecent(m.SessionID)
	}
}

// ---- register / finish / cancel (all on the supervisor goroutine) ----

func (b *bgSupervisor) onRegister(m bgRegisterMsg) {
	jobCtx, cancel := context.WithCancel(context.Background())
	j := &bgJob{
		ID:        fmt.Sprintf("bg_%d", time.Now().UnixNano()/1000),
		Kind:      m.Kind,
		SessionID: m.SessionID,
		Label:     truncateBgLabel(m.Label),
		PID:       m.PID,
		Status:    BgStatusRunning,
		StartedAt: time.Now().UnixMilli(),
		LogPath:   m.LogPath,
		ctx:       jobCtx,
		cancel:    cancel,
		stop:      m.Stop,
		done:      make(chan struct{}),
		sleepers:  map[chan struct{}]struct{}{},
	}
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	b.jobs[j.ID] = j
	b.writePidfile(j)
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
	for ch := range j.sleepers {
		close(ch)
		delete(j.sleepers, ch)
	}
	// Wake sleepers of the whole session (push, plan §4).
	woke := 0
	for _, other := range b.jobs {
		if other.SessionID == j.SessionID {
			for ch := range other.sleepers {
				close(ch)
				delete(other.sleepers, ch)
				woke++
			}
		}
	}
	trace("bg.wake", map[string]any{"job": j.ID, "sid": j.SessionID, "woke": woke})
	_ = os.Remove(b.pidPath(jobID))
	trace("bg.finish", map[string]any{"job": j.ID, "sid": j.SessionID, "status": status, "resultLen": len(result)})
	b.broadcast()
	b.deliver(j, status == BgStatusDone || status == BgStatusError)
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
	for ch := range j.sleepers {
		close(ch)
		delete(j.sleepers, ch)
	}
	for _, other := range b.jobs {
		if other.SessionID == j.SessionID {
			for ch := range other.sleepers {
				close(ch)
				delete(other.sleepers, ch)
			}
		}
	}
	_ = os.Remove(b.pidPath(jobID))
	trace("bg.cancel", map[string]any{"job": j.ID, "sid": j.SessionID, "by": by})
	b.broadcast()
	if by == "user" {
		b.deliver(j, false)
	}
	j.closeDone()
	return true
}

// ---- sleep/wake (plan §4: push, no polling) ----

func (b *bgSupervisor) onSubscribe(sessionID string, hostDone <-chan struct{}) any {
	ch := make(chan struct{})
	var fire sync.Once
	wake := func() { fire.Do(func() { close(ch) }) }
	// Freshness: a job that finished just before sleep started still wakes it.
	if _, _, ok := b.recentLocked(sessionID); ok {
		wake()
		return ch
	}
	for _, j := range b.jobs {
		if j.SessionID == sessionID && j.Status == BgStatusRunning {
			if j.sleepers == nil {
				j.sleepers = map[chan struct{}]struct{}{}
			}
			j.sleepers[ch] = struct{}{}
		}
	}
	if hostDone != nil {
		go func() {
			select {
			case <-hostDone:
				wake()
			case <-ch:
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
	if b.session == nil {
		return
	}
	inbox, _, ok := b.session(j.SessionID)
	if !ok {
		return
	}
	var text string
	if finished {
		state := "finished"
		if j.Status == BgStatusError {
			state = "finished with an error"
		}
		var sb strings.Builder
		sb.WriteString("<system-reminder>\n")
		fmt.Fprintf(&sb, "Background task %s %s.\n", j.Label, state)
		if j.LogPath != "" {
			fmt.Fprintf(&sb, "The output is NOT included here — read the full log at: %s\n", j.LogPath)
		}
		sb.WriteString("Continue your work based on what the log shows.</system-reminder>")
		text = sb.String()
	} else {
		var sb strings.Builder
		sb.WriteString("<system-reminder>\n")
		fmt.Fprintf(&sb, "Background task %s was cancelled by the user.\n", j.Label)
		if j.LogPath != "" {
			fmt.Fprintf(&sb, "Partial output (if any) is in the .log at: %s\n", j.LogPath)
		}
		sb.WriteString("Do not wait for it — continue your work another way.</system-reminder>")
		text = sb.String()
	}
	select {
	case inbox <- Envelope{SessionID: j.SessionID, Payload: bgNoticeMsg{JobID: j.ID, Text: text, Finished: finished}}:
	default:
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
			"result": j.Result, "logPath": j.LogPath,
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
	data, err := os.ReadFile(j.LogPath)
	if err != nil {
		return "", false
	}
	if len(data) > max {
		data = data[len(data)-max:]
	}
	return string(data), true
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
