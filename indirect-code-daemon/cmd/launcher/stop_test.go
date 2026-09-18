package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestStopDaemonNoPid(t *testing.T) {
	dir := t.TempDir()
	if err := stopDaemon(dir); err != nil {
		t.Fatalf("expected nil when no pidfile exists, got: %v", err)
	}
}

func TestStopDaemonDeadPid(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "daemon.pid")
	// Use an impossible or dead pid
	mustWriteFile(pidFile, "999999999\n")
	if err := stopDaemon(dir); err != nil {
		t.Fatalf("expected nil when pid is dead, got: %v", err)
	}
	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Fatalf("dead pidfile must be cleaned up")
	}
}

func TestStopDaemonLiveProcess(t *testing.T) {
	dir := t.TempDir()
	// Spawn a long-running sleep command to simulate a running daemon
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start sleep command: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	pid := cmd.Process.Pid
	pidFile := filepath.Join(dir, "daemon.pid")
	mustWriteFile(pidFile, strconv.Itoa(pid)+"\n")

	if err := stopDaemon(dir); err != nil {
		t.Fatalf("stopDaemon failed: %v", err)
	}

	if _, err := os.Stat(pidFile); !os.IsNotExist(err) {
		t.Fatalf("pidfile must be removed after successful stop")
	}

	// Give a moment for process exit to register
	time.Sleep(100 * time.Millisecond)
	if pidAlive(strconv.Itoa(pid)) {
		t.Fatalf("process %d should have been stopped", pid)
	}
}
