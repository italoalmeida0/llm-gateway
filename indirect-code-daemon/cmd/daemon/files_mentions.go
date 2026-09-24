package main

import (
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Filename-only discovery within the selected workspace. Traversal is bounded,
// does not follow symlinks, and never reads file contents.
func mentionFiles(root, query string) ([]string, bool, error) {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, false, err
	}
	root = resolved
	matches := []string{}
	query = strings.ToLower(strings.ReplaceAll(query, "\\", "/"))
	count := 0
	truncated := false
	deadline := time.Now().Add(300 * time.Millisecond)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			return nil
		}
		count++
		if count > 20000 || time.Now().After(deadline) {
			truncated = true
			return fs.SkipAll
		}
		if path == root {
			return nil
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "node_modules", "vendor", ".cache", "dist", "bin":
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		if strings.Contains(strings.ToLower(relative), query) {
			matches = append(matches, relative)
			if len(matches) >= 100 {
				truncated = true
				return fs.SkipAll
			}
		}
		return nil
	})
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := strings.HasPrefix(strings.ToLower(filepath.Base(matches[i])), query), strings.HasPrefix(strings.ToLower(filepath.Base(matches[j])), query)
		if a != b {
			return a
		}
		return matches[i] < matches[j]
	})
	return matches, truncated, err
}

