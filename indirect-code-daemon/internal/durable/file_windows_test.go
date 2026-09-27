package durable

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWriteWaitsForWindowsStateReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runner.state.json")
	if err := Write(path, []byte("before")); err != nil {
		t.Fatal(err)
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() { time.Sleep(150 * time.Millisecond); windows.CloseHandle(handle); close(closed) }()
	defer func() { <-closed }()
	if err := Write(path, []byte("after")); err != nil {
		t.Fatalf("reader interrupted publication: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "after" {
		t.Fatalf("publication lost: %q, %v", raw, err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatalf("staging files left after retry: %v, %v", entries, err)
	}
}
