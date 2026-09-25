package main

import (
	"compress/flate"
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DaemonServer is the brutal-update protocol host. The v1 name is kept on
// purpose so the ported update files (the v1.0.28 update reformulation:
// handoff.go + update.go + update_flow.go) read exactly as designed; this
// file only adapts them to the actor daemon's plumbing:
//
//   - paths/config/pid come from `root` (same loadConfig/writePidFile the
//     daemon already uses);
//   - sendWS rides the serving daemon's gateway link actor (or the
//     updater's own ?updating=1 socket in --update-start mode);
//   - the update flow NEVER touches session state — SIGKILL + crash
//     recovery is the resume mechanism (see update_flow.go philosophy).
type DaemonServer struct {
	root *root
	// cell is the config view (the serving daemon shares its root cell so
	// the autoUpdate toggle and settings writes stay coherent).
	cell *configCell

	configPath string
	dataDir    string
	// sharedDir roots <root>/external (python, unish). Set once at boot
	// from the slot dataDir; the daemon never guesses it elsewhere.
	sharedDir string

	wsMu   sync.Mutex
	wsConn *websocket.Conn

	// Self-update runtime (see update.go).
	updateMu sync.Mutex
	update   *updateState

	// emitLive routes sendWS through the serving daemon's gateway link.
	// Nil in the naive updater / --update-end paths, which own wsConn.
	emitLive func(any)
}

// newUpdateHost builds a standalone update host (the --update-start naive
// updater loads nothing else: zero sessions, zero actors).
func newUpdateHost(dataDir, configPath string) *DaemonServer {
	r := newRoot(dataDir)
	r.configPath = configPath
	return attachUpdateHost(r)
}

// attachUpdateHost wraps the serving daemon's root as the update host.
func attachUpdateHost(r *root) *DaemonServer {
	return &DaemonServer{root: r, cell: &r.cfg, dataDir: r.dataDir}
}

// configNow is the current config view (nil until loadConfig succeeds).
func (d *DaemonServer) configNow() *DaemonConfig {
	if d.cell == nil {
		return nil
	}
	return d.cell.load()
}

// rootDir is derived from the CURRENT dataDir (tests and the update flow
// re-point dataDir at a slot dir after construction).
func (d *DaemonServer) rootDir() string {
	if filepath.Base(filepath.Dir(d.dataDir)) == "slots" {
		return filepath.Dir(filepath.Dir(d.dataDir))
	}
	return d.dataDir
}

func (d *DaemonServer) loadConfig() error { return d.root.loadConfig() }

// sessionsDir is canonical: the daemon runs with dataDir = the slot dir
// (<root>/slots/slot-a|b), so sessions live at <slot>/sessions.
func (d *DaemonServer) sessionsDir() string { return filepath.Join(d.dataDir, "sessions") }

func (d *DaemonServer) pidFile() string { return filepath.Join(d.dataDir, "daemon.pid") }

// writePidFile claims the slot pidfile (--stop / install scripts / the
// update flow all find the live process through it).
func (d *DaemonServer) writePidFile() {
	if err := os.MkdirAll(d.dataDir, 0o700); err != nil {
		return
	}
	_ = os.WriteFile(d.pidFile(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

// setAutoUpdate persists the apply toggle (default true when unset).
func (d *DaemonServer) setAutoUpdate(enabled bool) {
	cfg := d.configNow()
	if cfg == nil {
		return
	}
	next := *cfg
	next.AutoUpdate = &enabled
	d.cell.store(&next)
	_ = saveDaemonConfig(d.root.configPathDir(), &next)
}

// sendWS pushes a daemon->frontend event: on the socket THIS host owns
// (the --update-end hello / the naive updater's ?updating=1 conn) first —
// v1 semantics: the promote's update_done must ride the hello socket,
// which is the only live one before the link loop starts. When the host
// owns none (serving daemon's update broadcasts), fall back to the live
// gateway link actor.
func (d *DaemonServer) sendWS(msg any) error {
	d.wsMu.Lock()
	conn := d.wsConn
	d.wsMu.Unlock()
	if conn != nil {
		return conn.WriteJSON(msg)
	}
	if d.emitLive != nil {
		d.emitLive(msg)
		return nil
	}
	return fmt.Errorf("no relay socket")
}

// connectWebSocketOnce dials the relay, takes the socket (so a later
// sendWS/update_done rides it), and returns. One shot: no read loop, no
// retry, no reconnect — the caller decides what failure means. Used by
// --update-end's best-effort hello (promote runs either way).
func (d *DaemonServer) connectWebSocketOnce() error {
	cfg := d.configNow()
	if cfg == nil {
		return fmt.Errorf("no config")
	}
	u, err := url.Parse(cfg.GatewayURL)
	if err != nil {
		return err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/indirect-code/daemon/ws?token=%s", scheme, u.Host, url.QueryEscape(cfg.DaemonToken))
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, EnableCompression: true}
	conn, resp, err := dialer.Dial(wsURL, nil)
	if err != nil {
		if isRevokedDialError(resp, err) {
			return errDaemonRevoked
		}
		return err
	}
	d.wsMu.Lock()
	if d.wsConn != nil {
		_ = d.wsConn.Close()
	}
	d.wsConn = conn
	// Transcript JSON compresses 5-10x; BestSpeed keeps added latency
	// sub-ms while shrinking bursts. Noop if no permessage-deflate.
	_ = conn.SetCompressionLevel(flate.BestSpeed)
	d.wsMu.Unlock()
	fmt.Printf("[CONNECTED] Connected to gateway at %s\n", cfg.GatewayURL)
	return nil
}

// connectWebSocketWithQuery dials the relay with an extra query suffix
// (e.g. "&updating=1" for the --update-start naive updater: the relay
// keeps the host registered but broadcasts host_status updating so the
// frontend shows the update overlay instead of offline).
func (d *DaemonServer) connectWebSocketWithQuery(extra string) error {
	return d.connectWebSocketContext(context.Background(), extra)
}

// connectWebSocketContext blocks on the socket until it drops. The naive
// updater answers nothing (the relay blocks client->daemon traffic during
// ?updating=1), so inbound messages are read and discarded — the socket
// being OPEN is the whole point.
func (d *DaemonServer) connectWebSocketContext(ctx context.Context, extra string) error {
	cfg := d.configNow()
	if cfg == nil {
		return fmt.Errorf("no config")
	}
	u, err := url.Parse(cfg.GatewayURL)
	if err != nil {
		return err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/indirect-code/daemon/ws?token=%s%s", scheme, u.Host, url.QueryEscape(cfg.DaemonToken), extra)

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, EnableCompression: true}
	// Gorilla's DialContext bounds the handshake deadline but does not
	// close a TCP connection when cancellation lands during the HTTP read.
	// Bind the raw socket too, so updater shutdown joins promptly.
	var stopDialClose func() bool
	dialer.NetDialContext = func(dialCtx context.Context, network, addr string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(dialCtx, network, addr)
		if err == nil {
			stopDialClose = context.AfterFunc(ctx, func() { _ = conn.Close() })
		}
		return conn, err
	}
	defer func() {
		if stopDialClose != nil {
			stopDialClose()
		}
	}()

	conn, resp, err := dialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		if isRevokedDialError(resp, err) {
			// Host deleted while offline: token no longer exists
			// server-side. Surface the sentinel so callers exit instead
			// of spinning as a ghost process.
			fmt.Println("[REVOKED] This host was removed from the gateway. Exiting (re-pair to reconnect).")
			return errDaemonRevoked
		}
		return err
	}

	d.wsMu.Lock()
	if d.wsConn != nil {
		_ = d.wsConn.Close()
	}
	d.wsConn = conn
	_ = conn.SetCompressionLevel(flate.BestSpeed)
	d.wsMu.Unlock()
	defer func() {
		_ = conn.Close()
		d.wsMu.Lock()
		if d.wsConn == conn {
			d.wsConn = nil
		}
		d.wsMu.Unlock()
	}()

	fmt.Printf("[CONNECTED] Connected to gateway at %s\n", cfg.GatewayURL)
	// Fresh (re)connect: re-check for updates + push state to clients.
	go d.checkForUpdates("reconnect")

	ticker := time.NewTicker(15 * time.Second)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second)); err != nil {
					conn.Close()
					return
				}
			case <-done:
				return
			}
		}
	}()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			close(done)
			ticker.Stop()
			return err
		}
	}
}
