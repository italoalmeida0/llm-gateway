package main

import (
	"bytes"
	"fmt"
	"io"
	"os"

	"llm-gateway/indirect-code-daemon/packages/runner"
)

// Recovery runs on the session actor. A notice is never acknowledged before
// the task's terminal state and output tail have also been persisted.
type bgTaskRecoverMsg struct {
	JobID string
	Reply chan bgTaskRecoverResult
}

type bgTaskRecoverResult struct {
	Offset int64
	Error  error
}

type bgTaskRecoverChunkMsg struct {
	JobID  string
	Text   string
	Offset int64
}

func (a *sessionActor) onBgTaskRecover(m bgTaskRecoverMsg) {
	offset, err := a.restoreRunnerTask(m.JobID)
	if m.Reply != nil {
		select {
		case m.Reply <- bgTaskRecoverResult{Offset: offset, Error: err}:
		default:
		}
	}
}

func (a *sessionActor) onRecoveredBgChunk(m bgTaskRecoverChunkMsg) {
	i := findBgTask(a.rec, m.JobID)
	if i < 0 {
		return
	}
	// A terminal recovery may already have ingested bytes still queued by
	// the live tailer. Absolute byte offsets make those arrivals idempotent.
	overlap := a.rec.BgTasks[i].TotalBytes - m.Offset
	if overlap < 0 {
		trace("bg.chunk.gap", map[string]any{"sid": a.id, "job": m.JobID})
		return
	}
	if overlap >= int64(len(m.Text)) {
		return
	}
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: m.JobID, Text: m.Text[overlap:]})
}

func (a *sessionActor) restoreRunnerTask(jobID string) (int64, error) {
	if a.store == nil {
		return 0, nil
	}
	var previous BgTask
	if i := findBgTask(a.rec, jobID); i >= 0 {
		previous = a.rec.BgTasks[i]
	}
	root := a.store.rootDir()
	st, err := runner.ReadState(runner.StatePath(root, jobID))
	if os.IsNotExist(err) {
		return previous.TotalBytes, nil
	} // direct or acknowledged job
	if err != nil {
		return previous.TotalBytes, err
	}
	if st.SessionID != a.id || st.JobID != jobID {
		return previous.TotalBytes, fmt.Errorf("runner owner mismatch")
	}
	disp := runner.ReadDisposition(root, jobID)
	if disp != runner.DispBackground && disp != runner.DispSuppressed {
		return previous.TotalBytes, nil
	}
	task := previous
	task.ID, task.Kind, task.Label = jobID, st.Kind, truncateBgLabel(st.Label)
	task.StartedAt = st.StartedAt
	task.Status = BgStatusRunning
	capBytes := bgLiveCap
	if st.Terminal() {
		task.Status = BgStatusDone
		if st.ExitCode != nil {
			task.ExitCode = *st.ExitCode
		}
		if st.Status != runner.StatusDone || task.ExitCode != 0 {
			task.Status = BgStatusError
		}
		if disp == runner.DispSuppressed || previous.Status == BgStatusCancelled {
			task.Status = BgStatusCancelled
		}
		task.EndedAt = NowIfZero(st)
		capBytes = bgFinalCap
	} else if previous.ID != "" && previous.Status != BgStatusRunning {
		return previous.TotalBytes, nil // an older state cannot revive a terminal task
	}
	if err := restoreRunnerOutput(&task, st.LogPath, capBytes); err != nil && !os.IsNotExist(err) {
		return previous.TotalBytes, err
	}
	if task == previous && a.persistErr == nil {
		return task.TotalBytes, nil
	}
	// A prior failed save may already have updated RAM. Retry that snapshot
	// before allowing the supervisor to retire its durable runner identity.
	if task != previous {
		task.Seq = previous.Seq + 1
	}
	upsertBgTask(a.rec, &task)
	if err := a.saveOrAppend(walEvent{Type: walTypeBgTask, BgTask: &task}); err != nil {
		a.bgDirty = true
		return task.TotalBytes, err
	}
	a.pingChange()
	a.emit(tailContentEvent(a.hostID(), a.id, "session_content", a.rec, 0, map[string]any{"bgTasks": bgTaskPayloads(a.rec.BgTasks)}))
	return task.TotalBytes, nil
}

// Read the immutable prefix present at open time with bounded memory. The
// complete log remains on disk; only the display tail enters the session.
func restoreRunnerOutput(task *BgTask, path string, capBytes int) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	reader := io.NewSectionReader(f, 0, st.Size())
	buf := make([]byte, 32*1024)
	var tail []byte
	var total, lines int64
	var last byte
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			total += int64(n)
			lines += int64(bytes.Count(buf[:n], []byte{'\n'}))
			last = buf[n-1]
			tail = append(tail, buf[:n]...)
			if len(tail) > capBytes {
				tail = append([]byte(nil), tail[len(tail)-capBytes:]...)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if total > 0 && last != '\n' {
		lines++
	}
	if total > int64(len(tail)) {
		if cut := bytes.IndexByte(tail, '\n'); cut >= 0 {
			tail = tail[cut+1:]
		}
	}
	task.Content = string(tail)
	task.TotalBytes, task.TotalLines = total, lines
	task.DroppedBytes = total - int64(len(tail))
	task.DroppedLines = lines - int64(countLines(task.Content))
	return nil
}
