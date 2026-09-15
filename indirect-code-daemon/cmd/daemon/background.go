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
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Background task kinds. Bash and python detach here when they outlive
// tools.AutoBackgroundAfter (10s).
const (
	BgKindBash   = "bash"
	BgKindPython = "python"
)

// Background job statuses surfaced in the background-tasks card.
const (
	BgStatusRunning   = "running"
	BgStatusDone      = "done"
	BgStatusError     = "error"
	BgStatusCancelled = "cancelled"
)

// bgResultCap bounds the text kept on the finished job for the bg_list
// snapshot (the .log file keeps the full output; the snapshot does not).
const bgResultCap = 50 * 1024

// bgStreamCap bounds one live output chunk broadcast to the frontend.
const bgStreamCap = 16 * 1024

// bgTailCap bounds the .log tail served to a (re)connecting client.
const bgTailCap = 64 * 1024

// BgJob is one background task: a detached bash/python process.
// Process-local only (never persisted): a daemon restart drops running
// jobs; the .log files survive on disk and can still be read.
type BgJob struct {
	ID        string
	Kind      string
	SessionID string // owner session
	Label     string
	Status    string
	StartedAt int64
	EndedAt   int64
	Result    string
	// LogPath is the absolute path of the job's .log file in the owner
	// session's brain scratch space. The tool streams output into it; the
	// file is never deleted, so it survives the delivery as the task's
	// record.
	LogPath string
	ctx     context.Context
	cancel  context.CancelFunc
	stop    func() // force-stop for the detached process; nil = nothing to kill
	done    chan struct{}
	doneOnce sync.Once
}

func (j *BgJob) closeDone() {
	j.doneOnce.Do(func() { close(j.done) })
}

func (d *DaemonServer) bgJobPayload(j *BgJob) map[string]any {
	return map[string]any{
		"id": j.ID, "kind": j.Kind, "sessionId": j.SessionID,
		"label": j.Label,
		"status": j.Status, "startedAt": j.StartedAt, "endedAt": j.EndedAt,
		"result": j.Result, "logPath": j.LogPath,
	}
}

func (d *DaemonServer) bgSnapshot() []map[string]any {
	d.bgMu.Lock()
	jobs := make([]*BgJob, 0, len(d.bgJobs))
	for _, j := range d.bgJobs {
		jobs = append(jobs, j)
	}
	d.bgMu.Unlock()
	out := make([]map[string]any, 0, len(jobs))
	for _, j := range jobs {
		d.bgMu.Lock()
		p := d.bgJobPayload(j)
		d.bgMu.Unlock()
		out = append(out, p)
	}
	return out
}

func (d *DaemonServer) broadcastBgJobs() {
	_ = d.sendWS(map[string]any{
		"type": "bg_update", "hostId": d.config.HostID, "jobs": d.bgSnapshot(),
	})
}

// broadcastBgOutput forwards one live output chunk of a running job to the
// frontend row (and any other client). Chunks are ephemeral: clients that
// (re)connect mid-run fetch the .log tail via bg_tail instead.
func (d *DaemonServer) broadcastBgOutput(jobID, sessionID, chunk string) {
	if chunk == "" {
		return
	}
	if len(chunk) > bgStreamCap {
		chunk = chunk[len(chunk)-bgStreamCap:]
	}
	_ = d.sendWS(map[string]any{
		"type": "bg_output", "hostId": d.config.HostID,
		"jobId": jobID, "sessionId": sessionID, "text": chunk,
	})
}

// WaitForAnyJob implements tools.SleepHost: a channel that closes when
// any job owned by sessionID leaves the running state (done, error or
// cancelled) — the sleep tool's early wake-up. hostDone closes the
// channel too (turn ending must not park the tool forever). A session
// with no running jobs right now still wakes later: the watcher polls
// the registry lightly until a job appears or the host is done. The
// watcher also exits when the returned channel is abandoned (the sleep
// tool finishing its full duration): the sleep tool cancels hostDone on
// return, so no goroutine leaks per sleep call.
func (d *DaemonServer) WaitForAnyJob(sessionID string, hostDone <-chan struct{}) <-chan struct{} {
	wake := make(chan struct{})
	var fire sync.Once
	wakeNow := func() { fire.Do(func() { close(wake) }) }

	go func() {
		tick := time.NewTicker(500 * time.Millisecond)
		defer tick.Stop()
		for {
			// Snapshot the done channels of every running job of this
			// session and wait on them; new jobs are picked up on the
			// next tick (a missed wake only delays it 500ms — the
			// delivery broadcast arrives on its own anyway).
			d.bgMu.Lock()
			var dones []<-chan struct{}
			for _, j := range d.bgJobs {
				if j.SessionID == sessionID && j.Status == BgStatusRunning {
					dones = append(dones, j.done)
				}
			}
			d.bgMu.Unlock()

			if len(dones) > 0 {
				select {
				case <-hostDone:
					wakeNow()
					return
				case <-dones[0]:
					wakeNow()
					return
				case <-tick.C:
					// Re-snapshot: parallel jobs may have appeared.
				}
			} else {
				select {
				case <-hostDone:
					wakeNow()
					return
				case <-tick.C:
				}
			}
		}
	}()
	return wake
}

func (d *DaemonServer) bgGet(id string) *BgJob {
	d.bgMu.Lock()
	defer d.bgMu.Unlock()
	return d.bgJobs[id]
}

// bgRegister creates a running job owned by sessionID. The job owns a
// cancellation context (j.ctx/j.cancel): cancelling stops the underlying
// work. stop, when non-nil, is the tool's own force-stop for a detached
// process — bgCancelJob calls it before marking the job cancelled. done
// closes when the terminal state is recorded (finish or cancel, whichever
// wins).
func (d *DaemonServer) bgRegister(kind, sessionID, label string, stop ...func()) *BgJob {
	jobCtx, cancel := context.WithCancel(context.Background())
	j := &BgJob{
		ID:        fmt.Sprintf("bg_%d", time.Now().UnixNano()/1000),
		Kind:      kind,
		SessionID: sessionID,
		Label:     truncateBgLabel(label),
		Status:    BgStatusRunning,
		StartedAt: time.Now().UnixMilli(),
		ctx:       jobCtx,
		cancel:    cancel,
		done:      make(chan struct{}),
	}
	if len(stop) > 0 {
		j.stop = stop[0]
	}
	d.bgMu.Lock()
	if d.bgJobs == nil {
		d.bgJobs = map[string]*BgJob{}
	}
	d.bgJobs[j.ID] = j
	d.bgMu.Unlock()
	d.broadcastBgJobs()
	return j
}

// bgFinish records the terminal state and kicks delivery to the owner.
// Only the first terminal transition wins: a concurrent cancel beats a
// late finish (cancelled jobs never deliver) and vice versa.
func (d *DaemonServer) bgFinish(j *BgJob, status, result string) {
	if len(result) > bgResultCap {
		result = result[:bgResultCap] + "\n…[truncated]"
	}
	d.bgMu.Lock()
	if j.Status != BgStatusRunning {
		d.bgMu.Unlock()
		return
	}
	j.Status = status
	j.EndedAt = time.Now().UnixMilli()
	j.Result = result
	d.bgMu.Unlock()
	d.broadcastBgJobs()
	if status == BgStatusDone || status == BgStatusError {
		d.deliverBgResult(j)
	}
	j.closeDone()
}

// cancelBackgroundJobs stops every running job owned by sessionID (used by
// purge). Cancelled jobs never deliver results and never wake the parent.
func (d *DaemonServer) cancelBackgroundJobs(sessionID string) {
	d.bgMu.Lock()
	var targets []*BgJob
	for _, j := range d.bgJobs {
		if j.Status == BgStatusRunning && j.SessionID == sessionID {
			targets = append(targets, j)
		}
	}
	d.bgMu.Unlock()
	for _, j := range targets {
		d.bgCancelJob(j.ID, "")
	}
}

// bgCancelJob forces a stop: the process is killed, the job is marked
// cancelled and no completion notice is delivered. by names who stopped
// it ("user" dashboard stop, "assistant" bg_cancel tool, "" silent e.g.
// purge): a named stop records a terminal Result marker (so the folded
// row reads truthfully instead of the stale "still running" placeholder)
// and a [cancelled by …] line in the .log.
func (d *DaemonServer) bgCancelJob(id, by string) bool {
	j := d.bgGet(id)
	if j == nil {
		return false
	}
	d.bgMu.Lock()
	if j.Status != BgStatusRunning {
		d.bgMu.Unlock()
		return false
	}
	d.bgMu.Unlock()
	if j.stop != nil {
		j.stop()
	}
	if j.cancel != nil {
		j.cancel()
	}
	d.bgMu.Lock()
	stopped := false
	if j.Status == BgStatusRunning {
		j.Status = BgStatusCancelled
		j.EndedAt = time.Now().UnixMilli()
		stopped = true
	}
	label, logPath := d.bgJobLabel(j), j.LogPath
	if stopped && by != "" {
		j.Result = fmt.Sprintf("Background task %s cancelled by %s.", label, by)
		if logPath != "" {
			j.Result += fmt.Sprintf("\nPartial output (if any) is in the .log at: %s", logPath)
		}
	}
	d.bgMu.Unlock()
	if stopped && by != "" {
		d.bgAppendLogLine(logPath, fmt.Sprintf("\n[cancelled by %s]\n", by))
	}
	d.broadcastBgJobs()
	j.closeDone()
	return true
}

// bgAppendLogLine best-effort appends one marker line to a job's .log.
func (d *DaemonServer) bgAppendLogLine(logPath, line string) {
	if logPath == "" || line == "" {
		return
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

// CancelBackgroundJob implements tools.BgCancelHost: the model's bg_cancel
// can only stop jobs owned by its own session. Already-finished jobs report
// their current status instead of failing — cancelling a done job is a
// no-op, not an error. Notices carry the human label (command summary),
// never the raw bg_ id.
func (d *DaemonServer) CancelBackgroundJob(callerSessionID, jobID string) (tools.BgCancelOutcome, error) {
	j := d.bgGet(jobID)
	if j == nil || j.SessionID != callerSessionID {
		return tools.BgCancelOutcome{}, fmt.Errorf("bg_cancel: no background task %q in this session", jobID)
	}
	d.bgMu.Lock()
	status, label := j.Status, d.bgJobLabel(j)
	d.bgMu.Unlock()
	if status != BgStatusRunning {
		return tools.BgCancelOutcome{OK: false, Status: status, Notice: fmt.Sprintf("Background task %s already finished (status %s) — nothing to cancel.", label, status)},
			nil
	}
	// The caller is the model itself: it learns from this tool result, so
	// no cancellation notice is delivered — but the stop is still
	// attributed in the .log and the folded row ("assistant").
	if !d.bgCancelJob(jobID, "assistant") {
		// Lost a race with a concurrent finish; report the terminal state.
		d.bgMu.Lock()
		status = j.Status
		d.bgMu.Unlock()
		return tools.BgCancelOutcome{OK: false, Status: status, Notice: fmt.Sprintf("Background task %s already finished (status %s) — nothing to cancel.", label, status)},
			nil
	}
	return tools.BgCancelOutcome{OK: true, Status: BgStatusCancelled, Notice: fmt.Sprintf("Background task %s cancelled: the work is stopped and its result will NOT be delivered. Re-run it differently instead of waiting.", label)}, nil
}

// bgLabelMax is the job label length: the first 300 characters of the
// bash command (or the python code / script invocation). The frontend
// strips newlines, highlights it like the Ran command label and lets CSS
// add the visual … at the card edge.
const bgLabelMax = 300

// truncateBgLabel keeps the first bgLabelMax characters (+ … when cut).
func truncateBgLabel(s string) string {
	r := []rune(s)
	if len(r) <= bgLabelMax {
		return s
	}
	return string(r[:bgLabelMax]) + "…"
}

// bgJobLabel renders the model-facing name of a job: the stored label —
// never the raw bg_… id.
func (d *DaemonServer) bgJobLabel(j *BgJob) string {
	return j.Label
}

func (d *DaemonServer) handleBgList() {
	_ = d.sendWS(map[string]any{
		"type": "bg_list", "hostId": d.config.HostID, "jobs": d.bgSnapshot(),
	})
}

func (d *DaemonServer) handleBgCancel(raw []byte) {
	var req struct {
		JobID string `json:"jobId"`
	}
	_ = json.Unmarshal(raw, &req)
	if req.JobID == "" {
		return
	}
	// Manual (dashboard) stop: unlike the model's bg_cancel tool — whose
	// caller learns from the tool result — nothing else tells the AI, so
	// a cancellation notice is delivered on top of the .log attribution.
	if !d.bgCancelJob(req.JobID, "user") {
		return
	}
	if j := d.bgGet(req.JobID); j != nil {
		d.deliverBgCancel(j)
	}
}

// handleBgTail serves the tail of a job's .log file to a (re)connecting
// client that missed the live bg_output stream.
func (d *DaemonServer) handleBgTail(raw []byte) {
	var req struct {
		JobID string `json:"jobId"`
	}
	_ = json.Unmarshal(raw, &req)
	if req.JobID == "" {
		return
	}
	j := d.bgGet(req.JobID)
	if j == nil {
		return
	}
	d.bgMu.Lock()
	logPath := j.LogPath
	d.bgMu.Unlock()
	text, truncated := bgReadTail(logPath, bgTailCap)
	_ = d.sendWS(map[string]any{
		"type": "bg_tail", "hostId": d.config.HostID,
		"jobId": req.JobID, "text": text, "truncated": truncated,
	})
}

// bgReadTail returns up to the last max bytes of path ("" when unreadable).
func bgReadTail(path string, max int) (string, bool) {
	if path == "" || max <= 0 {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	if len(data) <= max {
		return string(data), false
	}
	return string(data[len(data)-max:]), true
}

// bgCompletionNotice is the system-reminder delivered to the owner session
// when a background job finishes. It deliberately carries NO result text —
// only the .log path — so the model reads the output itself instead of
// paying the full result in context twice (once here, once on read).
func (d *DaemonServer) bgCompletionNotice(j *BgJob) string {
	state := "finished"
	d.bgMu.Lock()
	status, label, logPath := j.Status, d.bgJobLabel(j), j.LogPath
	d.bgMu.Unlock()
	if status == BgStatusError {
		state = "finished with an error"
	}
	var sb strings.Builder
	sb.WriteString("<system-reminder>\n")
	fmt.Fprintf(&sb, "Background task %s %s.\n", label, state)
	if logPath != "" {
		fmt.Fprintf(&sb, "The output is NOT included here — read the full log at: %s\n", logPath)
	}
	sb.WriteString("Continue your work based on what the log shows.</system-reminder>")
	return sb.String()
}

// bgCancelledNotice is the system-reminder delivered to the owner session
// when a background job is stopped from the dashboard. Like the
// completion notice it carries no result text — only the .log path.
func (d *DaemonServer) bgCancelledNotice(j *BgJob) string {
	d.bgMu.Lock()
	label, logPath := d.bgJobLabel(j), j.LogPath
	d.bgMu.Unlock()
	var sb strings.Builder
	sb.WriteString("<system-reminder>\n")
	fmt.Fprintf(&sb, "Background task %s was cancelled by the user.\n", label)
	if logPath != "" {
		fmt.Fprintf(&sb, "Partial output (if any) is in the .log at: %s\n", logPath)
	}
	sb.WriteString("Do not wait for it — continue your work another way.</system-reminder>")
	return sb.String()
}

// routeBgNotice delivers one background notice to the owner session:
// late-result into the live turn when one is running, otherwise a
// wake-up turn. progressVerb completes the live-path event text.
func (d *DaemonServer) routeBgNotice(j *BgJob, text, progressVerb string) {
	d.sessionsMu.RLock()
	act := d.sessions[j.SessionID]
	d.sessionsMu.RUnlock()
	if act == nil {
		return
	}
	act.mu.Lock()
	running := act.record.Status == "running" && act.agent != nil
	// Snapshot the agent under the lock, then inject WITHOUT act.mu: the
	// quiet append + OnContextAppended hook take their own locks (calling
	// anything that re-acquires act.mu from under it would self-deadlock
	// the session).
	var agent *core.Agent
	if running {
		agent = act.agent
	}
	act.mu.Unlock()
	if running {
		// Late-result into the live turn. Wire shape stays role:user
		// (providers reject orphan role:tool without a matching call),
		// but the <system-reminder> envelope marks it as a background
		// delivery — never a common user message. The frontend filters
		// it from the rendered transcript.
		agent.AppendUserContextQuiet(text, map[string]string{
			"background_delivery": j.ID, "background_kind": j.Kind,
		})
		_ = d.sendWS(map[string]any{"type": "agent_event", "hostId": d.config.HostID, "sessionId": j.SessionID,
			"event": map[string]any{"type": "tool_progress", "text": fmt.Sprintf("Background %s %s %s delivered to the running turn.", j.Kind, j.ID, progressVerb)}})
		return
	}
	go d.startBgWakeUpJob(j.SessionID, text, j)
}

// deliverBgResult routes a finished job's completion notice to its owner
// session: late-result into the live turn when one is running, otherwise
// a wake-up turn.
func (d *DaemonServer) deliverBgResult(j *BgJob) {
	d.routeBgNotice(j, d.bgCompletionNotice(j), "finished — completion notice")
}

// deliverBgCancel routes a dashboard-cancelled job's cancellation notice
// to its owner session (same channel as completions, so sleepers wake
// and the turn learns the task is gone instead of waiting it out).
func (d *DaemonServer) deliverBgCancel(j *BgJob) {
	d.routeBgNotice(j, d.bgCancelledNotice(j), "cancelled — cancellation notice")
}

// orphanBgTask is a detached placeholder in the transcript whose job is
// gone from the registry with no delivery behind it — the previous
// process died holding it. The registry is memory-only, so after a
// restart every placeholder is suspect until proven informed.
type orphanBgTask struct {
	id, kind, label, logPath string
}

// bgDetailsMap normalizes tool details to a plain map. In-memory blocks
// carry map[string]any, but a disk round-trip changes the shape:
// HydrateMessageObject keeps Details as json.RawMessage (raw JSON), so a
// scan that only accepts the map form silently finds nothing on every
// real restart — exactly the path this reconciliation exists for.
func bgDetailsMap(details any) map[string]any {
	switch d := details.(type) {
	case map[string]any:
		return d
	case json.RawMessage:
		var m map[string]any
		if json.Unmarshal(d, &m) == nil {
			return m
		}
	case []byte:
		var m map[string]any
		if json.Unmarshal(d, &m) == nil {
			return m
		}
	}
	return nil
}

// bgDetailString reads one string field from persisted tool details.
func bgDetailString(details any, key string) string {
	if s, ok := bgDetailsMap(details)[key].(string); ok {
		return s
	}
	return ""
}

// bgCallLabel rebuilds the human label for a detached call from its
// persisted arguments, mirroring the registry label shape.
func bgCallLabel(call provider.ToolCallBlock) string {
	var args map[string]any
	_ = json.Unmarshal(call.Arguments, &args)
	switch call.Name {
	case BgKindPython:
		if s, _ := args["script"].(string); s != "" {
			return truncateBgLabel(s)
		}
		if code, _ := args["code"].(string); code != "" {
			for _, l := range strings.Split(code, "\n") {
				if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
					return truncateBgLabel(t)
				}
			}
		}
		return "snippet"
	default:
		if cmd, _ := args["command"].(string); strings.Join(strings.Fields(cmd), " ") != "" {
			return truncateBgLabel(strings.Join(strings.Fields(cmd), " "))
		}
		if call.Name != "" {
			return call.Name
		}
		return "command"
	}
}

// findRestartOrphans scans history for detached placeholders (tool results
// carrying background_job_id) with no live registry entry and no delivery
// behind them. A job counts as informed when a notice stamped its
// background_delivery meta, or when a bg_cancel result closed it (its
// details carry cancelled:true — the model learned from that tool call,
// no restart notice needed). Job ids are unique per detach, so each
// orphan reports exactly once.
func findRestartOrphans(hist []provider.Message, live map[string]bool) []orphanBgTask {
	informed := map[string]bool{}
	for _, m := range hist {
		if m.Meta != nil {
			if id := m.Meta["background_delivery"]; id != "" {
				informed[id] = true
			}
		}
	}
	calls := map[string]provider.ToolCallBlock{}
	for _, m := range hist {
		for _, c := range m.Content {
			if tc, ok := c.(provider.ToolCallBlock); ok {
				calls[tc.ID] = tc
			}
		}
	}
	var out []orphanBgTask
	seen := map[string]bool{}
	for _, m := range hist {
		for _, c := range m.Content {
			tr, ok := c.(provider.ToolResultBlock)
			if !ok {
				continue
			}
			id := bgDetailString(tr.Details, "background_job_id")
			if id == "" || live[id] || informed[id] || seen[id] {
				continue
			}
			if cancelled, _ := bgDetailsMap(tr.Details)["cancelled"].(bool); cancelled {
				informed[id] = true
				continue
			}
			seen[id] = true
			call := calls[tr.CallID]
			kind := call.Name
			if kind != BgKindBash && kind != BgKindPython {
				kind = BgKindBash
			}
			out = append(out, orphanBgTask{
				id: id, kind: kind,
				label:   bgCallLabel(call),
				logPath: bgDetailString(tr.Details, "log_path"),
			})
		}
	}
	return out
}

// bgRestartNotice is the system-reminder injected into a resumed turn for
// each task orphaned by the previous process. Like completion notices it
// carries no result text — only the .log path.
func bgRestartNotice(o orphanBgTask) string {
	var sb strings.Builder
	sb.WriteString("<system-reminder>\n")
	fmt.Fprintf(&sb, "Background task %s was lost in the daemon restart.\n", o.label)
	sb.WriteString("It will NOT report back — do NOT wait for it.\n")
	if o.logPath != "" {
		fmt.Fprintf(&sb, "Partial output (if any) is in the .log at: %s\n", o.logPath)
	}
	sb.WriteString("Read the log and re-run the command if you still need a fresh result.</system-reminder>")
	return sb.String()
}

// injectRestartNotices informs a resumed turn about detached tasks the
// previous process dropped (see findRestartOrphans). Each orphan reports
// exactly once: the notice stamps background_delivery, so a later scan —
// including after another crash — skips it. Must run AFTER the
// Prompt-vs-Continue decision: the injected message carries the turn index
// and would otherwise flip an empty history into Continue, swallowing the
// opening prompt.
func (r *turnRun) injectRestartNotices() {
	d := r.d
	d.bgMu.Lock()
	live := make(map[string]bool, len(d.bgJobs))
	for id := range d.bgJobs {
		live[id] = true
	}
	d.bgMu.Unlock()
	for _, o := range findRestartOrphans(r.agent.History(), live) {
		r.agent.AppendUserContextQuiet(bgRestartNotice(o), map[string]string{
			"background_delivery": o.id, "background_kind": o.kind,
		})
	}
}

// startBgWakeUpJob opens a new turn on an idle session carrying a finished
// background job's completion notice. At most one wake-up turn runs per
// session: a fresh turn that won the race absorbs the notice instead.
func (d *DaemonServer) startBgWakeUpJob(sessionID, text string, j *BgJob) {
	act, err := d.getOrCreateActiveSession(sessionID)
	if err != nil {
		return
	}
	act.mu.Lock()
	if act.record.Status == "running" {
		// Lost the race with a fresh turn: fold into it as late-result.
		// Snapshot the agent under the lock, then inject WITHOUT act.mu.
		agent := act.agent
		act.mu.Unlock()
		if agent != nil {
			agent.AppendUserContextQuiet(text, map[string]string{
				"background_delivery": j.ID, "background_kind": j.Kind,
			})
		}
		return
	}
	act.mu.Unlock()
	if d.runTurnHook != nil {
		d.runTurnHook(act, text)
		return
	}
	d.runAgentTurnWithMeta(act, text, "", false, nil, map[string]string{
		"background_delivery": j.ID, "background_kind": j.Kind,
	})
}

// slowHook returns the tools.SlowHook wiring bash/python detach into jobs
// owned by sessionID. The tool's force-stop rides along so bg_cancel can
// kill the detached process. Each job gets a .log file in the session's
// brain scratch space: the hook returns its absolute path, the tool
// streams stdout+stderr into it (append mode) and the placeholder tells
// the model the path. The log is never deleted — it survives the delivery
// as the task's durable record.
func (d *DaemonServer) slowHook(sessionID string) tools.SlowHook {
	return func(kind, label string, stop func()) (string, string, func(string), func(string, bool)) {
		j := d.bgRegister(kind, sessionID, label, stop)
		logPath := d.bgLogFile(sessionID, j.ID)
		d.bgMu.Lock()
		j.LogPath = logPath
		d.bgMu.Unlock()
		d.broadcastBgJobs()
		stream := func(chunk string) {
			d.broadcastBgOutput(j.ID, j.SessionID, chunk)
		}
		var once sync.Once
		return j.ID, logPath, stream, func(result string, isError bool) {
			once.Do(func() {
				if isError {
					d.bgFinish(j, BgStatusError, result)
				} else {
					d.bgFinish(j, BgStatusDone, result)
				}
			})
		}
	}
}

// bgLogFile returns the absolute path of the job's .log file in the
// session's brain scratch space. Empty brain dir (talk mode, unusable
// session id) yields "" — the tool then falls back to its in-memory
// accumulator only. The file is created lazily by the tool on first write.
func (d *DaemonServer) bgLogFile(sessionID, jobID string) string {
	brain := d.ensureBrainDir(sessionID)
	if brain == "" {
		return ""
	}
	return filepath.Join(brain, jobID+".log")
}

// BgJobView is the frontend-facing snapshot of one background job.
type BgJobView struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Label     string `json:"label"`
	Status    string `json:"status"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt"`
	LogPath   string `json:"logPath,omitempty"`
	Result    string `json:"result,omitempty"`
}

func (d *DaemonServer) bgJobViews(callerSessionID string) []BgJobView {
	d.bgMu.Lock()
	defer d.bgMu.Unlock()
	out := make([]BgJobView, 0, len(d.bgJobs))
	for _, j := range d.bgJobs {
		if j.SessionID != callerSessionID {
			continue
		}
		out = append(out, BgJobView{
			ID: j.ID, Kind: j.Kind, Label: d.bgJobLabel(j), Status: j.Status,
			StartedAt: j.StartedAt, EndedAt: j.EndedAt,
			LogPath: j.LogPath, Result: j.Result,
		})
	}
	return out
}

var _ = json.Marshal
