package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// sessionsAdmin implements create/delete/rename/pin + summaries + purge.
// All disk scans are cheap (meta-tail only, no message hydration).

func listSessionSummaries(dataDir string) []SessionSummary {
	st := newDiskStore(dataDir)
	dir := st.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []SessionSummary
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") || strings.HasSuffix(e.Name(), ".wal.jsonl") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		meta, err := st.readMetaTail(id)
		if err != nil || meta.ID == "" || meta.ID != id {
			continue
		}
		out = append(out, SessionSummary{
			ID: meta.ID, CWD: resolvePath(meta.CWD), Title: meta.Title,
			Model: meta.Model, Status: meta.Status, Pinned: meta.Pinned,
			CreatedAt: meta.CreatedAt, UpdatedAt: meta.UpdatedAt,
			TodosOpen: meta.TodosOpen, Options: &meta.Options,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

func sessionListItem(s SessionSummary) map[string]any {
	return map[string]any{
		"id": s.ID, "cwd": s.CWD, "title": s.Title, "model": s.Model,
		"status": s.Status, "pinned": s.Pinned,
		"createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt,
		"todosOpen": s.TodosOpen, "options": s.Options,
	}
}

// sessionAdmin bundles the callbacks a WS dispatcher needs: route to the
// session supervisor, purge, bg access, config, emit.
type sessionAdmin struct {
	dataDir string
	route   func(id string, forRead bool) spawnResult
	purge   func(id string)
	bg      *bgSupervisor
	cfg     *configCell
	emit    func(any)
	onEvent func(string)
}

func (a *sessionAdmin) host() string {
	if a.cfg != nil {
		if cfg := a.cfg.load(); cfg != nil {
			return cfg.HostID
		}
	}
	return ""
}

// purgeSession stops bg jobs, drops the resident actor, deletes disk state.
func (a *sessionAdmin) purgeSession(id string) {
	if !validSessionID(id) {
		return
	}
	// Best-effort: cancel running jobs of this session via bg supervisor.
	if a.bg != nil {
		reply := make(chan any, 1)
		select {
		case a.bg.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}:
		case <-time.After(replyTimeout):
		}
		select {
		case r := <-reply:
			if rows, ok := r.([]map[string]any); ok {
				for _, row := range rows {
					if row["sessionId"] == id && row["status"] == BgStatusRunning {
						creply := make(chan any, 1)
						if jid, _ := row["id"].(string); jid != "" {
							select {
							case a.bg.inbox <- Envelope{Payload: bgCancelMsg{JobID: jid, Reply: creply}}:
							case <-time.After(replyTimeout):
							}
							select {
							case <-creply:
							case <-time.After(replyTimeout):
							}
						}
					}
				}
			}
		case <-time.After(replyTimeout):
		}
	}
	res := a.route(id, false)
	if res.Error == "" {
		select {
		case res.Control <- shutdownMsg{}:
		case <-time.After(5 * time.Second):
		}
		select {
		case <-res.Done:
		case <-time.After(10 * time.Second):
		}
	}
	st := newDiskStore(a.dataDir)
	_ = os.Remove(filepath.Join(st.sessionsDir(), id+".jsonl"))
	_ = os.Remove(filepath.Join(st.sessionsDir(), id+".json"))
	_ = os.Remove(filepath.Join(st.sessionsDir(), id+".wal.jsonl"))
	_ = os.RemoveAll(filepath.Join(st.sessionsDir(), id))
	_ = os.RemoveAll(st.brainDir(id))
	a.emit(map[string]any{"type": "session_deleted", "hostId": a.host(), "sessionId": id})
	if a.onEvent != nil {
		a.onEvent("sessions")
	}
}

func (a *sessionAdmin) createSession(cwd, title, model string, options SessionOptions, requestID string) {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" || cwd == "~" {
		home, _ := os.UserHomeDir()
		cwd = home
	} else if strings.HasPrefix(cwd, "~/") {
		home, _ := os.UserHomeDir()
		cwd = filepath.Join(home, cwd[2:])
	}
	var err error
	cwd, err = filepath.Abs(cwd)
	if err == nil {
		err = os.MkdirAll(cwd, 0o755)
	}
	var info os.FileInfo
	var statErr error
	if err == nil {
		info, statErr = os.Stat(cwd)
	}
	if err != nil || statErr != nil || !info.IsDir() {
		a.emit(map[string]any{"type": "error", "hostId": a.host(), "requestId": requestID, "message": "Select an existing project folder before starting a conversation"})
		return
	}
	sessID := "sess_" + randomID8() + randomID8()
	title = strings.TrimSpace(title)
	titleSource := "manual"
	if title == "" {
		title = "New conversation"
		titleSource = "pending"
	}
	var lastModel string
	if cfg := a.cfg.load(); cfg != nil && cfg.LastSelection != nil {
		lastModel = cfg.LastSelection.Model
	}
	if model == "" {
		model = lastModel
	}
	now := time.Now().UnixMilli()
	rec := &SessionRecord{
		Options: normalizedOptions(options), ID: sessID, CWD: cwd,
		Title: title, TitleSource: titleSource, Model: model,
		Status: "idle", CreatedAt: now, UpdatedAt: now,
	}
	st := newDiskStore(a.dataDir)
	if err := st.saveSessionSync(rec); err != nil {
		a.emit(map[string]any{"type": "error", "hostId": a.host(), "requestId": requestID, "message": "Failed to create session: " + err.Error()})
		return
	}
	a.emit(map[string]any{"type": "session_created", "requestId": requestID, "hostId": a.host(), "session": sessionPayloadPaged(rec, 0)})
	if a.onEvent != nil {
		a.onEvent("sessions")
	}
}
