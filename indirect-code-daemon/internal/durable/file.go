// Package durable publishes complete records without exposing partial files.
package durable

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
)

// Replace returns errors even after rename: such an error is an uncertain
// commit, and retrying the same record is safe. Callers must not acknowledge it.
func Replace(path string, src io.Reader, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".publish-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if _, err := io.Copy(f, src); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := Rename(f.Name(), path); err != nil {
		return err
	}
	return SyncDir(dir)
}

func Write(path string, data []byte) error {
	return Replace(path, bytes.NewReader(data), 0o600)
}

func Copy(source, target string) error {
	f, err := os.Open(source)
	if err != nil {
		return err
	}
	defer f.Close()
	return Replace(target, f, 0o600)
}
