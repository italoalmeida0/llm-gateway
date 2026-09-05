//go:build windows

package auth

import (
	"os/exec"
	"time"
)

func configureAPIKeyCommandProcess(cmd *exec.Cmd) {
	cmd.WaitDelay = 2 * time.Second
}

func cancelAPIKeyCommandProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
