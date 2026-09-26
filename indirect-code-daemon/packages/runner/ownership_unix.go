//go:build !windows

package runner

import "os/exec"

func ownCommand(cmd *exec.Cmd) (kill func() error, close func(), err error) {
	pgid := cmd.Process.Pid
	return func() error { reapCommandTree(pgid); return nil }, func() {}, nil
}
