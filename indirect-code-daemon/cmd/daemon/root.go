package main

import (
	"fmt"
	"sync"
	"time"
)

// root wires every actor together and owns shutdown. No global lock:
// each actor owns its state; the root only passes constructor callbacks.

type root struct {
	dataDir    string
	configPath string

	cfg configCell

	// health is the root watchdog state (plan §5.4): last ping round over
	// the infra actors. Served on the health endpoint (see health.go).
	healthMu   sync.Mutex
	healthLast map[string]infraHealth
	healthAt   int64

	sessionSup *sessionSupervisor
	bgSup      *bgSupervisor
	ws         *wsActor
	projects   *projectsActor
	server     *wsServer
	admin      *sessionAdmin
	wg         sync.WaitGroup
}

func newRoot(dataDir string) *root {
	return &root{dataDir: dataDir}
}

// bootActors starts the four actors (called by main after pairing/config).
func (r *root) bootActors() {

	r.ws = newWSActor()
	r.bgSup = newBGSupervisor(r.dataDir)
	r.projects = newProjectsActor(r.dataDir)
	r.sessionSup = newSessionSupervisor(r.dataDir, &r.cfg, r.ws, r.bgSup)

	hostOf := func() string {
		if cfg := r.cfg.load(); cfg != nil {
			return cfg.HostID
		}
		return ""
	}
	emitTo := func(ev any) { r.ws.emit(ev) }
	notifyTo := func(collection string) {
		if r.server != nil {
			r.server.notifyChange(collection)
		}
	}

	// Session supervisor callbacks.
	r.sessionSup.emitFn = emitTo
	r.sessionSup.notifyFn = notifyTo

	// BG supervisor callbacks.
	r.bgSup.hostID = hostOf
	r.bgSup.emit = emitTo
	r.bgSup.session = func(id string) (chan Envelope, chan any, bool) {
		res := r.sessionSup.route(id, false)
		if res.Error != "" {
			return nil, nil, false
		}
		return res.Inbox, res.Control, true
	}

	// Admin + projects callbacks.
	r.admin = &sessionAdmin{
		dataDir: r.dataDir,
		route:   r.sessionSup.route,
		cfg:     &r.cfg,
		emit:    emitTo,
		onEvent: notifyTo,
		bg:      r.bgSup,
	}
	r.admin.purge = r.admin.purgeSession
	r.projects.emit = emitTo
	r.projects.hostID = hostOf
	r.projects.onEvent = notifyTo
	r.projects.purgeSession = r.admin.purgeSession

	// WS dispatch server.
	r.server = newWSServer(r.dataDir, &r.cfg, r.sessionSup, r.bgSup, r.projects, r.admin, r.ws)
	r.server.root = r
	r.server.configDir = r.configPathDir()
	r.server.onRemoteKill = r.shutdown

	// Root watchdog (plan §5.4): ping infra actors, remember the round.
	go r.watchdogLoop()

	for _, child := range []interface{ run(*sync.WaitGroup) }{
		r.projects, r.ws, r.bgSup, r.sessionSup,
	} {
		r.wg.Add(1)
		go child.run(&r.wg)
	}
}

func defaultConfig() *DaemonConfig {
	return &DaemonConfig{Settings: HarnessSettings{}}
}

// infraHealth is one actor's answer to a root ping round.
type infraHealth struct {
	Alive      bool  `json:"alive"`
	QueueDepth int   `json:"queueDepth"`
	Dropped    int64 `json:"dropped,omitempty"`
	Jobs       int   `json:"jobs,omitempty"`
}

// watchdogLoop pings bg/projects/ws every 30s. A silent actor is logged;
// recovery is restart-scoped (a wedged infra actor cannot self-heal, and
// the process manager owns full restarts). Sessions have their own
// supervisor watchdog; this covers the infra the plan §5.4 requires.
func (r *root) watchdogLoop() {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for range tick.C {
		round := map[string]infraHealth{}
		// bg supervisor: list round-trips the mailbox (alive + depth proxy).
		bgOK := false
		bgJobs := 0
		func() {
			defer func() { _ = recover() }()
			reply := make(chan any, 1)
			select {
			case r.bgSup.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}:
			case <-time.After(5 * time.Second):
				return
			}
			select {
			case resp := <-reply:
				if rows, ok := resp.([]map[string]any); ok {
					bgOK = true
					bgJobs = len(rows)
				}
			case <-time.After(5 * time.Second):
			}
		}()
		round["bg"] = infraHealth{Alive: bgOK, Jobs: bgJobs}
		// projects actor: list round-trip.
		projOK := false
		func() {
			defer func() { _ = recover() }()
			reply := make(chan any, 1)
			select {
			case r.projects.inbox <- Envelope{Payload: projListMsg{Reply: reply}}:
			case <-time.After(5 * time.Second):
				return
			}
			select {
			case <-reply:
				projOK = true
			case <-time.After(5 * time.Second):
			}
		}()
		round["projects"] = infraHealth{Alive: projOK}
		// ws actor: stats ping.
		wsH := infraHealth{}
		func() {
			defer func() { _ = recover() }()
			reply := make(chan any, 1)
			select {
			case r.ws.control <- wsPingMsg{Reply: reply}:
			case <-time.After(5 * time.Second):
				return
			}
			select {
			case resp := <-reply:
				if st, ok := resp.(wsStats); ok {
					wsH = infraHealth{Alive: true, QueueDepth: st.QueueDepth, Dropped: st.Dropped}
				}
			case <-time.After(5 * time.Second):
			}
		}()
		round["ws"] = wsH
		r.healthMu.Lock()
		r.healthLast = round
		r.healthAt = time.Now().UnixMilli()
		r.healthMu.Unlock()
		for name, h := range round {
			if !h.Alive {
				fmt.Printf("[WARN] root watchdog: infra actor %q unresponsive\n", name)
			}
		}
	}
}

// healthSnapshot returns the last infra ping round (nil before first round).
func (r *root) healthSnapshot() (map[string]infraHealth, int64) {
	r.healthMu.Lock()
	defer r.healthMu.Unlock()
	return r.healthLast, r.healthAt
}
