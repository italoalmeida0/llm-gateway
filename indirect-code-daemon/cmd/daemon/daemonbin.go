package main

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// App-binary verification helpers shared by the boot path (fetch.go) and
// the brutal update path (boot_update.go). The multi-call binary stages
// ITSELF (stageAppTo), so verification is a sanity check on our own
// bytes — never a trust boundary for network downloads (those live in
// the worker's update checker and verify there).

// selfVerifyRuns checks an app binary RUNS (--version exits 0 with our
// version banner), without pinning to any expected version. Role-agnostic
// on purpose: bare `--version` prints the BOOT role banner ("indirect-code
// boot X") while `--worker --version` prints the worker one
// ("indirect-code daemon X") — either proves the binary is ours.
func selfVerifyRuns(path string) error {
	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		defer close(done)
		cmd := exec.Command(path, "--version")
		out, runErr = cmd.CombinedOutput()
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		return fmt.Errorf("app --version timed out")
	}
	if runErr != nil {
		return fmt.Errorf("app --version failed: %v (%s)", runErr, strings.TrimSpace(string(out)))
	}
	if !strings.Contains(string(out), "indirect-code") {
		return fmt.Errorf("not an indirect-code binary: %q", strings.TrimSpace(string(out)))
	}
	return nil
}

// selfVerifyDaemon runs `bin --version` and checks the version string.
func selfVerifyDaemon(path, want string) error {
	done := make(chan struct{})
	var out []byte
	var runErr error
	go func() {
		defer close(done)
		cmd := exec.Command(path, "--version")
		out, runErr = cmd.CombinedOutput()
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		return fmt.Errorf("daemon --version timed out")
	}
	if runErr != nil {
		return fmt.Errorf("daemon --version failed: %v (%s)", runErr, strings.TrimSpace(string(out)))
	}
	if !strings.Contains(string(out), want) {
		return fmt.Errorf("daemon version mismatch: want %q, got %q", want, strings.TrimSpace(string(out)))
	}
	return nil
}

// runVersionCmd runs `bin --version` and returns combined output.
func runVersionCmd(path string) ([]byte, error) {
	return exec.Command(path, "--version").CombinedOutput()
}
