//go:build !windows

package main

import (
	"os"
	"syscall"
)

// spawnAndWait replaces the image on Unix (single process, same pid).
func spawnAndWait(exe string, args []string) (int, error) {
	if err := syscall.Exec(exe, append([]string{exe}, args...), os.Environ()); err != nil {
		return 1, err
	}
	return 0, nil
}
