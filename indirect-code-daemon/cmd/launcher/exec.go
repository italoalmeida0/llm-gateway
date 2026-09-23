package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

var errUpdateHandoff = errors.New("daemon handed over to updater")

// execDaemon runs the daemon as a CHILD process and waits (all platforms).
// Returns the daemon exit code, or errUpdateHandoff when an updater owns
// its restart. Signals (SIGINT/SIGTERM) are forwarded so Ctrl-C and
// kill behave exactly as if the daemon ran directly; --stop (pidfile)
// keeps working because the daemon writes its own pid.
//
// The updater writes update.req with the child's PID before killing it.
// A request for a different PID never suppresses ordinary crash recovery.
func execDaemon(daemonPath, dataDir string, daemonArgs []string) (int, error) {
	args := []string{
		"--data-dir", dataDir,
	}
	args = append(args, daemonArgs...)
	cmd := exec.Command(daemonPath, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Own process group (Unix): signals to the launcher don't implicitly
	// hit the child — we forward explicitly below, exactly once.
	setChildPgid(cmd)
	requestPath := filepath.Join(dataDir, "update.req")
	_ = os.Remove(requestPath) // Stale claims cannot affect a new child.
	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("daemon start: %w", err)
	}
	// Forward SIGINT/SIGTERM to the child; stop forwarding when it exits.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(sigCh)
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case sig := <-sigCh:
				_ = forwardSignal(cmd, sig)
			}
		}
	}()
	err := cmd.Wait()
	if raw, readErr := os.ReadFile(requestPath); readErr == nil && strings.TrimSpace(string(raw)) == strconv.Itoa(cmd.Process.Pid) {
		_ = os.Remove(requestPath)
		return 0, errUpdateHandoff
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), fmt.Errorf("daemon exited %d", ee.ExitCode())
		}
		return 1, fmt.Errorf("daemon failed: %w", err)
	}
	return 0, nil
}
