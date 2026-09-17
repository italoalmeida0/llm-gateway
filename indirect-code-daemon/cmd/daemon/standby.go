package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// Standby mode (update takeover): the new daemon loads the migrated slot
// storage, writes standby-ready.json, and waits. It binds NOTHING and
// connects NO websocket. On handoff "promoted" it execs itself WITHOUT
// --standby (same binary, same slot dir) so normal boot (resume, sweeper,
// pidfile, WS) runs exactly once, through the normal path.
//
// Why re-exec instead of continuing in-process: the normal main() path is
// the only tested boot sequence. Standby shares the storage-load code,
// then hands off to it — zero divergent boot logic.

func runStandby(dataDir, cfgPath string) int {
	// Load + verify storage (same guards as normal boot, minus serving).
	server := &DaemonServer{
		configPath: cfgPath,
		dataDir:    dataDir,
		sessions:   make(map[string]*ActiveSession),
	}
	if v, err := migrations.StoredVersion(dataDir); err != nil || v != migrations.CurrentVersion {
		fmt.Printf("[STANDBY] storage v%d (want %d): %v\n", v, migrations.CurrentVersion, err)
		return 1
	}
	// Touch every session file (parse meta tails): proves readability.
	if err := verifySessionsStandby(server); err != nil {
		fmt.Printf("[STANDBY] sessions: %v\n", err)
		return 1
	}
	ready := map[string]any{"ready": true, "version": daemonVersion, "at": time.Now().UnixMilli()}
	raw, _ := json.Marshal(ready)
	if err := os.WriteFile(filepath.Join(dataDir, "standby-ready.json"), raw, 0o600); err != nil {
		fmt.Printf("[STANDBY] probe: %v\n", err)
		return 1
	}
	fmt.Printf("[STANDBY] ready (%s), waiting for promote...\n", daemonVersion)
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
				return execSelf(dataDir)
			}
			if err := json.Unmarshal(raw, &doc); err == nil && doc.State == "promoted" {
				return execSelf(dataDir)
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
func execSelf(dataDir string) int {
	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("[STANDBY] exe: %v\n", err)
		return 1
	}
	args := []string{"--data-dir", dataDir}
	for _, a := range os.Args[1:] {
		if a == "--standby" {
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
