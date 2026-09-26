package runner

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRegressionHeartbeatAndTerminalState(t *testing.T) {
	root := t.TempDir()
	shell, args := "/bin/sh", []string{"-c", "sleep 10.2"}
	if runtime.GOOS == "windows" {
		shell, args = "cmd", []string{"/c", "ping -n 11 127.0.0.1 >nul"}
	}
	spec := Spec{JobID: "race", SessionID: "s", Kind: "bash", Path: shell, Args: args, Env: os.Environ(), Root: root, RunnerVersion: "test", OutPath: filepath.Join(root, "out.log"), BrainPath: filepath.Join(root, "brain.log")}
	if code := Run(spec); code != 0 {
		t.Fatalf("exit %d", code)
	}
}
