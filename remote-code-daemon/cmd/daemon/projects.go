package main

import (
	"path/filepath"
	"runtime"
	"strings"
)

func projectForDirectory(cwd string, projects []ProjectEntry) *ProjectEntry {
	if cwd == "" {
		return nil
	}
	normalize := func(path string) string {
		path = filepath.Clean(path)
		if runtime.GOOS == "windows" {
			path = strings.ToLower(path)
		}
		return path
	}
	cwd = normalize(cwd)
	var match *ProjectEntry
	length := -1
	for i := range projects {
		if projects[i].Path == "" {
			continue
		}
		path := normalize(projects[i].Path)
		prefix := strings.TrimRight(path, string(filepath.Separator)) + string(filepath.Separator)
		if (cwd == path || strings.HasPrefix(cwd, prefix)) && len(path) > length {
			match = &projects[i]
			length = len(path)
		}
	}
	return match
}
