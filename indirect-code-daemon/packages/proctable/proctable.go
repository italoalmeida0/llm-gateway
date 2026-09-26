// Package proctable is the cross-platform process table (extracted from
// the unish project, owner-sanctioned): /proc on Linux, kern.proc.all
// via sysctl on macOS (stable kinfo_proc ABI, no cgo), and the Windows
// process snapshot. It powers tree-aware kills (descendants — including
// setsid'd grandchildren that process-group kills cannot reach),
// zombie-aware liveness, and orphan/adopt scans.
package proctable

// Proc is one process-table row: the fields tree kills and orphan scans
// need. Stat is the platform state letter ("Z" = zombie). Cmd is the
// best-effort command line (or [comm] on Linux fallback, exe name on
// Windows).
type Proc struct {
	PID  int
	PPID int
	Stat string
	Cmd  string
}

// List returns a snapshot of the process table.
func List() ([]Proc, error) { return listProcs() }

// bootTime is exported for start-time based identity checks.
func BootTime() (unixSec int64) { return bootTimeSec() }

// Descendants returns every live pid below root (children, grandchildren,
// …), depth-first leaves first — the safe kill order.
func Descendants(root int) []int {
	procs, err := listProcs()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, p := range procs {
		children[p.PPID] = append(children[p.PPID], p.PID)
	}
	var out []int
	var walk func(int)
	walk = func(pid int) {
		for _, c := range children[pid] {
			walk(c)
			out = append(out, c) // post-order: leaves first
		}
	}
	walk(root)
	return out
}

// KillTree signals the whole tree rooted at pid: descendants first, then
// the root. sig is advisory — Windows only supports killing.
func KillTree(root int, sig int) {
	if root <= 0 {
		return
	}
	pids := Descendants(root)
	pids = append(pids, root)
	for _, pid := range pids {
		_ = signalPID(pid, sig)
	}
}
