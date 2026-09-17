package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

func lookPath(name string) (string, error) {
	return exec.LookPath(name)
}

// pidAlive reports whether pid (decimal) names a live process.

// detectShell probes for a usable shell without side effects (no
// downloads — that is the daemon's EnsureShell job at startup).
func detectShell() (string, error) {
	if runtime.GOOS == "windows" {
		if p, err := exec.LookPath("unish"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("no unish on PATH")
	}
	for _, sh := range []string{"bash", "zsh", "sh"} {
		if p, err := exec.LookPath(sh); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no bash/zsh/sh on PATH")
}
