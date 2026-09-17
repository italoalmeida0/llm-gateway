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

const launcherVersion = 1

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
	flag.Parse()

	if *versionFlag {
		fmt.Printf("indirect-code launcher v%d\n", launcherVersion)
		return
	}

	dataDir := *dataDirFlag
	if dataDir == "" {
		dataDir = defaultDataDir()
	}
	daemonPath := *daemonFlag
	if daemonPath == "" {
		var err error
		daemonPath, err = resolveDaemon(dataDir)
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

	// 4. Supervise: run the daemon; on exit code 42 (update restart)
	// re-resolve (newest staged wins) and run again. Any other exit
	// ends the launcher. Consecutive 42s are bounded: a broken binary
	// that instantly re-requests restart must not hot-loop forever.
	restarts := 0
	for {
		fmt.Printf("[LAUNCH] starting daemon %s (data: %s)\n", daemonPath, dataDir)
		code, err := execDaemon(daemonPath, dataDir, daemonArgs)
		if err != nil && code != 42 {
			fmt.Printf("[LAUNCH] failed: %v\n", err)
			os.Exit(1)
		}
		if code != 42 {
			os.Exit(code)
		}
		restarts++
		if restarts > 5 {
			fmt.Printf("[LAUNCH] update restart looped %d times — refusing to continue (broken staged binary?). Remove bin/daemon-* and retry.\n", restarts-1)
			os.Exit(1)
		}
		// Backoff: instant 42s (crashing new binary) shouldn't spin.
		time.Sleep(time.Duration(restarts) * 2 * time.Second)
		fmt.Printf("[LAUNCH] update restart #%d: re-resolving daemon...\n", restarts)
		if *daemonFlag == "" {
			np, rerr := resolveDaemon(dataDir)
			if rerr != nil {
				fmt.Printf("[LAUNCH] re-resolve failed: %v\n", rerr)
				os.Exit(1)
			}
			daemonPath = np
		}
		// Re-run migrations (a new daemon version may need a new schema).
		if applied, merr := migrations.Migrate(dataDir); merr != nil {
			fmt.Printf("[MIGRATE] failed: %v\n", merr)
			os.Exit(1)
		} else if len(applied) > 0 {
			fmt.Printf("[MIGRATE] applied: %v\n", applied)
		}
		if verr := verifyAll(dataDir, daemonPath); verr != nil {
			fmt.Printf("[VERIFY] failed: %v\n", verr)
			os.Exit(1)
		}
	}
}
