package migrations

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// v2 drops the file-backed background-task log model: logs now live in
// the session BgTasks (RAM + WAL), and runner files are cleaned at
// terminal. This migration sweeps every leftover per-job file from v1
// slots so no 7-day garbage lingers:
//
//	runners/<job>.state.json  (terminal or not — v1 states are unreadable
//	                           by the v2 supervisor anyway)
//	runners/<job>.disposition
//	runners/<job>.launch
//	runners/out/*.log         (live logs; the transcript fold keeps the
//	                           capped result text)
//	runners/indirect-code-runner-* (stale self-copies; the daemon
//	                           re-copies its own binary on next start)
//	bg/<job>.pid.json + bg/<job>.notice.json (supervisor bookkeeping)
//	brain/bg_*.log            (v1 brain copies of bg output)
//
// Session files are NEVER touched: transcript folds already carry the
// capped results, and BgTasks start empty for old sessions.
//
// Idempotent: removing absent files is a no-op; re-running is safe.

func init() {
	register(Migration{Version: 2, Name: "drop file-backed bg task logs", Apply: applyV2, Verify: verifyV2})
}

func applyV2(slotDir string) error {
	// runners/ tree.
	runners := filepath.Join(slotDir, "runners")
	if entries, err := os.ReadDir(runners); err == nil {
		for _, e := range entries {
			name := e.Name()
			p := filepath.Join(runners, name)
			switch {
			case e.IsDir() && name == "out":
				// Live logs: every file in out/ goes.
				if logs, err := os.ReadDir(p); err == nil {
					for _, l := range logs {
						if !l.IsDir() {
							_ = os.Remove(filepath.Join(p, l.Name()))
						}
					}
				}
			case e.IsDir():
				continue
			case strings.HasSuffix(name, ".state.json") ||
				strings.HasSuffix(name, ".disposition") ||
				strings.HasSuffix(name, ".launch") ||
				strings.HasPrefix(name, "indirect-code-runner-"):
				_ = os.Remove(p)
			}
		}
	}
	// bg/ bookkeeping.
	bg := filepath.Join(slotDir, "bg")
	if entries, err := os.ReadDir(bg); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasSuffix(name, ".pid.json") || strings.HasSuffix(name, ".notice.json") {
				_ = os.Remove(filepath.Join(bg, name))
			}
		}
	}
	// brain/ copies of bg output.
	brain := filepath.Join(slotDir, "brain")
	if entries, err := os.ReadDir(brain); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			if strings.HasPrefix(e.Name(), "bg_") && strings.HasSuffix(e.Name(), ".log") {
				_ = os.Remove(filepath.Join(brain, e.Name()))
			}
		}
		// Per-session brain dirs: brain/<sess>/bg_*.log.
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			sub := filepath.Join(brain, e.Name())
			if logs, err := os.ReadDir(sub); err == nil {
				for _, l := range logs {
					if !l.IsDir() && strings.HasPrefix(l.Name(), "bg_") && strings.HasSuffix(l.Name(), ".log") {
						_ = os.Remove(filepath.Join(sub, l.Name()))
					}
				}
			}
		}
	}
	return nil
}

func verifyV2(slotDir string) error {
	var leftovers []string
	check := func(dir string, match func(string) bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() && match(e.Name()) {
				leftovers = append(leftovers, filepath.Join(dir, e.Name()))
			}
		}
	}
	runners := filepath.Join(slotDir, "runners")
	check(runners, func(n string) bool {
		return strings.HasSuffix(n, ".state.json") || strings.HasSuffix(n, ".disposition") || strings.HasSuffix(n, ".launch")
	})
	check(filepath.Join(runners, "out"), func(string) bool { return true })
	check(filepath.Join(slotDir, "bg"), func(n string) bool {
		return strings.HasSuffix(n, ".pid.json") || strings.HasSuffix(n, ".notice.json")
	})
	if len(leftovers) > 0 {
		return fmt.Errorf("leftover bg files: %v", leftovers)
	}
	return nil
}
