package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/gorilla/websocket"
	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// Standby mode (update takeover), v2: the new daemon loads the migrated
// slot storage, SHADOW-connects to the gateway (?shadow=1: tracked, never
// routed, never flips status — the old daemon still owns the host), writes
// serving.json (proof, WITH post-WS timestamp), and waits. On handoff
// "promoted" it execs itself WITHOUT --standby (same binary, same slot
// dir) so normal boot (resume, sweeper, pidfile, WS) runs exactly once.
//
// Why shadow-connect instead of no-WS: the takeover gates the old daemon's
// death on proof that the replacement serves END-TO-END (storage + WS +
// version). A no-WS standby can only prove storage — the version-skew bug
// proved that insufficient.

func runStandby(dataDir, cfgPath string) int {
	// Load + verify storage (same guards as normal boot, minus serving).
	server := &DaemonServer{
		configPath: cfgPath,
		dataDir:    dataDir,
		sessions:   make(map[string]*ActiveSession),
	}
	server.initSharedDir()
	if v, err := migrations.StoredVersion(dataDir); err != nil || v != migrations.CurrentVersion {
		fmt.Printf("[STANDBY] storage v%d (want %d): %v\n", v, migrations.CurrentVersion, err)
		return 1
	}
	// Touch every session file (parse meta tails): proves readability.
	if err := verifySessionsStandby(server); err != nil {
		fmt.Printf("[STANDBY] sessions: %v\n", err)
		return 1
	}
	if err := server.loadConfig(); err != nil || server.config == nil {
		fmt.Printf("[STANDBY] config: %v\n", err)
		return 1
	}
	// Shadow-connect: proves WS end-to-end without owning the host.
	if err := server.connectShadow(); err != nil {
		fmt.Printf("[STANDBY] shadow connect: %v\n", err)
		return 1
	}
	// Proof AFTER the WS is up (post-WS timestamp = end-to-end proof).
	server.writeServingProof()
	fmt.Printf("[STANDBY] serving proof written (%s), waiting for promote...\n", daemonVersion)
	handoff := filepath.Join(dataDir, "handoff.json")
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(handoff); err == nil {
			if string(raw) == "" {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			var doc struct {
				State string `json:"state"`
			}
			// Plain "promoted" token (launcher writes it).
			if string(raw) == "promoted\n" || string(raw) == "promoted" {
				return execSelf(dataDir, cfgPath)
			}
			if err := json.Unmarshal(raw, &doc); err == nil && doc.State == "promoted" {
				return execSelf(dataDir, cfgPath)
			}
			if len(raw) > 0 {
				fmt.Printf("[STANDBY] refused: %s\n", string(raw))
				return 1
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	fmt.Printf("[STANDBY] promote timeout\n")
	return 1
}

// servingProofPath is the proof-of-serving file (written after WS
// connect, removed on clean exit). The takeover launcher gates the old
// daemon's death on this file's version field.
func servingProofPath(dataDir string) string {
	return filepath.Join(dataDir, "serving.json")
}

// writeServingProof declares in writing: version, pid, connect time,
// session count. Called right after the WS connects.
func (d *DaemonServer) writeServingProof() {
	d.sessionsMu.RLock()
	n := len(d.sessions)
	d.sessionsMu.RUnlock()
	raw, _ := json.Marshal(map[string]any{
		"version":     daemonVersion,
		"pid":         os.Getpid(),
		"connectedAt": time.Now().UnixMilli(),
		"sessions":    n,
	})
	_ = os.WriteFile(servingProofPath(d.dataDir), raw, 0o600)
}

// removeServingProof deletes the proof (clean exit only — crashes leave a
// stale file, which readers must treat as ABSENT: always check pid alive).
func (d *DaemonServer) removeServingProof() {
	_ = os.Remove(servingProofPath(d.dataDir))
}

// verifySessionsStandby parses every session meta tail (read-only).
func verifySessionsStandby(d *DaemonServer) error {
	entries, err := os.ReadDir(d.sessionsDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || len(name) < 7 || name[len(name)-6:] != ".jsonl" {
			continue
		}
		if len(name) > 10 && name[len(name)-10:] == ".wal.jsonl" {
			continue
		}
		id := name[:len(name)-6]
		if !validSessionID(id) {
			continue
		}
		if _, err := d.readMetaTail(id); err != nil {
			return fmt.Errorf("session %s: %w", id, err)
		}
	}
	return nil
}

// execSelf re-execs this binary without --standby so the single tested
// boot path runs (resume, sweeper, pidfile, WS). Unix: syscall.Exec;
// Windows: spawn + exit with child's code.
func execSelf(dataDir, cfgPath string) int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("[STANDBY] exe: %v\n", err)
		return 1
	}
	args := []string{"--data-dir", dataDir, "--config", cfgPath}
	// Drop --standby (mode flip) AND --data-dir/--config + values (already
	// pinned above): Go flags take the LAST occurrence, so duplicates
	// would work by accident — be explicit instead.
	skipNext := false
	for _, a := range os.Args[1:] {
		if skipNext {
			skipNext = false
			continue
		}
		if a == "--standby" || a == "--data-dir" || a == "--config" {
			if a != "--standby" {
				skipNext = true
			}
			continue
		}
		args = append(args, a)
	}
	code, err := spawnAndWait(exe, args)
	if err != nil {
		fmt.Printf("[STANDBY] exec: %v\n", err)
	}
	return code
}

// connectShadow dials the gateway in shadow mode (?shadow=1) and holds the
// socket open. The relay tracks but never routes shadow traffic — the open
// socket itself proves WS end-to-end. Closed on promote (exec replaces us).
func (d *DaemonServer) connectShadow() error {
	u, err := url.Parse(d.config.GatewayURL)
	if err != nil {
		return err
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/indirect-code/daemon/ws?token=%s&shadow=1", scheme, u.Host, url.QueryEscape(d.config.DaemonToken))
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	d.wsMu.Lock()
	d.wsConn = conn
	d.wsMu.Unlock()
	// Drain (relay sends nothing to shadows, but never block the reader).
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	fmt.Printf("[STANDBY] shadow WS connected\n")
	return nil
}
