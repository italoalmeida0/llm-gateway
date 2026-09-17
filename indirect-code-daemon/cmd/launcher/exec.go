package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"syscall"
)

// execDaemon replaces the launcher process with the daemon (Unix) or
// spawns it and waits (Windows, no exec primitive). Returns the daemon
// exit code (42 = update restart, re-resolve + exec again). Daemon args
// follow: launcher flags come first, everything after "--" goes to the
// daemon. Resolved metadata is passed explicitly so the daemon never
// guesses: --data-dir <dir> --storage-version <n> --launched-by <v>
func execDaemon(daemonPath, dataDir string, daemonArgs []string) (int, error) {
	args := []string{
		"--data-dir", dataDir,
		"--storage-version", "1",
		"--launched-by", "launcher/1",
	}
	args = append(args, daemonArgs...)
	if runtime.GOOS == "windows" {
		cmd := exec.Command(daemonPath, args...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				return ee.ExitCode(), fmt.Errorf("daemon exited %d", ee.ExitCode())
			}
			return 1, fmt.Errorf("daemon failed: %w", err)
		}
		return 0, nil
	}
	// Unix: image replaced — only returns on error.
	if err := syscall.Exec(daemonPath, append([]string{daemonPath}, args...), os.Environ()); err != nil {
		return 1, err
	}
	return 0, nil
}
