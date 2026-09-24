package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

// pidfile recovery (plan §5.3): on (re)start the supervisor scans pidfiles.
// A live pid is re-adopted (new waiter, keeps running); a dead pid is
// finalized from the .log tail as orphaned. Jobs are NEVER re-run.

func (b *bgSupervisor) writePidfile(j *bgJob) {
	if err := os.MkdirAll(b.bgDir(), 0o700); err != nil {
		return
	}
	pf := bgPidfile{JobID: j.ID, PID: j.PID, SessionID: j.SessionID, Kind: j.Kind, Label: j.Label, LogPath: j.LogPath, StartedAt: j.StartedAt}
	data, err := json.Marshal(pf)
	if err != nil {
		return
	}
	_ = os.WriteFile(b.pidPath(j.ID), append(data, '\n'), 0o600)
}

func (b *bgSupervisor) readopt() {
	entries, err := os.ReadDir(b.bgDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".pid.json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(b.bgDir(), e.Name()))
		if err != nil {
			continue
		}
		var pf bgPidfile
		if err := json.Unmarshal(data, &pf); err != nil || pf.JobID == "" {
			continue
		}
		if b.jobs == nil {
			b.jobs = map[string]*bgJob{}
		}
		if pidAlive(pf.PID) {
			j := &bgJob{
				ID: pf.JobID, Kind: pf.Kind, SessionID: pf.SessionID,
				Label: pf.Label, PID: pf.PID, Status: BgStatusRunning,
				StartedAt: pf.StartedAt, LogPath: pf.LogPath,
				done: make(chan struct{}), sleepers: map[chan struct{}]struct{}{},
			}
			b.jobs[j.ID] = j
			b.watchReadopted(j)
			fmt.Printf("[INFO] re-adopted live bg job %s (pid %d)\n", j.ID, j.PID)
		} else {
			tail, _ := bgReadTailPath(pf.LogPath, 4*1024)
			j := &bgJob{
				ID: pf.JobID, Kind: pf.Kind, SessionID: pf.SessionID,
				Label: pf.Label, PID: pf.PID, Status: BgStatusOrphaned,
				StartedAt: pf.StartedAt, EndedAt: time.Now().UnixMilli(),
				LogPath: pf.LogPath,
				Result:  fmt.Sprintf("Background task %s orphaned by daemon restart (process gone). Partial output (if any) is in the .log at: %s\n%s", pf.Label, pf.LogPath, tail),
				done:    make(chan struct{}),
			}
			j.closeDone()
			b.jobs[j.ID] = j
			_ = os.Remove(b.pidPath(pf.JobID))
			fmt.Printf("[INFO] finalized orphaned bg job %s\n", j.ID)
		}
	}
}

// watchReadopted polls a re-adopted pid until it exits, then finalizes the
// job exactly like a normal finish (no re-run, log preserved).
func (b *bgSupervisor) watchReadopted(j *bgJob) {
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for range tick.C {
			if !pidAlive(j.PID) {
				select {
				case b.inbox <- Envelope{Payload: bgFinishMsg{JobID: j.ID, Status: BgStatusDone, Result: fmt.Sprintf("Background task %s finished (re-adopted after restart). Full output is in the .log at: %s", j.Label, j.LogPath)}}:
				case <-time.After(replyTimeout):
				}
				return
			}
		}
	}()
}

func bgReadTailPath(path string, max int) (string, bool) {
	if path == "" {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	if len(data) > max {
		data = data[len(data)-max:]
	}
	return string(data), true
}

var _ = tools.BgLabelMax
