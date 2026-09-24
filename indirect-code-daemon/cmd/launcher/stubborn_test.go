package main

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestTerminateParentWait(t *testing.T) {
	// Already-gone pid: instant nil.
	if err := terminateParentWait("99999999", time.Second); err != nil {
		t.Fatalf("gone pid: %v", err)
	}
	// Live process that ignores TERM? Use sleep (dies on TERM).
	cmd := exec.Command("sleep", "60")
	if err := cmd.Start(); err != nil {
		t.Skip("no sleep")
	}
	pid := string(rune(0))
	_ = pid
	p := cmd.Process.Pid
	if err := terminateParentWait(itoa(p), 5*time.Second); err != nil {
		t.Fatalf("sleep should die: %v", err)
	}
	_ = os.Getpid
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
