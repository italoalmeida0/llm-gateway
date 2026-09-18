// Command launcher is the distribution entry point for Indirect Code.
//
// The launcher owns everything that prepares the ground before the daemon
// runs — dependency checkup, storage migrations, integrity verification —
// and then execs the daemon with resolved metadata. The daemon itself
// assumes the current storage format and fails fast otherwise: zero
// The daemon assumes the current layout and fails fast otherwise:
// versioned as a migration chain (see internal/migrations).
//
// Usage:
//
//	launcher [flags] [-- daemon-args...]
//	  -data-dir DIR     daemon data directory (default: platform default)
//	  -daemon PATH      daemon binary (default: indirect-code next to launcher)
//	  -check-only       run checkup + migrations + verify, then exit (no exec)
//	  -migrate-only     run pending migrations, then exit
//	  -verify-only      run integrity verification, then exit
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/internal/migrations"
)

// launcherVersion is stamped at build time via ldflags
// (-X main.launcherVersion=vX.Y.Z); dev builds report "dev".
var launcherVersion = "dev"

func main() {
	dataDirFlag := flag.String("data-dir", "", "Path to daemon data directory")
	daemonFlag := flag.String("daemon", "", "Path to daemon binary (default: self-managed download)")
	checkOnly := flag.Bool("check-only", false, "Run checkup + migrations + verify, then exit without starting the daemon")
	migrateOnly := flag.Bool("migrate-only", false, "Run pending migrations, then exit")
	verifyOnly := flag.Bool("verify-only", false, "Run integrity verification, then exit")
	versionFlag := flag.Bool("version", false, "Print launcher version and exit")
	stopFlag := flag.Bool("stop", false, "Stop the background daemon (reads daemon.pid) and exit")
	connectFlag := flag.String("connect", "", "Pairing connect URL (forwarded to the daemon)")
	nameFlag := flag.String("name", "", "Host display name (forwarded to the daemon)")
	// Takeover mode uses its own flags (--from-slot etc.): intercept BEFORE
	// flag.Parse(), which would exit on unknown flags.
	for _, a := range os.Args[1:] {
		if a == "--takeover" {
			dataDir, fromSlot, toSlot, expectVersion, handoffFile, parentPid := parseTakeoverFlags(os.Args[1:])
			os.Exit(runTakeover(dataDir, fromSlot, toSlot, expectVersion, handoffFile, parentPid))
		}
	}
	flag.Parse()
	if *versionFlag {
		fmt.Printf("indirect-code launcher %s\n", launcherVersion)
		return
	}

	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = defaultDataDir()
	}
	// dataDir here is the ROOT (<root>, not a slot): the daemon always
	// runs with --data-dir <root>/slots/slot-x (see exec below), while
	// root-level concerns (layout repair, stop, migrations) use the root.
	rootDir := dataDir

	if *stopFlag {
		if err := stopDaemon(rootDir); err != nil {
			fmt.Printf("Stop failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	daemonPath := *daemonFlag
	activeSlot := ""
	slotDir := ""
	if daemonPath == "" {
		var err error
		daemonPath, activeSlot, err = resolveSlotDaemon(rootDir)
		if err != nil {
			fmt.Printf("[FETCH] failed: %v\n", err)
			os.Exit(1)
		}
		slotDir = filepath.Join(rootDir, "slots", "slot-"+activeSlot)
	}
	// Daemon CLI surface passthrough (connect/stop live in the daemon).
	daemonArgs := flag.Args()
	if *connectFlag != "" {
		daemonArgs = append([]string{"-connect", *connectFlag}, daemonArgs...)
	}
	if *nameFlag != "" {
		daemonArgs = append([]string{"--name", *nameFlag}, daemonArgs...)
	}

	// 1. Checkup: dependencies and environment ready?
	report := runCheckup(rootDir, daemonPath)
	report.print()
	if !report.ok() {
		os.Exit(1)
	}

	// 2. Migrations: storage chain up to date (slot-local stamp)?
	migrateDir := slotDir
	if migrateDir == "" {
		migrateDir = rootDir
	}
	applied, err := migrations.Migrate(migrateDir)
	if err != nil {
		fmt.Printf("[MIGRATE] failed: %v\n", err)
		os.Exit(1)
	}
	if len(applied) > 0 {
		fmt.Printf("[MIGRATE] applied: %v\n", applied)
	} else {
		fmt.Printf("[MIGRATE] storage v%d up to date\n", migrations.CurrentVersion)
	}
	if *migrateOnly {
		return
	}

	// 3. Integrity: daemon binary + storage sane?
	verifyDir := slotDir
	if verifyDir == "" {
		verifyDir = rootDir
	}
	if err := verifyAll(verifyDir, daemonPath); err != nil {
		fmt.Printf("[VERIFY] failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[VERIFY] ok\n")
	if *checkOnly || *verifyOnly {
		return
	}

	// 4. Run the daemon with --data-dir pointing AT THE SLOT (canonical:
	// dataDir = <root>/slots/slot-x; sessions/config/pid are slot-local).
	// Handoff restarts are driven by takeover (the NEW launcher runs the
	// new daemon) — no exit-code protocol. Unexpected exits restart with
	// backoff a few times (crash resilience), then give up.
	daemonDataDir := slotDir
	if daemonDataDir == "" {
		daemonDataDir = rootDir // explicit -daemon override: run wherever told
	}
	if activeSlot != "" {
		daemonArgs = append([]string{"--slot", activeSlot}, daemonArgs...)
	}
	crashes := 0
	for {
		fmt.Printf("[LAUNCH] starting daemon %s (data: %s)\n", daemonPath, daemonDataDir)
		code, err := execDaemon(daemonPath, daemonDataDir, daemonArgs)
		if err == nil {
			os.Exit(code)
		}
		stopReq := filepath.Join(daemonDataDir, "stop.req")
		if _, serr := os.Stat(stopReq); serr == nil {
			_ = os.Remove(stopReq)
			os.Exit(code)
		}
		fmt.Printf("[LAUNCH] daemon exited %d: %v\n", code, err)
		crashes++
		if crashes > 3 {
			fmt.Printf("[LAUNCH] daemon keeps exiting — giving up. Check %s.\n", filepath.Join(rootDir, "logs", "daemon.log"))
			os.Exit(code)
		}
		wait := time.Duration(crashes) * 5 * time.Second
		fmt.Printf("[LAUNCH] restarting in %v (crash #%d)...\n", wait, crashes)
		time.Sleep(wait)
	}
}

// logHint points at the slot's daemon.log (canonical: logs live at
// <root>/logs/; the install scripts wire daemon stdout there).
// (Kept as documentation: the message above builds the path inline.)

func stopDaemon(rootDir string) error {
	// pid is slot-local (canonical): check the active slot first, then
	// the other slot, then a stray root pidfile (adopted by ensureLayout
	// on next boot, but stop should work even before that).
	cands := []string{}
	if active := readActiveSlot(filepath.Join(rootDir, "slots")); active != "" {
		cands = append(cands, filepath.Join(rootDir, "slots", "slot-"+active, "daemon.pid"))
		other := "b"
		if active == "b" {
			other = "a"
		}
		cands = append(cands, filepath.Join(rootDir, "slots", "slot-"+other, "daemon.pid"))
	} else {
		cands = append(cands,
			filepath.Join(rootDir, "slots", "slot-a", "daemon.pid"),
			filepath.Join(rootDir, "slots", "slot-b", "daemon.pid"))
	}
	cands = append(cands, filepath.Join(rootDir, "daemon.pid"))
	pidPath := ""
	var raw []byte
	for _, c := range cands {
		if b, err := os.ReadFile(c); err == nil {
			pidPath, raw = c, b
			break
		}
	}
	if pidPath == "" {
		fmt.Printf("[STOP] no daemon.pid found under %s (daemon is not running)\n", rootDir)
		return nil
	}

	pid := strings.TrimSpace(string(raw))
	if pid == "" || !pidAlive(pid) {
		_ = os.Remove(pidPath)
		fmt.Printf("[STOP] daemon (pid %s) was not running\n", pid)
		return nil
	}

	// Signal stop to prevent launcher loop from restarting daemon
	// (stop.req lives next to the pidfile: slot-local).
	stopReq := filepath.Join(filepath.Dir(pidPath), "stop.req")
	_ = os.WriteFile(stopReq, []byte("stop\n"), 0o600)
	defer os.Remove(stopReq)

	fmt.Printf("[STOP] stopping daemon (pid %s)...\n", pid)
	if err := terminateParentWait(pid, 5*time.Second); err != nil {
		return err
	}
	_ = os.Remove(pidPath)
	fmt.Printf("[STOP] daemon stopped successfully\n")
	return nil
}
