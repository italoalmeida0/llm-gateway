package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type workspaceStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

func inspectWorkspace(path string) workspaceStatus {
	result := workspaceStatus{Path: path, Status: "unavailable"}
	if path == "" {
		return result
	}
	if absolute, err := filepath.Abs(path); err == nil {
		result.Path = absolute
	}
	info, err := os.Stat(result.Path)
	if os.IsNotExist(err) {
		result.Status = "missing"
	} else if err == nil && info.IsDir() {
		result.Status = "available"
	}
	return result
}

func (d *DaemonServer) checkWorkspace(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		ProjectID string `json:"projectId"`
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	path := ""
	if req.SessionID != "" {
		act, err := d.getOrCreateActiveSession(req.SessionID)
		if err != nil {
			return
		}
		act.mu.Lock()
		path = act.record.CWD
		act.mu.Unlock()
	} else {
		for _, project := range d.loadProjects() {
			if project.ID == req.ProjectID {
				path = project.Path
				break
			}
		}
	}
	if path == "" {
		return
	}
	_ = d.sendWS(map[string]any{"type": "workspace_status", "hostId": d.config.HostID, "sessionId": req.SessionID, "projectId": req.ProjectID, "requestId": req.RequestID, "workspace": inspectWorkspace(path)})
}
