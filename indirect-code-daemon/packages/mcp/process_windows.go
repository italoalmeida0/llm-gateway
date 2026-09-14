//go:build windows

package mcp

import (
	"os/exec"
	"time"
)

func prepareProcess(cmd *exec.Cmd) { cmd.WaitDelay = time.Second }
