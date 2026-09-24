package main

import (
	"os"
	"path/filepath"
	"sort"
)

type FolderEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func browseFolders(path string) (string, string, []FolderEntry, error) {
	path = resolvePath(path)
	path, err := filepath.Abs(path)
	if err != nil {
		return "", "", nil, err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", "", nil, err
	}
	folders := []FolderEntry{}
	for _, entry := range entries {
		if !entry.IsDir() {
			if entry.Type()&os.ModeSymlink == 0 {
				continue
			}
			info, err := os.Stat(filepath.Join(path, entry.Name()))
			if err != nil || !info.IsDir() {
				continue
			}
		}
		folders = append(folders, FolderEntry{Name: entry.Name(), Path: filepath.Join(path, entry.Name())})
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].Name < folders[j].Name })
	return path, filepath.Dir(path), folders, nil
}
