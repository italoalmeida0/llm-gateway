package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/internal/durable"
	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Runner adoption, orphan policy and GC (F5/F5b/F6/F8).
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

// repairTerminalCopy heals the crash windows between the terminal state
// write and the brain copy (and a torn mid-copy): the out log is the
// source of truth, so a missing or truncated brain copy is re-COPIED
// (copy semantics preserved — the out original always survives).
func repairTerminalCopy(st *runner.State) error {
	if st.LogPath == "" || st.BrainPath == "" {
		return fmt.Errorf("missing output path")
	}
	src, err := os.Stat(st.LogPath)
	if err != nil {
		return err
	}
	if dst, err := os.Stat(st.BrainPath); err == nil && !dst.IsDir() && dst.Size() == src.Size() && st.OutputReady {
		return nil
	}
	return durable.Copy(st.LogPath, st.BrainPath)
}

// rootDir resolves <root> from the supervisor's data dir (the slot).
func (b *bgSupervisor) rootDir() string { return newDiskStore(b.dataDir).rootDir() }

// adoptRunners reconciles every runner state at boot (F5/F5b).
func (b *bgSupervisor) adoptRunners() {
	root := b.rootDir()
	now := time.Now().UnixMilli()
	states, invalid := runner.ScanStates(root)
	for _, name := range invalid {
		trace("runner.state.invalid", map[string]any{"file": name})
	}
	for _, st := range states {
		switch {
		case st.Terminal():
			// Restore the session tail/status before acknowledging the notice.
			// The out log also repairs a copy interrupted by a crash.
			if err := repairTerminalCopy(st); err != nil {
				trace("runner.copy.repair_failed", map[string]any{"job": st.JobID, "error": err.Error()})
			}
			b.sessionInbox(st.SessionID, bgTaskRecoverMsg{JobID: st.JobID})
			// V2R-001: only a task that was a real BACKGROUND job notifies.
			// An inline (foreground) outcome was already consumed by the
			// agent, and a suppressed (assistant) cancel is silent — a
			// restart must never invent a wake-up for either.
			switch runner.ReadDisposition(root, st.JobID) {
			case runner.DispBackground:
				b.retainNotice(st.JobID, st.SessionID, runnerNoticeText(st), true)
			default:
				// inline / suppressed / absent: silent.
			}
		case pidAlive(pidString(st.PID)) && !processutil.Matches(st.PID, st.ProcessIdentity):
			trace("runner.identity.unverified", map[string]any{"job": st.JobID})
			continue
		case processutil.Matches(st.PID, st.ProcessIdentity):
			if b.orphaned(st, now) {
				// F5b: the session has moved past this job (or is gone):
				// blunt and clean — kill the group and clean the state.
				trace("runner.orphan", map[string]any{"job": st.JobID, "sid": st.SessionID})
				// Orphans are killed UNCONDITIONALLY (V2R-002/F5b): a
				// graceful signal is not guaranteed to be honored, and the
				// command's tree must die with the runner.
				// Retry the kill: a single failed signal (Windows handle
				// race, slow teardown) must not leave the orphan alive
				// until the next boot.
				killed := false
				for attempt := 0; attempt < 3 && !killed; attempt++ {
					_ = processutil.SignalIdentity(st.PID, st.ProcessIdentity, 9)
					reapStoredCommand(st)
					// Wait for death BEFORE cleaning: the dying runner
					// rewrites its own state (graceful SIGTERM) and must not
					// resurrect a cleaned record.
					deadline := time.Now().Add(5 * time.Second)
					for time.Now().Before(deadline) && pidAlive(pidString(st.PID)) {
						time.Sleep(50 * time.Millisecond)
					}
					killed = !processutil.Matches(st.PID, st.ProcessIdentity)
				}
				if !killed {
					trace("runner.orphan.stop_pending", map[string]any{"job": st.JobID})
					continue
				}
				_ = os.Remove(runner.StatePath(root, st.JobID))
			} else {
				// F5: adopt — the job lives; the registry tail resumes
				// streaming from the out log and a watcher folds the
				// completion later.
				b.adoptOne(st)
			}
		default:
			// F6: the runner itself died. The runner owned the command's
			// lifetime (V2R-002), so the parent must reap the command's
			// group from the durable identity — a hard-killed runner must
			// never leave the command running while the state says killed.
			reapStoredCommand(st)
			code := -1
			end := now
			st.Status, st.ExitCode, st.EndedAt = runner.StatusKilled, &code, &end
			st.OutcomeUnknown = true
			if err := runner.WriteState(root, st); err != nil {
				continue
			}
			b.sessionInbox(st.SessionID, bgTaskRecoverMsg{JobID: st.JobID})
			// V2R-001: a dead runner still honours the disposition — a
			// suppressed (assistant) cancel or an inline foreground return
			// must NOT become a wake-up just because the runner died before
			// writing its terminal state (the cancel race).
			if runner.ReadDisposition(root, st.JobID) == runner.DispBackground {
				b.retainNotice(st.JobID, st.SessionID, runnerNoticeText(st), true)
			}
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
		Label: truncateBgLabel(st.Label),
		PID:   st.PID, Identity: st.ProcessIdentity,
		Runner:    true,
		Status:    BgStatusRunning,
		StartedAt: st.StartedAt,
		LogPath:   st.LogPath, BrainLog: st.BrainPath, StderrPath: "",
		done: make(chan struct{}),
		stop: func() { stopRunner(b.rootDir(), st.JobID, st.PID) },
	}
	if b.jobs == nil {
		b.jobs = map[string]*bgJob{}
	}
	b.jobs[j.ID] = j
	trace("runner.adopt", map[string]any{"job": j.ID, "sid": j.SessionID})
	// V2R-010: resume OUTPUT delivery for the adopted job — a bounded file
	// tail from the current end of the out log streams subsequent bytes to
	// the session (bg_output), exactly like a live job. The file is the
	// contract; the socket remains optional.
	go b.tailAdoptedOutput(st, j.done)
	go b.watchAdopted(st.JobID, st)
}

// tailAdoptedOutput streams new bytes of an adopted runner's out log to
// the session until the file stops growing (the job ended). Bounded: it
// reads incrementally and stops on the job's done channel.
func (b *bgSupervisor) tailAdoptedOutput(st *runner.State, jobDone <-chan struct{}) {
	if st.LogPath == "" || b.session == nil || runner.ReadDisposition(b.rootDir(), st.JobID) != runner.DispBackground {
		return
	}
	// Rebuild the durable tail first, including bytes produced while the
	// daemon was down. Resume at the actor's acknowledged byte offset.
	var offset int64
	for {
		reply := make(chan bgTaskRecoverResult, 1)
		if !b.sessionInboxReliable(st.SessionID, bgTaskRecoverMsg{JobID: st.JobID, Reply: reply}) {
			return
		}
		select {
		case res := <-reply:
			if res.Error == nil {
				offset = res.Offset
				goto ready
			}
			trace("runner.tail.restore_failed", map[string]any{"job": st.JobID, "error": res.Error.Error()})
		case <-jobDone:
			return
		case <-b.done:
			return
		case <-time.After(time.Second):
		}
		select {
		case <-jobDone:
			return
		case <-b.done:
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
ready:
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	buf := make([]byte, 32*1024)
	for {
		select {
		case <-jobDone:
			return
		case <-b.done:
			return
		case <-tick.C:
		}
		f, err := os.Open(st.LogPath)
		if err != nil {
			return
		}
		// Drain the available prefix completely, including the final burst.
		for {
			n, readErr := f.ReadAt(buf, offset)
			if n > 0 {
				if !b.sessionInboxReliable(st.SessionID, bgTaskRecoverChunkMsg{JobID: st.JobID, Text: string(buf[:n]), Offset: offset}) {
					f.Close()
					return
				}
				offset += int64(n)
			}
			if readErr != nil || n == 0 {
				break
			}
			select {
			case <-jobDone:
				f.Close()
				return
			case <-b.done:
				f.Close()
				return
			default:
			}
		}
		f.Close()
		cur, err := runner.ReadState(runner.StatePath(b.rootDir(), st.JobID))
		if err != nil || cur.Terminal() || !pidAlive(pidString(st.PID)) {
			return
		}
	}
}

// watchAdopted folds an adopted runner's completion into the registry by
// routing it through the supervisor inbox — the single-threaded loop
// owns the registry and the notice chain (idempotent via the transcript
// identity), so no watcher ever mutates jobs directly.
func (b *bgSupervisor) watchAdopted(jobID string, st *runner.State) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-b.done:
			return
		case <-tick.C:
		}
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
		if pidAlive(pidString(cur.PID)) && !processutil.Matches(cur.PID, cur.ProcessIdentity) {
			// Identity race (pid recycling window / slow identity write):
			// NOT fatal — keep watching. Giving up here left the job
			// running forever with no finish and no notice (regression:
			// TestBgWatchAdoptedSurvivesIdentityRace).
			trace("runner.identity.unverified", map[string]any{"job": cur.JobID})
			continue
		}
		if !pidAlive(pidString(cur.PID)) {
			// F6 mid-watch: crash, not a silent hang. The state records
			// the failure before the notice leaves.
			reapStoredCommand(cur)
			code := -1
			end := time.Now().UnixMilli()
			cur.Status, cur.ExitCode, cur.EndedAt = runner.StatusKilled, &code, &end
			cur.OutcomeUnknown = true
			if err := runner.WriteState(b.rootDir(), cur); err != nil {
				continue
			}
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
	// The execution receipt precedes launch and links foreground work even
	// when the daemon died before saving the transcript placeholder.
	if rec != nil {
		if path := executionReceiptPath(b.rootDir(), st.SessionID, st.JobID); path != "" {
			if _, err := os.Stat(path); err == nil {
				return false
			}
		}
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
	if st.OutcomeUnknown {
		status = "interrupted; command outcome unknown; verify effects before repeating"
	}
	return fmt.Sprintf("[Background %s task %s] %s. Read the output with bg_check (job_id %s).", st.Kind, st.JobID, status, st.JobID)
}

// gcRunners retires acknowledged runner identities and unused binaries.
// Full output logs and brain copies are retained; runners/out is GC-exempt.
func (b *bgSupervisor) gcRunners(now int64) {
	root := b.rootDir()
	aliveVersions := map[string]bool{}
	states, invalid := runner.ScanStates(root)
	if len(invalid) != 0 {
		return
	} // uncertain ownership must retain recovery artifacts
	for _, st := range states {
		if !st.Terminal() {
			aliveVersions[st.RunnerVersion] = true
			continue
		}
		// Leftover sweep: a terminal state with no live supervisor job
		// is either pre-cleanup or orphaned — remove it now, UNLESS:
		// - a background notice is still pending (crash between
		//   terminal and ack: the outcome must survive until folded);
		// - disposition is background (notice not yet delivered);
		// - it ended recently (<1h grace: a fresh terminal from this
		//   boot's reconciliation must survive for readers/tests).
		// A live job's files are owned by onFinish/onCancel, never by GC.
		if _, ok := b.jobs[st.JobID]; !ok {
			if _, pending := b.notices[st.JobID]; pending {
				aliveVersions[st.RunnerVersion] = true
				continue
			}
			if runner.ReadDisposition(root, st.JobID) == runner.DispBackground {
				aliveVersions[st.RunnerVersion] = true
				continue
			}
			if end := NowIfZero(st); now-end < int64(time.Hour/time.Millisecond) {
				aliveVersions[st.RunnerVersion] = true
				continue
			}
			_ = os.Remove(runner.StatePath(root, st.JobID))
			_ = os.Remove(runner.DispositionPath(root, st.JobID))
			_ = os.Remove(filepath.Join(runner.RunnersDir(root), st.JobID+".launch"))
		} else {
			aliveVersions[st.RunnerVersion] = true
		}
		_ = now
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
