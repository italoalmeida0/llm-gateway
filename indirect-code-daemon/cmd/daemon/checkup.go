package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// probePython is a PATH-only lookup (python3, then python). No version
// parsing, no downloads — the daemon's EnsurePython owns that.
func probePython() (string, error) {
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no python3/python on PATH")
}

// runCheckup verifies the environment before the daemon starts: daemon
// binary present and executable, data dir writable, disk space sane,
// python/shell availability (informational — the daemon degrades, the
// boot role only reports).
type checkItem struct {
	name   string
	ok     bool
	detail string
	// fatal=false means "report only": the daemon can start degraded.
	fatal bool
}

type checkReport struct {
	items []checkItem
}

func (r *checkReport) add(name string, ok bool, detail string, fatal bool) {
	r.items = append(r.items, checkItem{name: name, ok: ok, detail: detail, fatal: fatal})
}

func (r *checkReport) ok() bool {
	for _, it := range r.items {
		if it.fatal && !it.ok {
			return false
		}
	}
	return true
}

func (r *checkReport) print() {
	// Quiet contract: one line when everything passes, full detail only
	// on failure (the failing item + hint). Warnings (non-fatal) print
	// only when verbose.
	if r.ok() {
		return
	}
	for _, it := range r.items {
		if it.fatal && !it.ok {
			fmt.Printf("Error: %s: %s\n", it.name, it.detail)
		}
	}
}

// printVerbose prints every item (warnings included). Used on failure to
// show the full picture after the one-line error above.
func (r *checkReport) printVerbose() {
	for _, it := range r.items {
		status := "ok"
		if !it.ok {
			status = "FAIL"
			if !it.fatal {
				status = "warn"
			}
		}
		if it.detail != "" {
			fmt.Printf("[CHECK] %-10s %s: %s\n", status, it.name, it.detail)
		} else {
			fmt.Printf("[CHECK] %-10s %s\n", status, it.name)
		}
	}
}

func runCheckup(dataDir, daemonPath string) *checkReport {
	r := &checkReport{}

	// Daemon binary: must exist and be executable (fatal).
	resolved := daemonPath
	if !filepath.IsAbs(resolved) && !strings.ContainsAny(resolved, `/\`) {
		if p, err := lookPath(resolved); err == nil {
			resolved = p
		}
	}
	if st, err := os.Stat(resolved); err != nil {
		r.add("daemon", false, fmt.Sprintf("%s: %v", daemonPath, err), true)
	} else if st.IsDir() {
		r.add("daemon", false, fmt.Sprintf("%s is a directory", daemonPath), true)
	} else if runtime.GOOS != "windows" && st.Mode().Perm()&0o111 == 0 {
		r.add("daemon", false, fmt.Sprintf("%s is not executable", resolved), true)
	} else {
		r.add("daemon", true, resolved, true)
	}

	// Data dir: must exist (create) and be writable (fatal).
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		r.add("datadir", false, fmt.Sprintf("%s: %v", dataDir, err), true)
	} else if f, err := os.CreateTemp(dataDir, ".writetest-*"); err != nil {
		r.add("datadir", false, fmt.Sprintf("%s not writable: %v", dataDir, err), true)
	} else {
		name := f.Name()
		f.Close()
		os.Remove(name)
		r.add("datadir", true, dataDir, true)
	}

	// Stale pidfile: informational (a stale file hints at an unclean shutdown).
	if raw, err := os.ReadFile(filepath.Join(dataDir, "daemon.pid")); err == nil {
		pid := strings.TrimSpace(string(raw))
		if pid != "" && !pidAlive(pid) {
			r.add("pidfile", true, fmt.Sprintf("stale pid %s (unclean shutdown?)", pid), false)
		} else {
			r.add("pidfile", true, fmt.Sprintf("live pid %s", pid), false)
		}
	} else {
		r.add("pidfile", true, "absent (fresh start)", false)
	}

	// Python / shell: informational only. EnsurePython/EnsureShell have
	// side effects (managed downloads) — the boot role only PROBES here;
	// the daemon performs the real ensure at startup.
	if bin, err := probePython(); err == nil && bin != "" {
		r.add("python", true, bin, false)
	} else {
		r.add("python", false, "no usable python (daemon will try managed download, else disable python tool)", false)
	}
	if shell, err := detectShell(); err == nil && shell != "" {
		r.add("shell", true, shell, false)
	} else {
		r.add("shell", false, "no usable shell detected (daemon will try managed unish)", false)
	}

	return r
}
