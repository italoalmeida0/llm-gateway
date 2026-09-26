package runner

import (
	"encoding/json"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// CommandMain is an internal role of the same binary. No user code runs until
// the runner has published ownership and released the private stdin gate.
// EOF before release is a cancelled launch, including a hard-killed runner.
func CommandMain() int {
	// Keep the group leader alive while its children handle TERM. The
	// runner's escalation kills the group if a child refuses to exit.
	sigc := make(chan os.Signal, 2)
	signal.Notify(sigc, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(sigc)
	type launch struct {
		spec     Spec
		released bool
		err      error
	}
	ready := make(chan launch, 1)
	go func() {
		var l launch
		d := json.NewDecoder(os.Stdin)
		if l.err = d.Decode(&l.spec); l.err == nil {
			l.err = d.Decode(&l.released)
		}
		ready <- l
	}()
	var l launch
	select {
	case l = <-ready:
	case <-time.After(30 * time.Second):
		return 75
	}
	if l.err != nil || !l.released || l.spec.Validate() != nil {
		return 75
	}
	_ = os.Stdin.Close() // the payload never inherits the launch channel
	cmd := exec.Command(l.spec.Path, l.spec.Args...)
	cmd.Dir, cmd.Env = l.spec.CWD, utf8Env(l.spec.Env)
	cmd.Stdin = strings.NewReader(l.spec.Stdin)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Inherit the bootstrap's group/job: ownership was committed before GO.
	if err := cmd.Start(); err != nil {
		return 127
	}
	return exitCodeOf(cmd.Wait())
}
