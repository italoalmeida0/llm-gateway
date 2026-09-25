package tools

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestProcessIdentityLifecycle(t *testing.T) {
	if os.Getenv("PROCESS_IDENTITY_CHILD") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	self := ProcessIdentity(os.Getpid())
	if self == "" || ProcessIdentity(os.Getpid()) != self {
		t.Fatal("own process must have a stable identity")
	}
	for _, pid := range []int{-1, 0, 1 << 30} {
		if ProcessIdentity(pid) != "" {
			t.Fatalf("invalid PID %d has identity", pid)
		}
	}
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "-test.run=^TestProcessIdentityLifecycle$")
	cmd.Env = append(os.Environ(), "PROCESS_IDENTITY_CHILD=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	identity := ProcessIdentity(cmd.Process.Pid)
	if identity == "" || ProcessIdentity(cmd.Process.Pid) != identity {
		t.Fatal("live child must have a stable identity")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for ProcessIdentity(cmd.Process.Pid) != "" && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if ProcessIdentity(cmd.Process.Pid) != "" {
		t.Fatal("dead child retains live identity")
	}
}
