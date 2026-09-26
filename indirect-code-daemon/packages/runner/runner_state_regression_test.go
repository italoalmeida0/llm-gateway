//go:build !windows

package runner

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRegressionHeartbeatAndTerminalState(t *testing.T) {
	root := t.TempDir()
	// The heartbeat/terminal-write race is platform-independent; this
	// unit uses a POSIX shell. The Windows lanes cover the same code path
	// through the daemon regression suite (real shell resolution).
	spec := Spec{JobID: "race", SessionID: "s", Kind: "bash", Path: "/bin/sh", Args: []string{"-c", "sleep 10.2"}, Env: os.Environ(), Root: root, RunnerVersion: "test", OutPath: filepath.Join(root, "out.log"), BrainPath: filepath.Join(root, "brain.log")}
	if code := Run(spec); code != 0 {
		t.Fatalf("exit %d", code)
	}
}
