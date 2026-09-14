package main

import (
	"encoding/json"
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

func (d *DaemonServer) searchMentionFiles(raw []byte) {
	var req struct {
		RequestID string `json:"requestId"`
		SessionID string `json:"sessionId"`
		ProjectID string `json:"projectId"`
		Query     string `json:"query"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	root := ""
	if req.SessionID != "" {
		if act, err := d.getOrCreateActiveSession(req.SessionID); err == nil {
			act.mu.Lock()
			root = act.record.CWD
			act.mu.Unlock()
		}
	} else {
		for _, p := range d.loadProjects() {
			if p.ID == req.ProjectID {
				root = p.Path
				break
			}
		}
	}
	payload := map[string]any{"type": "file_matches", "hostId": d.config.HostID, "requestId": req.RequestID, "sessionId": req.SessionID, "files": []string{}}
	if root == "" {
		payload["error"] = "Select an available project to mention files"
	} else {
		files, truncated, err := mentionFiles(root, req.Query)
		if err != nil {
			payload["error"] = "Could not search this workspace"
		} else {
			payload["files"] = files
			payload["truncated"] = truncated
		}
	}
	_ = d.sendWS(payload)
}
