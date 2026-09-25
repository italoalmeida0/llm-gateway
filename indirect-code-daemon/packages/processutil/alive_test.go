package processutil

import (
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

func TestLivenessChild(t *testing.T) {
	if os.Getenv("PROCESSUTIL_CHILD") == "1" {
		if code := os.Getenv("PROCESSUTIL_EXIT"); code != "" {
			n, _ := strconv.Atoi(code)
			os.Exit(n)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	if Alive(0) || Alive(-1) || Alive(1<<30) || !Alive(os.Getpid()) {
		t.Fatal("invalid, missing, or own PID misclassified")
	}
	for _, code := range []string{"", "259"} {
		t.Run("exit="+code, func(t *testing.T) {
			bin, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(bin, "-test.run=^TestLivenessChild$")
			cmd.Env = append(os.Environ(), "PROCESSUTIL_CHILD=1", "PROCESSUTIL_EXIT="+code)
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			if code == "" {
				if !Alive(cmd.Process.Pid) {
					t.Fatal("live child reported dead")
				}
				if err := cmd.Process.Kill(); err != nil {
					t.Fatal(err)
				}
			}
			deadline := time.Now().Add(5 * time.Second)
			for Alive(cmd.Process.Pid) && time.Now().Before(deadline) {
				time.Sleep(20 * time.Millisecond)
			}
			// Deliberately check before Wait: Unix children are still zombies.
			if Alive(cmd.Process.Pid) {
				t.Fatal("exited child reported live before reap")
			}
		})
	}
}
