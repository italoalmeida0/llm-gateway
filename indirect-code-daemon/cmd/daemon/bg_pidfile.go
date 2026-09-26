package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
)

// pidfile recovery: on (re)start the supervisor scans pidfiles.
// A live pid is re-adopted (new waiter, keeps running); a dead pid is
// finalized from the .log tail as orphaned. Jobs are NEVER re-run.

func (b *bgSupervisor) writePidfile(j *bgJob) error {
	if err := os.MkdirAll(b.bgDir(), 0o700); err != nil {
		return err
	}
	pf := bgPidfile{JobID: j.ID, PID: j.PID, Identity: j.Identity, Runner: j.Runner, SessionID: j.SessionID, Kind: j.Kind, Label: j.Label, LogPath: j.LogPath, StderrPath: j.StderrPath, StartedAt: j.StartedAt}
	data, err := json.Marshal(pf)
	if err != nil { return err }
	return writeAtomicFile(b.pidPath(j.ID), append(data, '\n'))
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
		// V2R-003: runner-backed jobs recover ONLY through their runner
		// state file (adoptRunners). A stale/leftover pidfile must not
		// re-adopt them as legacy jobs and mislabel their exit status.
		if pf.Runner {
			_ = os.Remove(b.pidPath(pf.JobID))
			continue
		}
		if b.jobs == nil {
			b.jobs = map[string]*bgJob{}
		}
		if pf.Identity != "" && tools.ProcessIdentity(pf.PID) == pf.Identity {
			j := &bgJob{
				ID: pf.JobID, Kind: pf.Kind, SessionID: pf.SessionID,
				Label: pf.Label, PID: pf.PID, Identity: pf.Identity, Status: BgStatusRunning,
				StartedAt: pf.StartedAt, LogPath: pf.LogPath, StderrPath: pf.StderrPath,
				done: make(chan struct{}),
			}
			j.stop = func() { tools.StopRecoveredProcess(pf.PID, pf.Identity) }
			b.jobs[j.ID] = j
			b.watchReadopted(j)
			fmt.Printf("[INFO] re-adopted live bg job %s (pid %d)\n", j.ID, j.PID)
		} else {
			tail, _ := bgReadTailPath(pf.LogPath, 4*1024)
			j := &bgJob{
				ID: pf.JobID, Kind: pf.Kind, SessionID: pf.SessionID,
				Label: pf.Label, PID: pf.PID, Identity: pf.Identity, Status: BgStatusOrphaned,
				StartedAt: pf.StartedAt, EndedAt: time.Now().UnixMilli(),
				LogPath: pf.LogPath, StderrPath: pf.StderrPath,
				Result: fmt.Sprintf("Background task %s orphaned by daemon restart (process gone). Partial output (if any) is in the .log at: %s\n%s", pf.Label, pf.LogPath, tail),
				done:   make(chan struct{}),
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
	// Capture immutable values; the supervisor owns subsequent job mutations.
	pid, identity, id, label, path, done := j.PID, j.Identity, j.ID, j.Label, j.LogPath, j.done
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-b.done:
				return
			case <-tick.C:
				if tools.ProcessIdentity(pid) != identity {
					select {
					case b.inbox <- Envelope{Payload: bgFinishMsg{JobID: id, Status: BgStatusOrphaned, Result: fmt.Sprintf("Background task %s ended after restart; exit status unavailable. Read %s", label, path)}}:
					case <-b.done:
					}
					return
				}
			}
		}
	}()
}

func bgReadTailPath(path string, max int) (string, bool) {
	if path == "" {
		return "", false
	}
	if max <= 0 || max > 256*1024 { max = 64*1024 }
	f, err := os.Open(path)
	if err != nil { return "", false }
	defer f.Close()
	info, err := f.Stat()
	if err != nil { return "", false }
	n := min(int64(max), info.Size())
	buf := make([]byte, n)
	read, err := f.ReadAt(buf, info.Size()-n)
	return string(buf[:read]), err == nil || err == io.EOF
}

var _ = tools.BgLabelMax
