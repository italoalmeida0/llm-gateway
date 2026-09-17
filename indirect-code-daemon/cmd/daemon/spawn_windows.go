//go:build windows

package main

import (
	"os"
	"os/exec"
)

// spawnAndWait runs the child and waits (no exec primitive on Windows).
func spawnAndWait(exe string, args []string) (int, error) {
	cmd := exec.Command(exe, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), err
		}
		return 1, err
	}
	return 0, nil
}
