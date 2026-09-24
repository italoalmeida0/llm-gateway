package main

import "sync"

// root wires every actor together and owns shutdown. No global lock:
// each actor owns its state; the root only passes constructor callbacks.

type root struct {
	dataDir    string
	configPath string

	cfg configCell

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
	r.server.onRemoteKill = r.shutdown

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
