package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// activeSessionsDir resolves the live sessions dir: the active slot's
// sessions (canonical layout). No fallback branches: ensureLayout runs
// before verify, so slots/active always parses here.
func activeSessionsDir(rootDir string) string {
	if s := readActiveSlot(filepath.Join(rootDir, "slots")); s == "a" || s == "b" {
		return filepath.Join(rootDir, "slots", "slot-"+s, "sessions")
	}
	return filepath.Join(rootDir, "slots", "slot-a", "sessions")
}

// verifySessions scans every session file for structural sanity:
// JSONL sessions must end with a meta line. Torn tail lines are reported
// (the daemon tolerates them) but do not fail verification.
func verifySessions(dataDir string) error {
	dir := activeSessionsDir(dataDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var (
		checked, torn, failed int
		firstErr              error
	)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || (!strings.HasSuffix(name, ".jsonl") && !strings.HasSuffix(name, ".json")) {
			continue
		}
		if strings.HasSuffix(name, ".wal.jsonl") || strings.HasSuffix(name, ".turn.json") {
			continue // ephemeral sidecars, daemon-owned
		}
		p := filepath.Join(dir, name)
		if strings.HasSuffix(name, ".jsonl") {
			ok, isTorn := verifyJSONLSession(p)
			checked++
			if !ok {
				failed++
				if firstErr == nil {
					firstErr = fmt.Errorf("%s: no meta line", name)
				}
			} else if isTorn {
				torn++
			}
			continue
		}
		// Non-JSONL files inside sessions/: ignore (sidecars, future).
		continue
	}
	if failed > 0 {
		return fmt.Errorf("%d/%d sessions failed verification: %v", failed, checked, firstErr)
	}
	if torn > 0 {
		fmt.Printf("[VERIFY] %d sessions with torn tail (daemon tolerates)\n", torn)
	}
	return nil
}

// verifyJSONLSession checks the meta-last-line invariant. Returns
// (ok, tornTail): ok=false when no valid meta line exists.
func verifyJSONLSession(path string) (bool, bool) {
	f, err := os.Open(path)
	if err != nil {
		return false, false
	}
	defer f.Close()
	var (
		lastValid []byte
		torn      bool
	)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var probe struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(line, &probe); err != nil {
			torn = true // trailing partial write; deeper lines were valid
			continue
		}
		torn = false
		cp := append([]byte{}, line...)
		lastValid = cp
	}
	if sc.Err() != nil {
		return false, false
	}
	if lastValid == nil {
		return false, false
	}
	var meta struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(lastValid, &meta); err != nil {
		return false, false
	}
	if meta.Kind != "meta" || meta.ID == "" {
		return false, false
	}
	return true, torn
}
