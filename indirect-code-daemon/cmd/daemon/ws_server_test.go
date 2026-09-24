package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// wsHarness wires a full in-memory stack: supervisor + bg + projects +
// admin + ws actor (capture send) + dispatch server. No sockets, no network.
type wsHarness struct {
	dir      string
	sup      *sessionSupervisor
	bg       *bgSupervisor
	projects *projectsActor
	admin    *sessionAdmin
	ws       *wsActor
	server   *wsServer
	cfg      *configCell

	mu   sync.Mutex
	sent []map[string]any
	wg   sync.WaitGroup
}

func newWSHarness(t *testing.T) *wsHarness {
	t.Helper()
	dir := t.TempDir()
	cfg := &configCell{}
	cfg.store(&DaemonConfig{HostID: "h", GatewayURL: "http://127.0.0.1:1"})
	h := &wsHarness{dir: dir, cfg: cfg}
	h.ws = newWSActor()
	h.ws.send = func(msg any) error {
		if m, ok := msg.(map[string]any); ok {
			h.mu.Lock()
			h.sent = append(h.sent, m)
			h.mu.Unlock()
		}
		return nil
	}
	h.bg = newBGSupervisor(dir)
	h.projects = newProjectsActor(dir)
	h.sup = newSessionSupervisor(dir, cfg, h.ws, h.bg)
	emit := func(ev any) { h.ws.emit(ev) }
	notify := func(c string) {}
	h.sup.emitFn = emit
	h.sup.notifyFn = notify
	h.bg.hostID = func() string { return "h" }
	h.bg.emit = emit
	h.bg.session = func(id string) (chan Envelope, chan any, bool) {
		res := h.sup.route(id, false)
		if res.Error != "" {
			return nil, nil, false
		}
		return res.Inbox, res.Control, true
	}
	h.admin = &sessionAdmin{dataDir: dir, route: h.sup.route, cfg: cfg, emit: emit, onEvent: notify, bg: h.bg}
	h.admin.purge = h.admin.purgeSession
	h.projects.emit = emit
	h.projects.hostID = func() string { return "h" }
	h.projects.purgeSession = h.admin.purgeSession
	h.server = newWSServer(dir, cfg, h.sup, h.bg, h.projects, h.admin, h.ws)
	for _, child := range []interface{ run(*sync.WaitGroup) }{h.projects, h.ws, h.bg, h.sup} {
		h.wg.Add(1)
		go child.run(&h.wg)
	}
	t.Cleanup(func() {
		h.projects.control <- shutdownMsg{}
		h.ws.control <- shutdownMsg{}
		h.bg.control <- shutdownMsg{}
		// Passivate every resident first so WAL handles close and the
		// sessions dir is quiescent before TempDir removal.
		h.sup.control <- passivateMsg{}
		time.Sleep(200 * time.Millisecond)
		h.sup.control <- shutdownMsg{}
		h.wg.Wait()
	})
	return h
}

func (h *wsHarness) send(cmd map[string]any) {
	raw, _ := json.Marshal(cmd)
	h.server.dispatch(raw)
}

func (h *wsHarness) lastType(typ string) map[string]any {
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.mu.Lock()
		for i := len(h.sent) - 1; i >= 0; i-- {
			if h.sent[i]["type"] == typ {
				m := h.sent[i]
				h.mu.Unlock()
				return m
			}
		}
		h.mu.Unlock()
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (h *wsHarness) mkSession(t *testing.T, id string) {
	t.Helper()
	st := newDiskStore(h.dir)
	rec := &SessionRecord{ID: id, CWD: "/tmp", Title: "t", Model: "m", Status: "idle", CreatedAt: 1, UpdatedAt: 1}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
}

func TestWSCreatePromptCancel(t *testing.T) {
	h := newWSHarness(t)
	h.send(map[string]any{"type": "create_session", "requestId": "r1", "cwd": "/tmp", "title": "s", "model": "m", "options": map[string]any{}})
	created := h.lastType("session_created")
	if created == nil {
		t.Fatalf("no session_created")
	}
	sess := created["session"].(map[string]any)
	id, _ := sess["id"].(string)
	if id == "" {
		t.Fatalf("no id: %+v", created)
	}
	// Prompt with blocking worker? Default worker runs the REAL agent loop
	// (network) — instead prompt empty text is rejected fast... use cancel path:
	// cancel on idle is a no-op but must not error.
	h.send(map[string]any{"type": "cancel", "sessionId": id})
	// get_session round-trips through the actor.
	h.send(map[string]any{"type": "get_session", "sessionId": id, "requestId": "r2"})
	got := h.lastType("session_data")
	if got == nil {
		t.Fatalf("no session_data")
	}
}

func TestWSRenamePinTodos(t *testing.T) {
	h := newWSHarness(t)
	h.mkSession(t, "s1")
	h.send(map[string]any{"type": "rename_session", "sessionId": "s1", "title": "New Title"})
	if m := h.lastType("session_renamed"); m == nil {
		t.Fatalf("no session_renamed")
	}
	h.send(map[string]any{"type": "toggle_pin", "sessionId": "s1"})
	h.send(map[string]any{"type": "set_todos_open", "sessionId": "s1", "open": true})
	h.send(map[string]any{"type": "get_session", "sessionId": "s1", "requestId": "r"})
	got := h.lastType("session_data")
	if got == nil {
		t.Fatalf("no session_data")
	}
	sess := got["session"].(map[string]any)
	if sess["title"] != "New Title" {
		t.Fatalf("title not applied: %+v", sess["title"])
	}
}

func TestWSQueueOps(t *testing.T) {
	h := newWSHarness(t)
	h.mkSession(t, "s1")
	h.send(map[string]any{"type": "queue_add", "sessionId": "s1", "text": "hello"})
	q := h.lastType("session_queue")
	if q == nil {
		t.Fatalf("no session_queue")
	}
	h.send(map[string]any{"type": "get_history", "sessionId": "s1", "beforeTurn": 1})
}

func TestWSProjects(t *testing.T) {
	h := newWSHarness(t)
	sub, _ := os.MkdirTemp("", "proj")
	defer os.RemoveAll(sub)
	target := filepath.Join(sub, "proj1")
	h.send(map[string]any{"type": "create_project", "requestId": "r1", "path": target})
	if m := h.lastType("project_created"); m == nil {
		t.Fatalf("no project_created")
	}
	h.send(map[string]any{"type": "pull", "collection": "projects", "id": 7})
	if m := h.lastType("pull-response"); m == nil {
		t.Fatalf("no pull-response")
	}
}

func TestWSSearchRemoved(t *testing.T) {
	h := newWSHarness(t)
	h.send(map[string]any{"type": "search", "query": "foo", "limit": 5})
	m := h.lastType("search_results")
	if m == nil {
		t.Fatalf("no search_results")
	}
	if results, _ := m["results"].([]any); len(results) != 0 {
		t.Fatalf("search should be empty in v2, got %+v", results)
	}
}

func TestWSBgListTail(t *testing.T) {
	h := newWSHarness(t)
	h.send(map[string]any{"type": "bg_list"})
	if m := h.lastType("bg_list"); m == nil {
		t.Fatalf("no bg_list")
	}
}

func TestWSPullSessions(t *testing.T) {
	h := newWSHarness(t)
	h.mkSession(t, "s9")
	h.send(map[string]any{"type": "pull", "collection": "sessions", "id": 3})
	m := h.lastType("pull-response")
	if m == nil {
		t.Fatalf("no pull-response")
	}
	items, _ := m["items"].([]map[string]any)
	if len(items) != 1 {
		t.Fatalf("want 1 session, got %+v", m)
	}
}

func TestHealthDispatch(t *testing.T) {
	h := newWSHarness(t)
	r := &root{}
	r.cfg.store(&DaemonConfig{HostID: "h"})
	h.server.root = r
	h.cfg.store(&DaemonConfig{HostID: "h"})
	h.send(map[string]any{"type": "health"})
	deadline := time.Now().Add(3 * time.Second)
	for {
		h.mu.Lock()
		found := false
		for _, m := range h.sent {
			if m["type"] == "health" {
				found = true
			}
		}
		h.mu.Unlock()
		if found {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("no health reply")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
