package filetrack

import (
	"os"
	"path/filepath"
	"strings"
)

func readFileBytes(absPath string) ([]byte, error) {
	return os.ReadFile(absPath)
}

func filepathRel(cwd, absPath string) (string, error) {
	if cwd == "" {
		return absPath, nil
	}
	rel, err := filepath.Rel(cwd, absPath)
	if err != nil {
		return absPath, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return absPath, nil
	}
	return filepath.ToSlash(rel), nil
}
