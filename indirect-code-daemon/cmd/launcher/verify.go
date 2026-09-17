package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// verifyStorageVersion fails when the data dir is not at the version the
// daemon understands (migrations must have run first).
func verifyStorageVersion(dataDir string) error {
	stored, err := migrations.StoredVersion(dataDir)
	if err != nil {
		return fmt.Errorf("storage version: %w", err)
	}
	if stored != migrations.CurrentVersion {
		return fmt.Errorf("storage v%d != current v%d (run launcher without --verify-only to migrate)", stored, migrations.CurrentVersion)
	}
	return nil
}

// verifySessions scans every session file for structural sanity:
// JSONL sessions must end with a meta line; legacy JSON sessions must
// parse. Torn tail lines are reported (the daemon tolerates them) but
// do not fail verification.
func verifySessions(dataDir string) error {
	dir := filepath.Join(dataDir, "sessions")
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
			continue // ephemeral / legacy-crash sidecars, daemon-owned
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
		// Legacy single-JSON session (pre-migration): must at least parse.
		raw, err := os.ReadFile(p)
		checked++
		if err != nil || !json.Valid(raw) {
			failed++
			if firstErr == nil {
				firstErr = fmt.Errorf("%s: unreadable legacy session", name)
			}
		}
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
