package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// execDaemon runs the daemon as a CHILD process and waits (all platforms).
// Returns the daemon exit code (42 = update restart: the caller re-resolves
// and runs again). Signals (SIGINT/SIGTERM) are forwarded so Ctrl-C and
// kill behave exactly as if the daemon ran directly; --stop (pidfile)
// keeps working because the daemon writes its own pid.
//
// Why not syscall.Exec on Unix: exec replaces the launcher image, so the
// supervise loop (update restarts) would never run — exit 42 would leak
// to whoever started the launcher instead of re-resolving here.
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
	if err := cmd.Wait(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), fmt.Errorf("daemon exited %d", ee.ExitCode())
		}
		return 1, fmt.Errorf("daemon failed: %w", err)
	}
	return 0, nil
}
