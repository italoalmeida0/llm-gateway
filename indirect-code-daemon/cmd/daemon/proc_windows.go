//go:build windows

package main

import "os/exec"

func setChildPgid(cmd *exec.Cmd) {}
