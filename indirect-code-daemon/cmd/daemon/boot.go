// bootMain is the BOOT role of the multi-call Indirect Code binary (see
// main.go for routing): everything that prepares the ground before the
// worker runs — dependency checkup, storage migrations, integrity
// verification — then self-starts the worker and supervises it. The
// worker assumes the current layout and fails fast otherwise (storage is
// versioned as a migration chain, see internal/migrations).
//
// Usage:
//
//	indirect-code [flags] [-- worker-args...]
//	  -data-dir DIR     data root (default: platform default)
//	  -daemon PATH      worker binary (default: this binary, worker mode)
//	  -check-only       run checkup + migrations + verify, then exit (no exec)
//	  -migrate-only     run pending migrations, then exit
//	  -verify-only      run integrity verification, then exit
package main

import (
	"errors"
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

func bootMain() {
	dataDirFlag := flag.String("data-dir", "", "Path to daemon data directory")
	daemonFlag := flag.String("daemon", "", "Path to the worker binary (default: this binary, self-started in worker mode)")
	checkOnly := flag.Bool("check-only", false, "Run checkup + migrations + verify, then exit without starting the daemon")
	migrateOnly := flag.Bool("migrate-only", false, "Run pending migrations, then exit")
	verifyOnly := flag.Bool("verify-only", false, "Run integrity verification, then exit")
	versionFlag := flag.Bool("version", false, "Print version and exit (boot role banner)")
	stopFlag := flag.Bool("stop", false, "Stop the background daemon (reads daemon.pid) and exit")
	connectFlag := flag.String("connect", "", "Pairing connect URL (forwarded to the daemon)")
	nameFlag := flag.String("name", "", "Host display name (forwarded to the daemon)")
	// Intercept BEFORE flag.Parse(), which would exit on unknown flags.
	for _, a := range os.Args[1:] {
		if a == "--update" {
			rootDir, fromSlot, toSlot, expectVersion, oldVersion, failFile, doneFile, parentPid := parseUpdateFlags(os.Args[1:])
			os.Exit(runUpdate(rootDir, fromSlot, toSlot, expectVersion, oldVersion, failFile, doneFile, parentPid))
		}
	}
	flag.Parse()
	if *versionFlag {
		fmt.Printf("indirect-code boot %s\n", launcherVersion)
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
	quietStep := func(msg string) func() {
		fmt.Printf("%s ... ", msg)
		return func() { fmt.Println("done") }
	}
	fail := func(format string, args ...any) {
		fmt.Println("FAILED")
		fmt.Printf("Error: "+format+"\n", args...)
		fmt.Printf("See %s for details.\n", filepath.Join(rootDir, "logs", "daemon.log"))
		os.Exit(1)
	}
	if daemonPath == "" {
		done := quietStep("Preparing")
		var err error
		var notes []string
		daemonPath, activeSlot, notes, err = resolveSlotDaemon(rootDir)
		if err != nil {
			done()
			fail("setup failed: %v", err)
		}
		slotDir = filepath.Join(rootDir, "slots", "slot-"+activeSlot)
		done()
		if len(notes) > 0 {
			fmt.Printf("Repaired %d issue(s) — see %s.\n", len(notes), filepath.Join(rootDir, "logs", "install.log"))
		}
	}
	// Daemon CLI surface passthrough (connect/stop live in the daemon).
	daemonArgs := flag.Args()
	if *connectFlag != "" {
		daemonArgs = append([]string{"-connect", *connectFlag}, daemonArgs...)
	}
	if *nameFlag != "" {
		daemonArgs = append([]string{"--name", *nameFlag}, daemonArgs...)
	}

	// 1. Checkup: dependencies and environment ready? Silent on success;
	// on failure print the one-line error + full report.
	report := runCheckup(rootDir, daemonPath)
	if !report.ok() {
		report.print()
		report.printVerbose()
		fail("environment check failed")
	}

	// 2. Migrations: storage chain up to date (slot-local stamp). Silent
	// when already current.
	migrateDir := slotDir
	if migrateDir == "" {
		migrateDir = rootDir
	}
	applied, err := migrations.Migrate(migrateDir)
	if err != nil {
		fail("migration failed: %v", err)
	}
	_ = applied // silent when current; repairs are reported via [REPAIR] above
	if *migrateOnly {
		return
	}

	// 3. Integrity: daemon binary + storage sane? Silent on success.
	verifyDir := slotDir
	if verifyDir == "" {
		verifyDir = rootDir
	}
	if err := verifyAll(verifyDir, daemonPath); err != nil {
		fail("verification failed: %v", err)
	}
	if *checkOnly || *verifyOnly {
		return
	}

	// 4. Run the daemon with --data-dir pointing AT THE SLOT (canonical:
	// dataDir = <root>/slots/slot-x; sessions/config/pid are slot-local).
	// Update restarts are driven by the brutal protocol (app --update
	// spawns --update-end detached) — no exit-code protocol. Unexpected exits restart with
	// backoff a few times (crash resilience), then give up.
	daemonDataDir := slotDir
	if daemonDataDir == "" {
		daemonDataDir = rootDir // explicit -daemon override: run wherever told
	}
	if activeSlot != "" {
		daemonArgs = append([]string{"--slot", activeSlot}, daemonArgs...)
	}
	crashes := 0
	fmt.Println("Ready — listening for turns.")
	for {
		code, err := execDaemon(daemonPath, daemonDataDir, daemonArgs)
		if errors.Is(err, errUpdateHandoff) {
			return
		}
		if err == nil {
			os.Exit(code)
		}
		stopReq := filepath.Join(daemonDataDir, "stop.req")
		if _, serr := os.Stat(stopReq); serr == nil {
			_ = os.Remove(stopReq)
			os.Exit(code)
		}
		crashes++
		if crashes > 3 {
			fail("daemon keeps exiting (last exit %d: %v)", code, err)
		}
		wait := time.Duration(crashes) * 5 * time.Second
		fmt.Printf("Warning: daemon exited %d (%v) — restarting in %v (attempt %d/3) ...\n", code, err, wait, crashes)
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

	// Signal stop to prevent the boot loop from restarting daemon
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
