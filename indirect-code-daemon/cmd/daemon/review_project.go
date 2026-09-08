package main

import (
	"crypto/sha1"
	"encoding/hex"
	"path/filepath"
	"runtime"
	"strings"
)

// Shared review roots: one temp git repo per project folder, not per
// session. The key insight: if this were a normal git repo it would live
// INSIDE the project folder (one .git per project). Ours lives outside
// (so the user's own .git is untouched) but stays 1:1 with the folder.
//
//	key = sha1(normalized root)[:16] + "-" + sanitized basename
//	dir = <dataDir>/reviews/<key>/git
//
// The hash avoids path-traversal, Windows case/drive issues and overlong
// names; the basename suffix keeps the dir debuggable.

// reviewRootForCWD resolves the shared review root for a session CWD: the
// owning project's Path when the CWD is actually INSIDE a registered
// project, otherwise the normalized CWD itself. Sessions in /repo and
// /repo/sub therefore share one repo rooted at /repo.
//
// NOTE: unlike projectForDirectory (which falls back to the protected Home
// project for UI grouping), there is NO fallback here: mapping an unrelated
// CWD to Home would point the work-tree at the whole home directory.
func reviewRootForCWD(cwd string, projects []ProjectEntry) string {
	resolved := normalizeReviewRoot(cwd)
	best := ""
	for _, p := range projects {
		if strings.TrimSpace(p.Path) == "" {
			continue
		}
		path := normalizeReviewRoot(p.Path)
		prefix := strings.TrimRight(path, string(filepath.Separator)) + string(filepath.Separator)
		if (resolved == path || strings.HasPrefix(resolved, prefix)) && len(path) > len(best) {
			best = path
		}
	}
	if best != "" {
		return best
	}
	return resolved
}

// normalizeReviewRoot cleans + absolutizes a review root.
func normalizeReviewRoot(p string) string {
	p = filepath.Clean(resolvePath(p))
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// reviewKeyForRoot derives the stable, filesystem-safe directory key for a
// normalized (or raw) review root.
func reviewKeyForRoot(root string) string {
	norm := normalizeReviewRoot(root)
	sum := sha1.Sum([]byte(norm))
	base := filepath.Base(norm)
	if base == "" || base == "." || base == string(filepath.Separator) {
		base = "root"
	}
	var b strings.Builder
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	safe := b.String()
	if len(safe) > 48 {
		safe = safe[:48]
	}
	if safe == "" {
		safe = "project"
	}
	return hex.EncodeToString(sum[:])[:16] + "-" + safe
}
