package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// wsServer is the v2 WS boundary: one read loop (JSON dispatch, NO global
// lock — envelope parsed lock-free, each command routes to an actor) plus
// the ws actor as the single writer. It replaces v1's handleMessage +
// sendWS + notifyChange trinity.
//
// Wiring (from root): sessions, bg, projects, admin, cfg, ws.

type wsServer struct {
	dataDir string
	cfg     *configCell
	// configDir is where config.json lives (== dataDir unless --config).
	configDir    string
	onRemoteKill func(reason string)

	sessions *sessionSupervisor
	bg       *bgSupervisor
	projects *projectsActor
	admin    *sessionAdmin
	ws       *wsActor
	root     *root
	// resyncFlush single-flights the V2-002 gap-recovery flusher.
	resyncFlush atomic.Bool
	// lanes dispatch per-session command lanes + the host lane (V2-006).
	lanesMu  sync.Mutex
	lanes    map[string]*dispatchLane
	hostLane *dispatchLane
	// updates is the brutal-update protocol host (check/apply/toggle);
	// nil in tests that never boot the update flow.
	updates *DaemonServer

	debounceMu sync.Mutex
	debounce   map[string]*time.Timer
}

type convertOutcome struct {
	text  string
	err   string
	stale bool
}

func newWSServer(dataDir string, cfg *configCell, sessions *sessionSupervisor, bg *bgSupervisor, projects *projectsActor, admin *sessionAdmin, ws *wsActor) *wsServer {
	s := &wsServer{
		dataDir: dataDir, configDir: dataDir, cfg: cfg, sessions: sessions, bg: bg,
		projects: projects, admin: admin, ws: ws,
		debounce: map[string]*time.Timer{},
		lanes:    map[string]*dispatchLane{},
		hostLane: &dispatchLane{},
	}
	// V2-002: when outbox room appears (the writer caught up), flush any
	// sessions whose event stream had gaps so the client gets an explicit
	// resync instead of a silent hole.
	ws.onSpace = s.scheduleResyncFlush
	return s
}

// waitForLanes blocks until every dispatch lane is idle and no resync
// flusher is running (V2-006). Admitted commands must finish before their
// sessions' storage goes away (shutdown, test cleanup).
func (s *wsServer) waitForLanes() {
	deadline := time.Now().Add(30 * time.Second)
	for {
		s.lanesMu.Lock()
		lanes := make([]*dispatchLane, 0, len(s.lanes)+1)
		for _, l := range s.lanes {
			lanes = append(lanes, l)
		}
		lanes = append(lanes, s.hostLane)
		s.lanesMu.Unlock()
		busy := s.resyncFlush.Load()
		for _, l := range lanes {
			l.mu.Lock()
			if l.running || len(l.queue) > 0 {
				busy = true
			}
			l.mu.Unlock()
		}
		if !busy || time.Now().After(deadline) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// scheduleResyncFlush runs the resync flusher single-flight, OFF the ws
// writer goroutine (session snapshots round-trip actors and must never
// stall the socket writer).
func (s *wsServer) scheduleResyncFlush() {
	if !s.resyncFlush.CompareAndSwap(false, true) {
		return // a flusher is already running; it drains until empty
	}
	go func() {
		defer s.resyncFlush.Store(false)
		for {
			sids := s.ws.takeResyncs()
			if len(sids) == 0 {
				return
			}
			for _, sid := range sids {
				ev, _ := s.buildSessionData(sid, "")
				if ev == nil {
					continue // gone: nothing to resync
				}
				ev["resync"] = true
				// A drop here re-marks the session for the next round.
				s.emit(ev)
			}
		}
	}()
}

func (s *wsServer) host() string {
	if cfg := s.cfg.load(); cfg != nil {
		return cfg.HostID
	}
	return ""
}

func (s *wsServer) emit(ev any) { s.ws.emit(ev) }

// buildSessionData assembles the full client snapshot for one session:
// the persistent record PLUS the actor-owned transient overlay (V2-004)
// — the outstanding decision and the live turn state. Shared by
// get_session and the V2-002 resync flushes (one snapshot contract).
// Returns (nil, errMsg) when the session cannot be read right now.
func (s *wsServer) buildSessionData(sid, requestID string) (map[string]any, string) {
	res := s.sessions.route(sid, true)
	if res.Error != "" {
		return nil, "Session not found"
	}
	rr := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rr}}:
	case <-time.After(replyTimeout):
		return nil, "Session busy"
	}
	select {
	case r := <-rr:
		if rd, ok := r.(readResult); ok && rd.Error == "" {
			if rec, ok := rd.Payload.(*SessionRecord); ok {
				p := sessionPayloadPaged(rec, 0)
				for k, v := range rd.Extra {
					p[k] = v
				}
				return map[string]any{"type": "session_data", "requestId": requestID, "hostId": s.host(), "session": p}, ""
			}
		}
		return nil, "Session not found"
	case <-time.After(replyTimeout):
		return nil, "Session busy"
	}
}

func (s *wsServer) error(sessionID, requestID, msg string) {
	s.emit(map[string]any{"type": "error", "hostId": s.host(), "sessionId": sessionID, "requestId": requestID, "message": msg})
}

// notifyChange broadcasts the debounced {type:"change", collection} ping
// (300ms per collection, v1 semantics).
func (s *wsServer) notifyChange(collection string) {
	s.debounceMu.Lock()
	defer s.debounceMu.Unlock()
	if t, ok := s.debounce[collection]; ok {
		t.Stop()
	}
	c := collection
	s.debounce[c] = time.AfterFunc(300*time.Millisecond, func() {
		// v1 parity: the ping carries hostId so multi-host clients can
		// attribute the invalidation (the frozen protocol declares it).
		s.emit(map[string]any{"type": "change", "hostId": s.host(), "collection": c})
		s.debounceMu.Lock()
		delete(s.debounce, c)
		s.debounceMu.Unlock()
	})
}

// dispatch routes one inbound WS message. No global lock: parse the
// envelope, then hand to the owning actor (the Phase-0 fix, by construction).
func (s *wsServer) dispatch(raw []byte) {
	// V2-006: admission only — never block the socket reader on an actor
	// round-trip. Session commands run in order on their session's lane;
	// host-level commands have their own lane so one busy session cannot
	// delay unrelated work. Saturation answers with an explicit busy
	// error instead of queueing unboundedly.
	var base struct {
		Type      string `json:"type"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return
	}
	if base.SessionID == "" || base.Type == "cancel" {
		// Host lane: host-level commands plus CANCELLATION — a cancel must
		// never queue behind the very command it exists to stop (V2-006);
		// its work is a control-lane send, which cannot block on the session.
		s.hostLane.push(raw, s.handleRaw, func() {
			s.emit(map[string]any{"type": "error", "hostId": s.host(), "message": "Host busy"})
		})
		return
	}
	sid := base.SessionID
	s.lanesMu.Lock()
	l := s.lanes[sid]
	if l == nil {
		l = &dispatchLane{}
		s.lanes[sid] = l
	}
	s.lanesMu.Unlock()
	// configure_session has a host-state half (rememberSelection, read
	// back by `pull config`): enqueue that half on the host lane AT
	// ADMISSION so later host reads are ordered after it (read-after-write
	// across lanes). The actor half rides the session lane below.
	if base.Type == "configure_session" {
		s.hostLane.pushFn(func() {
			var req struct {
				Model   string         `json:"model"`
				Options SessionOptions `json:"options"`
			}
			_ = json.Unmarshal(raw, &req)
			s.rememberSelection(req.Model, req.Options)
		}, func() {
			s.emit(map[string]any{"type": "error", "hostId": s.host(), "message": "Host busy"})
		})
	}
	l.push(raw, s.handleRaw, func() {
		s.error(sid, "", "Session busy")
	})
}

// dispatchLane is one in-order command lane (V2-006). A single worker
// drains it at a time: dependent commands to the same session keep their
// order, while unrelated lanes advance independently. Bounded: overflow
// is refused with an explicit error, and the worker goroutine lives only
// while the lane has work.
type dispatchLane struct {
	mu      sync.Mutex
	queue   []func()
	running bool
}

func (l *dispatchLane) push(raw []byte, run func([]byte), onBusy func()) {
	l.pushFn(func() { run(raw) }, onBusy)
}

func (l *dispatchLane) pushFn(fn func(), onBusy func()) {
	l.mu.Lock()
	if len(l.queue) >= tuneDispatchQueue {
		l.mu.Unlock()
		onBusy()
		return
	}
	l.queue = append(l.queue, fn)
	if l.running {
		l.mu.Unlock()
		return
	}
	l.running = true
	l.mu.Unlock()
	go l.drain()
}

func (l *dispatchLane) drain() {
	for {
		l.mu.Lock()
		if len(l.queue) == 0 {
			l.running = false
			l.mu.Unlock()
			return
		}
		fn := l.queue[0]
		l.queue = l.queue[1:]
		l.mu.Unlock()
		fn()
	}
}

// handleRaw runs one admitted command on its lane's worker goroutine.
func (s *wsServer) handleRaw(raw []byte) {
	var base struct {
		Type      string `json:"type"`
		HostID    string `json:"hostId"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(raw, &base); err != nil {
		return
	}
	trace("ws.dispatch", map[string]any{"type": base.Type, "sid": base.SessionID})
	switch base.Type {
	case "shutdown", "disconnected":
		// Remote kill from the gateway (host row deleted while online).
		// Self-terminate instead of reconnecting: the host row is gone, so
		// any redial would 401 anyway (v1 gracefulShutdown parity). Runs
		// async: dispatch must never block the socket read loop.
		if s.onRemoteKill != nil {
			go s.onRemoteKill("[REMOTE] Host removed from gateway, shutting down.")
		}
		return

	case "prompt":
		var req struct {
			Options       *SessionOptions `json:"options"`
			SessionID     string          `json:"sessionId"`
			Text          string          `json:"text"`
			Model         string          `json:"model"`
			YOLO          bool            `json:"yolo"`
			AttachmentIDs []string        `json:"attachmentIds"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onPrompt(req.SessionID, req.Text, req.AttachmentIDs, req.Model, req.YOLO, req.Options)

	case "cancel":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		if res := s.sessions.route(req.SessionID, false); res.Error == "" {
			// The control lane carries cancellation: an admitted cancel is
			// NEVER silently dropped (V2-006) — wait for room and answer
			// busy only when the actor is wedged.
			select {
			case res.Control <- cancelTurnMsg{Reason: "user"}:
			case <-time.After(replyTimeout):
				s.error(req.SessionID, "", "Session busy")
			}
		}

	case "get_session":
		var req struct {
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		ev, errMsg := s.buildSessionData(req.SessionID, req.RequestID)
		if ev == nil {
			s.error(req.SessionID, req.RequestID, errMsg)
			return
		}
		s.emit(ev)

	case "get_history":
		var req struct {
			SessionID  string `json:"sessionId"`
			BeforeTurn int    `json:"beforeTurn"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID == "" || req.BeforeTurn <= 0 {
			return
		}
		res := s.sessions.route(req.SessionID, true)
		if res.Error != "" {
			s.error(req.SessionID, "", "Session not found")
			return
		}
		rr := make(chan any, 1)
		select {
		case res.Inbox <- Envelope{Payload: readReqMsg{What: "historyBlock", BeforeTurn: req.BeforeTurn, Reply: rr}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case r := <-rr:
			if rd, ok := r.(readResult); ok && rd.Error == "" {
				if block, ok := rd.Payload.(historyBlock); ok {
					atts := block.Attachments
					s.emit(map[string]any{
						"type": "session_content", "hostId": s.host(), "sessionId": req.SessionID, "page": true,
						"messages":     sanitizeMessagesForFrontend(block.Messages, atts),
						"fileBalloons": fileBalloonPayloads(block.Balloons),
						"history": map[string]any{
							"oldestTurn": block.OldestTurn, "newestTurn": block.NewestTurn,
							"hasOlder": block.HasOlder, "totalTurns": block.TotalTurns, "firstIndex": block.FirstIndex,
						},
					})
				}
			}
		case <-time.After(replyTimeout):
		}

	case "health":
		// Infra observability (report item 4): serve the root watchdog's
		// last ping round over the existing socket. polled by dashboards,
		// costs one message, no HTTP surface on the daemon by design.
		if s.root != nil {
			infra, at := s.root.healthSnapshot()
			trace("ws.health", map[string]any{"n": len(infra), "asOf": at})
			s.emit(map[string]any{"type": "health", "hostId": s.host(), "infra": infra, "asOf": at})
		} else {
			s.emit(map[string]any{"type": "health", "hostId": s.host(), "infra": map[string]any{}, "asOf": 0})
		}

	case "pull":
		var req struct {
			ID         json.RawMessage `json:"id"`
			Collection string          `json:"collection"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onPull(req.ID, req.Collection)

	case "create_session":
		var req struct {
			Options   SessionOptions `json:"options"`
			RequestID string         `json:"requestId"`
			CWD       string         `json:"cwd"`
			Title     string         `json:"title"`
			Model     string         `json:"model"`
		}
		_ = json.Unmarshal(raw, &req)
		s.admin.createSession(req.CWD, req.Title, req.Model, req.Options, req.RequestID)

	case "delete_session":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.admin.purgeSession(req.SessionID)

	case "rename_session":
		var req struct {
			SessionID string `json:"sessionId"`
			Title     string `json:"title"`
		}
		_ = json.Unmarshal(raw, &req)
		title := strings.TrimSpace(req.Title)
		if req.SessionID == "" || title == "" {
			return
		}
		if runes := []rune(title); len(runes) > 120 {
			title = string(runes[:120])
		}
		res := s.sessions.route(req.SessionID, false)
		if res.Error != "" {
			return
		}
		rr := make(chan any, 1)
		select {
		case res.Inbox <- Envelope{Payload: renameMsg{Title: title, Reply: rr}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case result := <-rr:
			if err, ok := result.(error); ok {
				s.error(req.SessionID, "", err.Error())
				return
			}
			s.emit(map[string]any{"type": "session_renamed", "hostId": s.host(), "sessionId": req.SessionID, "title": title})
		case <-time.After(replyTimeout):
		}

	case "toggle_pin":
		var req struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(raw, &req)
		if res := s.sessions.route(req.SessionID, false); res.Error == "" {
			select {
			case res.Inbox <- Envelope{Payload: togglePinMsg{}}:
			case <-time.After(replyTimeout):
			}
		}

	case "set_todos_open":
		var req struct {
			SessionID string `json:"sessionId"`
			Open      bool   `json:"open"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.SessionID != "" {
			if res := s.sessions.route(req.SessionID, false); res.Error == "" {
				select {
				case res.Inbox <- Envelope{Payload: todosOpenMsg{Open: req.Open}}:
				case <-time.After(replyTimeout):
				}
			}
		}

	case "configure_session":
		var req struct {
			SessionID string         `json:"sessionId"`
			Model     string         `json:"model"`
			Options   SessionOptions `json:"options"`
		}
		_ = json.Unmarshal(raw, &req)
		if res := s.sessions.route(req.SessionID, false); res.Error == "" {
			select {
			case res.Inbox <- Envelope{Payload: configureMsg{Model: req.Model, Options: req.Options}}:
			case <-time.After(replyTimeout):
			}
		}
		// The host half (rememberSelection — read back via `pull config`)
		// runs on the host lane at admission time (V2-006, see dispatch).

	case "queue_add":
		var req struct {
			SessionID     string   `json:"sessionId"`
			Text          string   `json:"text"`
			Model         string   `json:"model"`
			AttachmentIDs []string `json:"attachmentIds"`
		}
		_ = json.Unmarshal(raw, &req)
		s.actorQueueOp(req.SessionID, queueOpMsg{Op: "add", Text: req.Text, Model: req.Model, AttachmentIDs: req.AttachmentIDs})
	case "queue_remove":
		var req struct {
			SessionID string `json:"sessionId"`
			QueueID   string `json:"queueId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.actorQueueOp(req.SessionID, queueOpMsg{Op: "remove", ID: req.QueueID})
	case "queue_update":
		var req struct {
			SessionID     string   `json:"sessionId"`
			QueueID       string   `json:"queueId"`
			Text          string   `json:"text"`
			AttachmentIDs []string `json:"attachmentIds"`
		}
		_ = json.Unmarshal(raw, &req)
		s.actorQueueOp(req.SessionID, queueOpMsg{Op: "update", ID: req.QueueID, Text: req.Text, AttachmentIDs: req.AttachmentIDs})
	case "queue_send_now":
		var req struct {
			SessionID string `json:"sessionId"`
			QueueID   string `json:"queueId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onQueueSendNow(req.SessionID, req.QueueID)

	case "fork_session":
		var req struct {
			SessionID     string   `json:"sessionId"`
			Index         int      `json:"index"`
			RequestID     string   `json:"requestId"`
			EditText      string   `json:"editText"`
			EditModel     string   `json:"model"`
			YOLO          bool     `json:"yolo"`
			AttachmentIDs []string `json:"attachmentIds"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onFork(req.SessionID, req.Index, req.RequestID, req.EditText, req.EditModel, req.YOLO, req.AttachmentIDs)

	case "regenerate":
		var req struct {
			SessionID string `json:"sessionId"`
			Index     int    `json:"index"`
			Text      string `json:"text"`
			Model     string `json:"model"`
			YOLO      bool   `json:"yolo"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onRegenerate(req.SessionID, req.Index, req.Text, req.Model, req.YOLO)

	case "edit_message":
		var req struct {
			SessionID     string    `json:"sessionId"`
			Index         int       `json:"index"`
			Text          string    `json:"text"`
			Model         string    `json:"model"`
			Regen         bool      `json:"regenerate"`
			YOLO          bool      `json:"yolo"`
			AttachmentIDs *[]string `json:"attachmentIds"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onEditMessage(req.SessionID, req.Index, req.Text, req.Model, req.Regen, req.YOLO, req.AttachmentIDs)

	case "create_project":
		var req struct {
			RequestID string `json:"requestId"`
			Path      string `json:"path"`
			Name      string `json:"name"`
		}
		_ = json.Unmarshal(raw, &req)
		reply := make(chan any, 1)
		select {
		case s.projects.inbox <- Envelope{Payload: projCreateMsg{Path: req.Path, Name: req.Name, Reply: reply}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case r := <-reply:
			if m, ok := r.(map[string]any); ok {
				m["requestId"] = req.RequestID
				s.emit(m)
			}
		case <-time.After(replyTimeout):
		}

	case "delete_project":
		var req struct {
			ProjectID string `json:"projectId"`
		}
		_ = json.Unmarshal(raw, &req)
		reply := make(chan any, 1)
		select {
		case s.projects.inbox <- Envelope{Payload: projDeleteMsg{ProjectID: req.ProjectID, Reply: reply}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case r := <-reply:
			if m, ok := r.(map[string]any); ok {
				s.emit(m)
			}
		case <-time.After(replyTimeout):
		}

	case "set_project_collapsed":
		var req struct {
			ProjectID string `json:"projectId"`
			Collapsed bool   `json:"collapsed"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.ProjectID != "" {
			select {
			case s.projects.inbox <- Envelope{Payload: projCollapseMsg{ProjectID: req.ProjectID, Collapsed: req.Collapsed}}:
			case <-time.After(replyTimeout):
			}
		}

	case "bg_list":
		reply := make(chan any, 1)
		select {
		case s.bg.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case r := <-reply:
			if rows, ok := r.([]map[string]any); ok {
				s.emit(map[string]any{"type": "bg_list", "hostId": s.host(), "jobs": rows})
			}
		case <-time.After(replyTimeout):
		}

	case "bg_cancel":
		var req struct {
			JobID string `json:"jobId"`
		}
		_ = json.Unmarshal(raw, &req)
		creply := make(chan any, 1)
		select {
		case s.bg.inbox <- Envelope{Payload: bgCancelMsg{JobID: req.JobID, By: "user", Reply: creply}}:
		case <-time.After(replyTimeout):
			return
		}
		<-creply

	case "bg_tail":
		var req struct {
			JobID string `json:"jobId"`
		}
		_ = json.Unmarshal(raw, &req)
		reply := make(chan any, 1)
		select {
		case s.bg.inbox <- Envelope{Payload: bgReadMsg{JobID: req.JobID, Max: 64 * 1024, Reply: reply}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case r := <-reply:
			if m, ok := r.(map[string]any); ok {
				text, _ := m["text"].(string)
				okv, _ := m["ok"].(bool)
				_ = okv
				s.emit(map[string]any{"type": "bg_tail", "hostId": s.host(), "jobId": req.JobID, "text": text})
			}
		case <-time.After(replyTimeout):
		}

	case "tool_approval_response":
		var req struct {
			Always    bool   `json:"always"`
			SessionID string `json:"sessionId"`
			CallID    string `json:"callId"`
			Approved  bool   `json:"approved"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onApprovalResponse(req.SessionID, req.CallID, req.Approved, req.Always)

	case "question_response":
		var req struct {
			SessionID  string     `json:"sessionId"`
			QuestionID string     `json:"questionId"`
			Answers    [][]string `json:"answers"`
		}
		_ = json.Unmarshal(raw, &req)
		if res := s.sessions.route(req.SessionID, false); res.Error == "" {
			select {
			case res.Inbox <- Envelope{SessionID: req.SessionID, Payload: questionResponseMsg{ID: req.QuestionID, Answers: req.Answers}}:
			case <-time.After(replyTimeout):
			}
		}

	case "convert_response":
		var req struct {
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
			Text      string `json:"text"`
			Error     string `json:"error"`
		}
		_ = json.Unmarshal(raw, &req)
		if res := s.sessions.route(req.SessionID, false); res.Error == "" {
			select {
			case res.Inbox <- Envelope{SessionID: req.SessionID, Payload: convertResponseMsg{id: req.RequestID, text: req.Text, err: req.Error}}:
			case <-time.After(replyTimeout):
			}
		}

	case "upload_attachment":
		var req struct {
			RequestID string `json:"requestId"`
			SessionID string `json:"sessionId"`
			Name      string `json:"name"`
			Mime      string `json:"mime"`
			Data      string `json:"data"`
			Text      string `json:"text"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onUploadAttachment(req.RequestID, req.SessionID, req.Name, req.Mime, req.Data, req.Text)

	case "get_attachment":
		var req struct {
			SessionID    string `json:"sessionId"`
			AttachmentID string `json:"attachmentId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onGetAttachment(req.SessionID, req.AttachmentID)

	case "search_files":
		var req struct {
			RequestID string `json:"requestId"`
			SessionID string `json:"sessionId"`
			ProjectID string `json:"projectId"`
			Query     string `json:"query"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onSearchFiles(req.RequestID, req.SessionID, req.ProjectID, req.Query)

	case "search":
		// Removed in v2: frontend keeps the UI inert.
		var req struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(raw, &req)
		s.emit(map[string]any{"type": "search_results", "hostId": s.host(), "query": req.Query, "results": []any{}})

	case "browse_folders":
		var req struct {
			Path      string `json:"path"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		path, parent, folders, err := browseFolders(req.Path)
		response := map[string]any{"type": "folders", "hostId": s.host(), "requestId": req.RequestID, "path": path, "parent": parent, "folders": folders}
		if err != nil {
			response["error"] = err.Error()
		}
		s.emit(response)

	case "check_workspace":
		var req struct {
			RequestID string `json:"requestId"`
			SessionID string `json:"sessionId"`
			ProjectID string `json:"projectId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onCheckWorkspace(req.RequestID, req.SessionID, req.ProjectID)

	case "get_turn_changes":
		var req struct {
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onGetTurnChanges(req.SessionID, req.RequestID)

	case "undo_turn_changes":
		var req struct {
			SessionID string `json:"sessionId"`
			TurnIndex int    `json:"turnIndex"`
			Path      string `json:"path"`
			RequestID string `json:"requestId"`
		}
		_ = json.Unmarshal(raw, &req)
		s.onUndoTurnChanges(req.SessionID, req.TurnIndex, req.Path, req.RequestID)

	case "update_config":
		s.onUpdateConfig(raw)

	case "daemon_update_check":
		// Async only: checkForUpdates fetches the manifest and broadcasts
		// daemon_update at the end (dispatch must never block the read loop).
		if s.updates != nil {
			go s.updates.checkForUpdates("manual")
		}
	case "daemon_update_apply":
		// Brutal update: clean slot -> fetch app -> spawn
		// --update-start (SIGKILLs us, copies slot, runs app --update,
		// watches fail/done). Failure before the spawn aborts in place,
		// the serving WS is never dropped.
		if s.updates != nil {
			go s.updates.beginHandoff()
		}
	case "daemon_update_toggle":
		var treq struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.Unmarshal(raw, &treq)
		if s.updates != nil {
			s.updates.setAutoUpdate(treq.Enabled)
			go s.updates.checkForUpdates("toggle")
		}
	case "debug_mirror":
		// E2E forensics: report what the daemon's own download path resolves
		// (gateway base from slot config, manifest version from the daemon's
		// poll, app asset bytes head). Never fails the caller.
		if s.updates != nil {
			go s.updates.debugMirror(raw)
		}
	case "test_mcp":
		// Removed (MCP deleted): silent no-op. Emitting a replyTo-less
		// error would toast on the generic handler for no user benefit.
		_ = base
	}
}

// ---- command implementations ----

func (s *wsServer) onPrompt(sessionID, text string, attachmentIDs []string, model string, yolo bool, options *SessionOptions) {
	text = core.SanitizeUserText(text)
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		s.error(sessionID, "", "Session not found")
		return
	}
	// Slash commands are worker-side concerns in v2 (compact/clear/jail):
	// resolve them here against a refresh round-trip.
	if strings.HasPrefix(text, "/") {
		if s.onSlashCommand(res, sessionID, text) {
			return
		}
	}
	reply := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: userPromptMsg{Text: text, AttachmentIDs: attachmentIDs, Model: model, YOLO: yolo, Options: options, Reply: reply}}:
	case <-time.After(replyTimeout):
		s.error(sessionID, "", "Session busy")
		return
	}
	select {
	case r := <-reply:
		if pr, ok := r.(promptResult); ok && pr.Error != "" {
			s.error(sessionID, "", pr.Error)
		}
	case <-time.After(replyTimeout):
		s.error(sessionID, "", "Session busy")
	}
}

func (s *wsServer) actorQueueOp(sessionID string, op queueOpMsg) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	op.Reply = make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: op}:
	case <-time.After(replyTimeout):
		return
	}
	select {
	case r := <-replyOf(op):
		if qr, ok := r.(queueOpResult); ok {
			if qr.Error != "" {
				s.error(sessionID, "", qr.Error)
				return
			}
			s.emit(map[string]any{"type": "session_queue", "hostId": s.host(), "sessionId": sessionID, "queue": queuePayload(qr.Items)})
		}
	case <-time.After(replyTimeout):
	}
}

func replyOf(op queueOpMsg) chan any { return op.Reply }

func (s *wsServer) onQueueSendNow(sessionID, queueID string) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: queueSendNowMsg{QueueID: queueID}}:
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) onApprovalResponse(sessionID, callID string, approved, always bool) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	// "always allow" upgrades access first (actor applies + persists).
	if always && approved {
		done := make(chan any, 1)
		select {
		case res.Inbox <- Envelope{SessionID: sessionID, Payload: alwaysAllowMsg{Reply: done}}:
		case <-time.After(replyTimeout):
			return
		}
		select {
		case <-done:
		case <-time.After(replyTimeout):
			return
		}
	}
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: approvalResponseMsg{ID: callID, Approved: approved}}:
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) onPull(id json.RawMessage, collection string) {
	reply := func(items []map[string]any, errMsg string) {
		msg := map[string]any{"type": "pull-response", "hostId": s.host(), "id": id, "collection": collection}
		if errMsg != "" {
			msg["error"] = errMsg
		} else {
			msg["items"] = items
		}
		s.emit(msg)
	}
	switch collection {
	case "projects":
		replyCh := make(chan any, 1)
		select {
		case s.projects.inbox <- Envelope{Payload: projListMsg{Reply: replyCh}}:
		case <-time.After(replyTimeout):
			reply(nil, "projects busy")
			return
		}
		select {
		case r := <-replyCh:
			if items, ok := r.([]map[string]any); ok {
				reply(items, "")
			} else {
				reply(nil, "projects busy")
			}
		case <-time.After(replyTimeout):
			reply(nil, "projects busy")
		}
	case "sessions":
		items, err := s.sessions.mirrorSummaries()
		if err != nil {
			reply(nil, err.Error())
		} else {
			reply(items, "")
		}
	case "config":
		cfg := s.cfg.load()
		settings := HarnessSettings{}
		var last *ModelSelection
		name := ""
		if cfg != nil {
			settings = cfg.Settings
			last = cfg.LastSelection
			name = cfg.Name
		}
		reply([]map[string]any{{
			"id": "daemon", "revision": configRevision(cfg),
			"settings": settings, "lastSelection": last,
			"mcpServers": map[string]any{}, "skills": map[string]any{}, "name": name,
		}}, "")
	default:
		reply(nil, "unknown collection")
	}
}

func (s *wsServer) onFork(sessionID string, index int, requestID, editText, editModel string, yolo bool, attachmentIDs []string) {
	res := s.sessions.route(sessionID, true)
	if res.Error != "" {
		s.error(sessionID, requestID, "Session not found")
		return
	}
	newID := "sess_" + randomID8() + randomID8()
	rr := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: forkReqMsg{NewID: newID, Keep: index, Title: "", Reply: rr}}:
	case <-time.After(replyTimeout):
		s.error(sessionID, requestID, "Session busy")
		return
	}
	var fr forkResult
	select {
	case r := <-rr:
		var ok bool
		fr, ok = r.(forkResult)
		if !ok || fr.Error != "" {
			msg := "Fork failed"
			if ok {
				msg = fr.Error
			}
			s.error(sessionID, requestID, msg)
			return
		}
		// The actor wrote the forked file; route it to emit session_forked.
		nres := s.sessions.route(fr.NewID, true)
		if nres.Error != "" {
			s.error(sessionID, requestID, "Fork failed")
			return
		}
		nr := make(chan any, 1)
		select {
		case nres.Inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: nr}}:
		case <-time.After(replyTimeout):
			s.error(sessionID, requestID, "Fork failed")
			return
		}
		select {
		case r2 := <-nr:
			if rd, ok := r2.(readResult); ok && rd.Error == "" {
				if rec, ok := rd.Payload.(*SessionRecord); ok {
					s.emit(map[string]any{"type": "session_forked", "requestId": requestID, "hostId": s.host(), "session": sessionPayloadPaged(rec, 0)})
					s.notifyChange("sessions")
					if strings.TrimSpace(editText) != "" || attachmentIDs != nil {
						s.truncateAndRun(fr.NewID, len(rec.Messages), editText, editModel, yolo, attachmentIDs)
					}
					return
				}
			}
			s.error(sessionID, requestID, "Fork failed")
		case <-time.After(replyTimeout):
			s.error(sessionID, requestID, "Fork failed")
		}
	case <-time.After(replyTimeout):
		s.error(sessionID, requestID, "Session busy")
	}
}

func (s *wsServer) onRegenerate(sessionID string, index int, text, model string, yolo bool) {
	// Last user message at/before index, drop it + tail, re-run with its text.
	rec := s.readRecord(sessionID)
	if rec == nil {
		return
	}
	upper := index
	if upper >= len(rec.Messages) || upper < 0 {
		upper = len(rec.Messages) - 1
	}
	userIdx := -1
	userText := ""
	for i := upper; i >= 0; i-- {
		if rec.Messages[i].Role == provider.RoleUser {
			var parts []string
			for _, c := range rec.Messages[i].Content {
				if tb, ok := c.(provider.TextBlock); ok && strings.TrimSpace(tb.Text) != "" {
					parts = append(parts, tb.Text)
				}
			}
			if len(parts) > 0 {
				userText = core.StripLeadingSystemPrompt(strings.Join(parts, "\n"))
				userIdx = i
				break
			}
		}
	}
	if userText == "" && strings.TrimSpace(text) != "" {
		userText = core.StripLeadingSystemPrompt(strings.TrimSpace(text))
	}
	if userIdx < 0 || userText == "" {
		return
	}
	s.truncateAndRun(sessionID, userIdx, messageUserText(rec.Messages[userIdx]), model, yolo, messageAttachmentIDs(rec.Messages[userIdx], rec.Attachments))
}

func (s *wsServer) onEditMessage(sessionID string, index int, text, model string, regen bool, yolo bool, attachmentIDs *[]string) {
	rec := s.readRecord(sessionID)
	if rec == nil || index < 0 || index >= len(rec.Messages) {
		return
	}
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	// Must be idle.
	repCh := make(chan any, 1)
	res.Control <- watchdogPingMsg{Reply: repCh}
	state := ""
	select {
	case r := <-repCh:
		if rep, ok := r.(watchdogReport); ok {
			state = rep.State
		}
	case <-time.After(replyTimeout):
		return
	}
	if state != stateIdle {
		s.error(sessionID, "", "Stop the current turn before editing")
		return
	}
	msg := rec.Messages[index]
	if msg.Role != provider.RoleUser {
		return
	}
	text = core.SanitizeUserText(text)
	ids := messageAttachmentIDs(msg, rec.Attachments)
	if attachmentIDs != nil {
		ids = *attachmentIDs
	}
	if err := validateAttachmentIDs(rec, ids); err != nil {
		s.error(sessionID, "", err.Error())
		return
	}
	if strings.TrimSpace(text) == "" && len(ids) == 0 {
		s.error(sessionID, "", "Message cannot be empty")
		return
	}
	if regen {
		s.truncateAndRun(sessionID, index, text, model, yolo, ids)
		return
	}
	er := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: editApplyMsg{Index: index, Text: text, AttachmentIDs: ids, Reply: er}}:
	case <-time.After(replyTimeout):
		return
	}
	select {
	case r := <-er:
		if er2, ok := r.(editApplyResult); ok && er2.Error == "" {
			s.notifyChange("sessions")
		} else if ok && er2.Error != "" {
			s.error(sessionID, "", er2.Error)
		}
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) readRecord(sessionID string) *SessionRecord {
	res := s.sessions.route(sessionID, true)
	if res.Error != "" {
		return nil
	}
	rr := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{Payload: readReqMsg{What: "data", Reply: rr}}:
	case <-time.After(replyTimeout):
		// Fall back to disk (passivated or busy).
		if rec, _, err := newDiskStore(s.dataDir).loadSessionFused(sessionID); err == nil {
			return rec
		}
		return nil
	}
	select {
	case r := <-rr:
		if rd, ok := r.(readResult); ok && rd.Error == "" {
			if rec, ok := rd.Payload.(*SessionRecord); ok {
				return rec
			}
		}
	case <-time.After(replyTimeout):
	}
	if rec, _, err := newDiskStore(s.dataDir).loadSessionFused(sessionID); err == nil {
		return rec
	}
	return nil
}

func (s *wsServer) truncateAndRun(sessionID string, index int, text, model string, yolo bool, attachmentIDs []string) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	er := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: editRegenerateMsg{Keep: index, AttachmentIDs: attachmentIDs, Model: model, Reply: er}}:
	case <-time.After(replyTimeout):
		return
	}
	select {
	case r := <-er:
		if pr, ok := r.(promptResult); ok && pr.Error == "" {
			// Start the turn with the truncated text.
			pr2 := make(chan any, 1)
			select {
			case res.Inbox <- Envelope{SessionID: sessionID, Payload: userPromptMsg{Text: text, AttachmentIDs: attachmentIDs, Model: model, YOLO: yolo, Reply: pr2}}:
			case <-time.After(replyTimeout):
				return
			}
			select {
			case r2 := <-pr2:
				if prr, ok := r2.(promptResult); ok && prr.Error != "" {
					s.error(sessionID, "", prr.Error)
				}
			case <-time.After(replyTimeout):
			}
		} else if ok && pr.Error != "" {
			s.error(sessionID, "", pr.Error)
		}
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) onSlashCommand(res spawnResult, sessionID, text string) bool {
	// v2 slash subset: /clear /compact /jail /unjail /help. /skills /mcp gone.
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "/clear":
		s.truncateAndRun(sessionID, 0, "", "", false, nil)
		return true
	case "/compact":
		select {
		case res.Inbox <- Envelope{SessionID: sessionID, Payload: compactNowMsg{}}:
		case <-time.After(replyTimeout):
		}
		return true
	case "/jail", "/unjail":
		select {
		case res.Inbox <- Envelope{SessionID: sessionID, Payload: jailMsg{Jail: fields[0] == "/jail"}}:
		case <-time.After(replyTimeout):
		}
		return true
	case "/help":
		// v1 parity: /help is a transcript turn (user command + canned
		// assistant reply), not a transient toast. The frontend and the
		// black-box tests both rely on it as a deterministic, model-free
		// way to seed a [user, assistant] pair.
		s.slashReply(sessionID, text, "### ⚡ Indirect Code Slash Commands\n"+
			"- `/compact` — Summarize and compact conversation to free up context\n"+
			"- `/clear` — Start a fresh blank session (history is kept)\n"+
			"- `/jail` — Confine agent tools strictly to session directory\n"+
			"- `/unjail` — Allow agent tools to read/write external paths")
		return true
	}
	return false
}

// slashReply appends a deterministic user/assistant pair to the transcript
// (no model call) and pushes the tail to clients. Kept actor-owned so the
// record stays single-writer; v1 did the same under the session lock.
func (s *wsServer) slashReply(sessionID, command, reply string) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		s.error(sessionID, "", "Session not found")
		return
	}
	er := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: slashReplyMsg{Command: core.SanitizeUserText(command), Reply: reply, Ack: er}}:
	case <-time.After(replyTimeout):
		s.error(sessionID, "", "Session busy")
		return
	}
	select {
	case <-er:
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) onUploadAttachment(requestID, sessionID, name, mime, data, text string) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		s.error(sessionID, requestID, "Session not found")
		return
	}
	rr := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: attachUploadMsg{Name: name, Mime: mime, Data: data, Text: text, Reply: rr}}:
	case <-time.After(replyTimeout):
		s.error(sessionID, requestID, "Session busy")
		return
	}
	select {
	case r := <-rr:
		if ar, ok := r.(attachUploadResult); ok {
			if ar.Error != "" {
				s.error(sessionID, requestID, ar.Error)
				return
			}
			s.emit(map[string]any{"type": "attachment_uploaded", "requestId": requestID, "hostId": s.host(), "sessionId": sessionID, "attachment": ar.Attachment})
		}
	case <-time.After(replyTimeout):
		s.error(sessionID, requestID, "Session busy")
	}
}

func (s *wsServer) onGetAttachment(sessionID, attachmentID string) {
	rec := s.readRecord(sessionID)
	if rec == nil {
		return
	}
	for _, a := range rec.Attachments {
		if a.ID != attachmentID {
			continue
		}
		// v1 parity: the payload carries the file bytes (base64) plus the
		// extracted text. v2 emitted only the ref, so clients got no data.
		payload := map[string]any{"id": a.ID, "name": a.Name, "mime": a.Mime, "size": a.Size}
		if data, err := os.ReadFile(a.Path); err == nil {
			payload["data"] = base64.StdEncoding.EncodeToString(data)
		}
		if a.TextPath != "" {
			if text, err := os.ReadFile(a.TextPath); err == nil {
				chars := []rune(string(text))
				if len(chars) > 256*1024 {
					chars = chars[:256*1024]
					payload["textTruncated"] = true
				}
				payload["text"] = string(chars)
			}
		}
		s.emit(map[string]any{"type": "attachment_data", "hostId": s.host(), "sessionId": sessionID, "attachment": payload})
		return
	}
}

func (s *wsServer) onSearchFiles(requestID, sessionID, projectID, query string) {
	root := ""
	if sessionID != "" {
		if rec := s.readRecord(sessionID); rec != nil {
			root = rec.CWD
		}
	}
	if root == "" && projectID != "" {
		reply := make(chan any, 1)
		select {
		case s.projects.inbox <- Envelope{Payload: projListMsg{Reply: reply}}:
		case <-time.After(replyTimeout):
		}
		select {
		case r := <-reply:
			if items, ok := r.([]map[string]any); ok {
				for _, it := range items {
					if it["id"] == projectID {
						root, _ = it["path"].(string)
					}
				}
			}
		case <-time.After(replyTimeout):
		}
	}
	payload := map[string]any{"type": "file_matches", "hostId": s.host(), "requestId": requestID, "sessionId": sessionID, "files": []string{}}
	if root == "" {
		payload["error"] = "Select an available project to mention files"
	} else if files, truncated, err := mentionFiles(root, query); err != nil {
		payload["error"] = "Could not search this workspace"
	} else {
		payload["files"] = files
		payload["truncated"] = truncated
	}
	s.emit(payload)
}

func (s *wsServer) onCheckWorkspace(requestID, sessionID, projectID string) {
	cwd := ""
	if sessionID != "" {
		if rec := s.readRecord(sessionID); rec != nil {
			cwd = rec.CWD
		}
	}
	if cwd == "" && projectID != "" {
		reply := make(chan any, 1)
		select {
		case s.projects.inbox <- Envelope{Payload: projListMsg{Reply: reply}}:
		case <-time.After(replyTimeout):
		}
		select {
		case r := <-reply:
			if items, ok := r.([]map[string]any); ok {
				for _, it := range items {
					if it["id"] == projectID {
						cwd, _ = it["path"].(string)
					}
				}
			}
		case <-time.After(replyTimeout):
		}
	}
	if cwd == "" {
		return
	}
	info := inspectWorkspace(cwd)
	s.emit(map[string]any{"type": "workspace_status", "requestId": requestID, "hostId": s.host(), "workspace": map[string]any{"status": info.Status, "path": cwd}})
}

func (s *wsServer) onGetTurnChanges(sessionID, requestID string) {
	rec := s.readRecord(sessionID)
	if rec == nil {
		return
	}
	s.emit(map[string]any{"type": "turn_changes", "hostId": s.host(), "sessionId": sessionID, "requestId": requestID, "balloons": fileBalloonPayloads(rec.FileBalloons)})
}

func (s *wsServer) onUndoTurnChanges(sessionID string, turnIndex int, path, requestID string) {
	res := s.sessions.route(sessionID, false)
	if res.Error != "" {
		return
	}
	rr := make(chan any, 1)
	select {
	case res.Inbox <- Envelope{SessionID: sessionID, Payload: undoMsg{TurnIndex: turnIndex, Path: path, Reply: rr}}:
	case <-time.After(replyTimeout):
		return
	}
	select {
	case r := <-rr:
		if ur, ok := r.(undoResult); ok {
			msg := map[string]any{"type": "turn_changes_undone", "hostId": s.host(), "sessionId": sessionID, "requestId": requestID, "turnIndex": turnIndex, "results": ur.Results, "complete": ur.Complete}
			if ur.Error != "" {
				msg["error"] = ur.Error
			}
			if ur.Warning != "" {
				msg["warning"] = ur.Warning
			}
			s.emit(msg)
			if ur.Error == "" {
				s.notifyChange("sessions")
			}
		}
	case <-time.After(replyTimeout):
	}
}

func (s *wsServer) onUpdateConfig(raw []byte) {
	var req struct {
		RequestID string         `json:"requestId"`
		Settings  map[string]any `json:"settings"`
	}
	_ = json.Unmarshal(raw, &req)
	// v2: settings only (mcpServers/skills ignored — removed domains).
	cfg := s.cfg.load()
	if cfg == nil {
		s.emit(map[string]any{"type": "config_updated", "requestId": req.RequestID, "hostId": s.host(), "success": false, "error": "no config"})
		return
	}
	next := *cfg
	applySettingsMap(&next.Settings, req.Settings)
	next.Settings = normalizedHarness(next.Settings)
	s.cfg.store(&next)
	cfgDir := s.configDir
	if cfgDir == "" {
		cfgDir = s.dataDir
	}
	if err := saveDaemonConfig(cfgDir, &next); err != nil {
		s.emit(map[string]any{"type": "config_updated", "requestId": req.RequestID, "hostId": s.host(), "success": false, "error": err.Error()})
		return
	}
	s.emit(map[string]any{"type": "config_updated", "requestId": req.RequestID, "hostId": s.host(), "success": true, "revision": configRevision(&next)})
	s.notifyChange("config")
}

// rememberSelection persists the last explicit model/options choice as the
// default for new sessions (v1 parity: pull config exposes lastSelection).
func (s *wsServer) rememberSelection(model string, options SessionOptions) {
	cfg := s.cfg.load()
	if cfg == nil {
		return
	}
	if model == "" && cfg.LastSelection != nil {
		model = cfg.LastSelection.Model
	}
	next := *cfg
	next.LastSelection = &ModelSelection{Model: model, SessionOptions: normalizedOptions(options)}
	s.cfg.store(&next)
	cfgDir := s.configDir
	if cfgDir == "" {
		cfgDir = s.dataDir
	}
	_ = saveDaemonConfig(cfgDir, &next)
}
