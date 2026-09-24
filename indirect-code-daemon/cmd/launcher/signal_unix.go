package main

import (
	"os"
	"os/exec"
)

// forwardSignal delivers sig to the daemon child process.
func forwardSignal(cmd *exec.Cmd, sig os.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(sig)
}
