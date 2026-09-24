package main

import (
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

