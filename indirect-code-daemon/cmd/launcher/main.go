// Command launcher is the distribution entry point for Indirect Code.
//
// The launcher owns everything that prepares the ground before the daemon
// runs — dependency checkup, storage migrations, integrity verification —
// and then execs the daemon with resolved metadata. The daemon itself
// assumes the current storage format and fails fast otherwise: zero
// legacy branches in daemon code, all compatibility lives here,
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
	daemonPath := *daemonFlag
	activeSlot := ""
	if daemonPath == "" {
		var err error
		daemonPath, activeSlot, err = resolveSlotDaemon(dataDir)
		if err != nil {
			fmt.Printf("[FETCH] failed: %v\n", err)
			os.Exit(1)
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
	if *stopFlag {
		// --stop needs no checkup/migrations: forward directly.
		if code, err := execDaemon(daemonPath, dataDir, append([]string{"--stop"}, daemonArgs...)); err != nil {
			fmt.Printf("[LAUNCH] failed: %v\n", err)
			os.Exit(code)
		}
		return
	}

	// 1. Checkup: dependencies and environment ready?
	report := runCheckup(dataDir, daemonPath)
	report.print()
	if !report.ok() {
		os.Exit(1)
	}

	// 2. Migrations: storage chain up to date?
	applied, err := migrations.Migrate(dataDir)
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
	if err := verifyAll(dataDir, daemonPath); err != nil {
		fmt.Printf("[VERIFY] failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("[VERIFY] ok\n")
	if *checkOnly || *verifyOnly {
		return
	}

	// 4. Run the daemon once (slot-aware path resolved above). Handoff
	// restarts are driven by takeover (the NEW launcher runs the new
	// daemon) — no exit-code protocol. Unexpected exits restart with
	// backoff a few times (crash resilience), then give up.
	if activeSlot != "" {
		daemonArgs = append([]string{"--slot", activeSlot}, daemonArgs...)
	}
	crashes := 0
	for {
		fmt.Printf("[LAUNCH] starting daemon %s (data: %s)\n", daemonPath, dataDir)
		code, err := execDaemon(daemonPath, dataDir, daemonArgs)
		if err == nil {
			os.Exit(code)
		}
		fmt.Printf("[LAUNCH] daemon exited %d: %v\n", code, err)
		crashes++
		if crashes > 3 {
			fmt.Printf("[LAUNCH] daemon keeps exiting — giving up. Check daemon.log.\n")
			os.Exit(code)
		}
		wait := time.Duration(crashes) * 5 * time.Second
		fmt.Printf("[LAUNCH] restarting in %v (crash #%d)...\n", wait, crashes)
		time.Sleep(wait)
	}
}
