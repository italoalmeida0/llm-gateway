package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Runner adoption, orphan policy and GC (docs/runner-plan.md F5/F5b/F6/F8).
//
// The state files under runners/ are the contract: at boot (and hourly)
// the daemon reconciles them. Live runners are adopted (their out logs
// resume streaming through the existing tail machinery), finished ones
// feed the retained-notice chain, crashed ones become explicit failures,
// and truly orphaned runners are SIGKILLed and cleaned.

// orphanAfterMs is the freshness exemption for F5b (3x the agent's
// foreground window): a job this young may simply not have written its
// placeholder row yet, so it is never judged orphaned.
var orphanAfterMs = int64(3 * tools.AutoBackgroundAfter / time.Millisecond)

// rootDir resolves <root> from the supervisor's data dir (the slot).
func (b *bgSupervisor) rootDir() string { return newDiskStore(b.dataDir).rootDir() }

// adoptRunners reconciles every runner state at boot (F5/F5b).
func (b *bgSupervisor) adoptRunners() {
	root := b.rootDir()
	now := time.Now().UnixMilli()
	for _, st := range runner.LoadStates(root) {
		switch {
		case st.Terminal():
			// Outcome already recorded: hand it to the notice chain
			// (idempotent by background_delivery) and let GC age it out.
			b.retainNotice(st.JobID, st.SessionID, runnerNoticeText(st), true)
		case pidAlive(pidString(st.PID)):
			if b.orphaned(st, now) {
				// F5b: the session has moved past this job (or is gone):
				// blunt and clean — kill the group and clean the state.
				trace("runner.orphan", map[string]any{"job": st.JobID, "sid": st.SessionID})
				_ = terminatePid(st.PID)
				// Wait for death BEFORE cleaning: the dying runner
				// rewrites its own state (graceful SIGTERM) and must not
				// resurrect a cleaned record.
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) && pidAlive(pidString(st.PID)) {
					time.Sleep(50 * time.Millisecond)
				}
				_ = os.Remove(runner.StatePath(root, st.JobID))
			} else {
				// F5: adopt — the job lives; the registry tail resumes
				// streaming from the out log and a watcher folds the
				// completion later.
				b.adoptOne(st)
			}
		default:
			// F6: the runner itself died. Report an explicit terminal
			// failure — never a silent hang. The log survives.
			code := -1
			end := now
			st.Status, st.ExitCode, st.EndedAt = runner.StatusKilled, &code, &end
			_ = runner.WriteState(root, st)
			b.retainNotice(st.JobID, st.SessionID, runnerNoticeText(st), true)
		}
	}
	b.gcRunners(now)
}

// adoptOne registers a live runner as a background job and watches its
// state file until it reaches a terminal outcome.
func (b *bgSupervisor) adoptOne(st *runner.State) {
	if _, exists := b.jobs[st.JobID]; exists {
		return
	}
	j := &bgJob{
		ID: st.JobID, Kind: st.Kind, SessionID: st.SessionID,
		Label:     truncateBgLabel(st.Label),
		PID:       st.PID, Identity: "runner",
		Status:    BgStatusRunning,
		StartedAt: st.StartedAt,
		LogPath:   st.LogPath, StderrPath: "",
		done:   make(chan struct{}),
		cancel: func() { _ = terminatePid(st.PID) },
		stop:   func() { _ = killRunnerIPC(b.rootDir(), st.JobID); _ = terminatePid(st.PID) },
	}
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	b.jobs[j.ID] = j
	trace("runner.adopt", map[string]any{"job": j.ID, "sid": j.SessionID})
	b.broadcast()
	go b.watchAdopted(st.JobID, st)
}

// watchAdopted folds an adopted runner's completion into the registry by
// routing it through the supervisor inbox — the single-threaded loop
// owns the registry and the notice chain (idempotent via the transcript
// identity), so no watcher ever mutates jobs directly.
func (b *bgSupervisor) watchAdopted(jobID string, st *runner.State) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for range tick.C {
		cur, err := runner.ReadState(runner.StatePath(b.rootDir(), jobID))
		if err != nil {
			return // state gone (GC or explicit clean)
		}
		if cur.Terminal() {
			status := BgStatusDone
			if cur.Status != runner.StatusDone || (cur.ExitCode != nil && *cur.ExitCode != 0) {
				status = BgStatusError
			}
			b.finishAdopted(jobID, status, runnerNoticeText(cur))
			return
		}
		if !pidAlive(pidString(cur.PID)) {
			// F6 mid-watch: crash, not a silent hang. The state records
			// the failure before the notice leaves.
			code := -1
			end := time.Now().UnixMilli()
			cur.Status, cur.ExitCode, cur.EndedAt = runner.StatusKilled, &code, &end
			_ = runner.WriteState(b.rootDir(), cur)
			b.finishAdopted(jobID, BgStatusError, runnerNoticeText(cur))
			return
		}
	}
}

// finishAdopted routes a terminal outcome through the registry loop.
func (b *bgSupervisor) finishAdopted(jobID, status, result string) {
	select {
	case b.inbox <- Envelope{Payload: bgFinishMsg{JobID: jobID, Status: status, Result: result}}:
	case <-b.done:
	case <-time.After(replyTimeout):
	}
}

// NowIfZero extracts EndedAt (0 when absent).
func NowIfZero(st *runner.State) int64 {
	if st.EndedAt != nil {
		return *st.EndedAt
	}
	return time.Now().UnixMilli()
}

// orphaned implements F5b: try to RECOVER the link first — the state's
// ids/timestamps are exactly what a corrupted WAL may have lost. Only a
// runner the session cannot possibly know is orphaned.
func (b *bgSupervisor) orphaned(st *runner.State, now int64) bool {
	if st.SessionID == "" {
		return true
	}
	rec := b.loadRecordForAdoption(st.SessionID)
	if rec != nil && sessionKnowsJob(rec, st.JobID) {
		return false // link exists: adopt
	}
	// No link YET is not an orphan: the placeholder row appears at the
	// 10s mark, and a record that failed to load once may simply not
	// have been visible yet. Only a job that is BOTH old enough AND
	// unlinkable is orphaned (F5b: "as vezes vc nao sabe — ai eh orfao
	// mesmo", but only after trying to recover).
	return now-st.StartedAt > orphanAfterMs
}

// sessionKnowsJob reports whether the transcript links this job
// (placeholder text or delivered notice carries the id).
func sessionKnowsJob(rec *SessionRecord, jobID string) bool {
	if rec == nil || jobID == "" {
		return false
	}
	for _, m := range rec.Messages {
		if m.Meta["background_delivery"] == jobID {
			return true
		}
		for _, c := range m.Content {
			switch b := c.(type) {
			case provider.TextBlock:
				if strings.Contains(b.Text, jobID) {
					return true
				}
			case provider.ToolResultBlock:
				for _, tc := range b.Content {
					if tb, ok := tc.(provider.TextBlock); ok && strings.Contains(tb.Text, jobID) {
						return true
					}
				}
			}
		}
	}
	return false
}

// runnerNoticeText is the retained-notice payload for a terminal state.
func runnerNoticeText(st *runner.State) string {
	label := st.Label
	if label == "" {
		label = st.Kind
	}
	status, code := "finished", 0
	if st.ExitCode != nil {
		code = *st.ExitCode
	}
	if st.Status == runner.StatusKilled {
		status = "was stopped"
	} else if code != 0 {
		status = fmt.Sprintf("failed (exit %d)", code)
	}
	return fmt.Sprintf("[Background %s task %s] %s. Full output: %s", st.Kind, st.JobID, status, st.LogPath)
}

// gcRunners (F8): dead terminal states age out; dead generation binaries
// go once nothing references them. runners/out/ is NEVER touched (D8).
func (b *bgSupervisor) gcRunners(now int64) {
	root := b.rootDir()
	const stateRetentionMs = int64(7 * 24 * time.Hour / time.Millisecond)
	aliveVersions := map[string]bool{}
	for _, st := range runner.LoadStates(root) {
		if !st.Terminal() {
			aliveVersions[st.RunnerVersion] = true
			continue
		}
		end := NowIfZero(st)
		if now-end > stateRetentionMs {
			_ = os.Remove(runner.StatePath(root, st.JobID))
		}
	}
	// Dead generation binaries: no live state of that version remains and
	// a different version is present (strict D3: no rollback copies).
	entries, err := os.ReadDir(runner.RunnersDir(root))
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "indirect-code-runner-") {
			present[e.Name()] = true
		}
	}
	if len(present) < 2 {
		return // nothing to choose from: keep the only binary we have
	}
	for name := range present {
		v := strings.TrimPrefix(name, "indirect-code-runner-")
		v = strings.TrimSuffix(v, ".exe")
		if !aliveVersions[v] {
			_ = os.Remove(runner.RunnersDir(root) + string(os.PathSeparator) + name)
		}
	}
}

// loadRecordForAdoption reads a session record from disk without going
// through the actor (the actor may not exist yet at boot).
func (b *bgSupervisor) loadRecordForAdoption(sessionID string) *SessionRecord {
	if !validSessionID(sessionID) {
		return nil
	}
	st := newDiskStore(b.dataDir)
	rec, err := st.loadSession(sessionID)
	if err != nil {
		return nil
	}
	return rec
}
