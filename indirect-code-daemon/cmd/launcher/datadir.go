package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// defaultDataDir mirrors the daemon's defaultDataDir (kept in sync by
// convention; the launcher passes it explicitly via --data-dir metadata
// so the daemon never has to guess).
func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".", ".indirect-code")
	}
	return filepath.Join(home, ".indirect-code")
}

// verifyAll checks distribution + storage integrity after migrations:
// daemon binary executable, sessions parseable.
func verifyAll(dataDir, daemonPath string) error {
	st, err := os.Stat(daemonPath)
	if err != nil {
		// PATH-resolved name is acceptable too.
		if _, lerr := lookPath(daemonPath); lerr != nil {
			return fmt.Errorf("daemon binary: %w", err)
		}
	} else if st.IsDir() {
		return fmt.Errorf("daemon path is a directory: %s", daemonPath)
	}
	return verifySessions(dataDir)
}
