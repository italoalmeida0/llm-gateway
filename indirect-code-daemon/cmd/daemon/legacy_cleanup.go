package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// cleanupLegacyReviewDirs removes leftovers of the retired git-based review
// system: the shared per-project review repos (dataDir/reviews/*) and the
// legacy per-session git dirs (sessions/<id>/git). The user's own .git
// repositories are never touched — only the daemon's temp dirs.
func cleanupLegacyReviewDirs(dataDir string) {
	if dataDir == "" {
		return
	}
	reviewsDir := filepath.Join(dataDir, "reviews")
	if entries, err := os.ReadDir(reviewsDir); err == nil {
		for _, e := range entries {
			p := filepath.Join(reviewsDir, e.Name())
			if err := os.RemoveAll(p); err != nil {
				fmt.Printf("[INFO] Could not remove legacy review dir %s: %s\n", p, err)
				continue
			}
			fmt.Printf("[INFO] Removed legacy review dir %s\n", p)
		}
		if rest, err := os.ReadDir(reviewsDir); err == nil && len(rest) == 0 {
			_ = os.Remove(reviewsDir)
		}
	}
	// Legacy per-session git layout (pre-shared-tracker).
	sessionsDir := filepath.Join(dataDir, "sessions")
	if entries, err := os.ReadDir(sessionsDir); err == nil {
		for _, e := range entries {
			gitDir := filepath.Join(sessionsDir, e.Name(), "git")
			if st, err := os.Stat(gitDir); err == nil && st.IsDir() {
				if err := os.RemoveAll(gitDir); err != nil {
					fmt.Printf("[INFO] Could not remove legacy session git dir %s: %s\n", gitDir, err)
					continue
				}
				fmt.Printf("[INFO] Removed legacy session git dir %s\n", gitDir)
			}
		}
	}
}
