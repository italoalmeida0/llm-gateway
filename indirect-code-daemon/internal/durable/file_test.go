package durable

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("injected read failure") }

func TestFailedCopyPreservesPreviousPublication(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "result")
	if err := Write(path, []byte("previous complete result")); err != nil {
		t.Fatal(err)
	}
	partial := io.MultiReader(strings.NewReader("partial new result"), failingReader{})
	if err := Replace(path, partial, 0o600); err == nil {
		t.Fatal("failed copy acknowledged")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "previous complete result" {
		t.Fatalf("damaged previous result: %q, %v", raw, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("abandoned publication files: %v", err)
	}
}
