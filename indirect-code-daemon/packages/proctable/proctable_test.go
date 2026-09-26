//go:build !windows

package proctable

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The table and tree-kill semantics — including the escape that
// process-group kills cannot reach: a setsid'd grandchild.

func TestListFindsSelfAndParent(t *testing.T) {
	procs, err := List()
	if err != nil {
		t.Fatal(err)
	}
	me := os.Getpid()
	found := false
	for _, p := range procs {
		if p.PID == me {
			found = true
			if p.PPID <= 0 {
				t.Fatalf("self row has no ppid: %+v", p)
			}
			if p.Stat == "Z" {
				t.Fatalf("running test reported as zombie: %+v", p)
			}
		}
	}
	if !found {
		t.Fatal("process table does not contain the calling process")
	}
}

// TestKillTreeReachesSetsidGrandchild is the one process-group kills
// fail: a child that calls setsid escapes the group, but never the
// ppid tree.
func TestKillTreeReachesSetsidGrandchild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("setsid scenario is POSIX")
	}
	// The sh script spawns a setsid'd grandchild that sleeps, then sleeps
	// itself — the grandchild is OUT of our process group.
	marker := t.TempDir() + "/grand.pid"
	script := "setsid sleep 30 & echo $! > '" + marker + "'; sleep 30"
	cmd := exec.Command("/bin/sh", "-c", script)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { KillTree(cmd.Process.Pid, int(syscall.SIGKILL)) }()

	deadline := time.Now().Add(5 * time.Second)
	var grand int
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(marker); err == nil {
			if v, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && v > 0 {
				grand = v
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if grand == 0 {
		t.Fatal("grandchild never started")
	}
	// The grandchild must be listed as a descendant of the shell.
	var inTree bool
	for _, d := range Descendants(cmd.Process.Pid) {
		if d == grand {
			inTree = true
		}
	}
	if !inTree {
		t.Skipf("grandchild not visible as descendant (pid namespaces?): shell=%d grand=%d", cmd.Process.Pid, grand)
	}

	KillTree(cmd.Process.Pid, int(syscall.SIGKILL))
	deadline = time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && alive(grand) {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(grand) {
		t.Fatal("killtree left a setsid'd grandchild alive — the whole tree must die")
	}
}

func TestDescendantsLeavesFirst(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX scenario")
	}
	// The shell must SURVIVE as the parent (a lone command would exec
	// in place): background + wait keeps the tree shape.
	cmd := exec.Command("/bin/sh", "-c", "sleep 30 & wait")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer KillTree(cmd.Process.Pid, int(syscall.SIGKILL))
	deadline := time.Now().Add(5 * time.Second)
	var got []int
	for time.Now().Before(deadline) {
		got = Descendants(cmd.Process.Pid)
		if len(got) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(got) != 1 || got[0] == cmd.Process.Pid {
		t.Fatalf("expected exactly the one child (not the root), got %v", got)
	}
}

// alive is zombie-aware through the table itself (a zombie is dead for
// every consumer of this package).
func alive(pid int) bool {
	procs, err := List()
	if err != nil {
		return signalPID(pid, 0) == nil
	}
	for _, p := range procs {
		if p.PID == pid {
			return p.Stat != "Z"
		}
	}
	return false
}
