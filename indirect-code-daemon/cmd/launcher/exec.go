package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// execDaemon spawns the daemon and waits for it, returning its exit
// code (42 = update restart, re-resolve + exec again). Daemon args
// follow: launcher flags come first, everything after "--" goes to the
// daemon.
func execDaemon(daemonPath, dataDir string, daemonArgs []string) (int, error) {
	args := []string{
		"--data-dir", dataDir,
	}
	args = append(args, daemonArgs...)

	cmd := exec.Command(daemonPath, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("daemon start failed: %w", err)
	}

	go func() {
		for sig := range sigCh {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(sig)
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
