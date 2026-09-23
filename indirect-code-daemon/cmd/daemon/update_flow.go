package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Brutal update protocol (--update-start / --update-end).
//
// Philosophy: the daemon already recovers running turns from disk after a
// crash (resetRunningSessions + resumeInterruptedTurns on every boot), so
// the update path leans on that instead of the delicate quiesce/freeze
// dance. The handoff is brutal on purpose: SIGKILL, never SIGTERM (a
// graceful shutdown would COMMIT running turns as cancelled and the new
// daemon would have nothing to resume).
//
// Roles:
//   - ACTIVE daemon (serving): cleans the target slot (never its own),
//     downloads the new launcher, verifies it runs the expected version
//     AND that the version is newer than its own, then spawns ITSELF with
//     --update-start (passing its own pid) and keeps serving until killed.
//   - --update-start (naive): loads NO sessions (fully naive, zero turn
//     state), SIGKILLs the old daemon (the brutal pause), takes over the
//     active pidfile, connects to the relay with ?updating=1 (the relay
//     broadcasts host_status updating so the frontend shows the overlay), copies its own
//     slot data into the update slot, spawns the NEW launcher in --update
//     mode, then polls the slots dir every 100ms up to 2 minutes.
//   - launcher --update: migrates the new slot, downloads the new daemon,
//     verifies it (runs + expected version + strictly newer than the old
//     one). On ANY failure it writes the fail file
//     (<root>/slots/update.fail) and exits — the signal is only ever
//     emitted when the launcher is ready to be killed. On success it
//     spawns the new daemon with --update-end (detached) and exits 0.
//   - --update-end (new daemon): boots on the new slot, atomically commits
//     slots/active, then attempts one relay connection, SIGKILLs the waiter,
//     deletes the old slot and reports update_done. Interrupted turns
//     resume only after promotion succeeds.
//
// Fail path: --update-start sees update.fail (or a timeout/launcher exit
// without update.done), SIGKILLs the launcher if still alive, deletes the
// update slot, reports update_failed + back-to-normal daemon_update to the
// relay, then re-execs ITSELF as a normal daemon on the untouched active
// slot (crash recovery resumes the turns the SIGKILL interrupted).

const (
	// updatePollInterval is the fail/done file poll step (never a 2min sleep).
	updatePollInterval = 100 * time.Millisecond
	// updateTimeout caps the whole launcher phase watched by --update-start.
	updateTimeout = 2 * time.Minute
	// updateSettleWait caps the wait-to-be-killed after update.done.
	updateSettleWait = 30 * time.Second
)

// updateFailPath is the launcher failure signal inside the slots dir.
func updateFailPath(root string) string { return filepath.Join(root, "slots", "update.fail") }

// updateDonePath is the --update-end success signal inside the slots dir.
func updateDonePath(root string) string { return filepath.Join(root, "slots", "update.done") }

// writeUpdateSignal writes a fail/done signal file (tmp+rename, fsync-free:
// the 100ms poller tolerates a torn read by retrying).
func writeUpdateSignal(path, body string) {
	_ = os.MkdirAll(filepath.Dir(path), 0o700)
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upd-*")
	if err != nil {
		return
	}
	_, _ = tmp.WriteString(body)
	_ = tmp.Close()
	_ = os.Rename(tmp.Name(), path)
}

// readUpdateSignal returns the trimmed body when the file exists.
func readUpdateSignal(path string) (string, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(raw)), true
}

// compareVersions orders version strings. Strips a leading "v", ignores
// build metadata (+...), compares numeric components numerically and
// non-numeric ones lexically; missing components count as 0.
// "dev"/"" never outrank anything (dev builds never self-update).
func compareVersions(a, b string) int {
	norm := func(v string) []string {
		v = strings.TrimSpace(v)
		v = strings.TrimPrefix(v, "v")
		v = strings.TrimPrefix(v, "V")
		if i := strings.Index(v, "+"); i >= 0 {
			v = v[:i]
		}
		v = strings.ReplaceAll(v, "-", ".")
		if v == "" {
			return nil
		}
		return strings.Split(v, ".")
	}
	pa, pb := norm(a), norm(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var ca, cb string
		if i < len(pa) {
			ca = pa[i]
		}
		if i < len(pb) {
			cb = pb[i]
		}
		if ca == cb {
			continue
		}
		na, ea := strconv.Atoi(ca)
		nb, eb := strconv.Atoi(cb)
		if ea == nil && eb == nil {
			if na != nb {
				if na < nb {
					return -1
				}
				return 1
			}
			continue
		}
		if ca < cb {
			return -1
		}
		return 1
	}
	return 0
}

// isVersionNewer reports whether newV is strictly greater than oldV.
// Empty/dev versions never qualify (dev builds never self-update).
func isVersionNewer(newV, oldV string) bool {
	newV = strings.TrimSpace(newV)
	oldV = strings.TrimSpace(oldV)
	if newV == "" || oldV == "" {
		return false
	}
	if strings.EqualFold(newV, "dev") || strings.EqualFold(oldV, "dev") {
		return false
	}
	if newV == oldV {
		return false
	}
	return compareVersions(newV, oldV) > 0
}

// killPidBrutal SIGKILLs pid (never SIGTERM: a graceful shutdown would
// commit running turns as cancelled instead of leaving WALs for resume)
// and polls every 100ms until the process is gone.
func killPidBrutal(pid int) error {
	if pid <= 0 {
		return fmt.Errorf("invalid pid %d", pid)
	}
	if pid == os.Getpid() {
		return fmt.Errorf("refusing to kill self")
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	// Already gone is success (previous attempt won the race).
	if !pidAliveStr(strconv.Itoa(pid)) {
		return nil
	}
	if err := proc.Kill(); err != nil {
		if !pidAliveStr(strconv.Itoa(pid)) {
			return nil
		}
		return fmt.Errorf("kill pid %d: %w", pid, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAliveStr(strconv.Itoa(pid)) {
			return nil
		}
		time.Sleep(updatePollInterval)
	}
	return fmt.Errorf("pid %d survived SIGKILL", pid)
}

// slotPidFiles lists every pidfile that can hold our processes inside
// a slot dir (daemon + updater share daemon.pid; the launcher never
// writes one, so it is found via /proc scan below).
func slotPidFiles(slotDir string) []string {
	return []string{filepath.Join(slotDir, "daemon.pid")}
}

// killSlotProcesses SIGKILLs every OUR process running from slotDir
// (daemon or launcher binaries), except ownPid. Strategy:
//  1. read the slot pidfiles (daemon.pid) and kill those pids;
//  2. scan /proc for processes whose exe/cmdline points inside slotDir
//     (catches the launcher --update child, which writes no pidfile).
// Windows uses a Toolhelp32 process snapshot instead of /proc.
// Never kills ownPid, never fails the caller (best-effort, logs only).
func killSlotProcesses(slotDir string, ownPid int, logf func(string, ...any)) {
	seen := map[int]bool{}
	kill := func(pid int, why string) {
		if pid <= 0 || pid == ownPid || seen[pid] {
			return
		}
		seen[pid] = true
		if !pidAliveStr(strconv.Itoa(pid)) {
			return
		}
		proc, err := os.FindProcess(pid)
		if err != nil {
			return
		}
		if err := proc.Kill(); err != nil {
			if pidAliveStr(strconv.Itoa(pid)) {
				logf("kill slot process %d (%s): %v", pid, why, err)
			}
			return
		}
		logf("killed stale process %d (%s)", pid, why)
	}
	for _, pf := range slotPidFiles(slotDir) {
		raw, err := os.ReadFile(pf)
		if err != nil {
			continue
		}
		if n, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
			kill(n, "pidfile")
		}
	}
	killSlotProcessesByDir(slotDir, ownPid, kill)
	// Poll 100ms steps (max ~5s) until the kills land, so a RemoveAll
	// right after never hits "text file busy" / half-dead handles.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		quiesced := true
		for pid := range seen {
			if pid != ownPid && pidAliveStr(strconv.Itoa(pid)) {
				quiesced = false
				break
			}
		}
		if quiesced {
			return
		}
		time.Sleep(updatePollInterval)
	}
}

// pidAliveStr probes liveness without affecting the process:
// unix signal 0 (+ /proc zombie filter), windows tasklist probe.
func pidAliveStr(pid string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(pid))
	if err != nil || n <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", n), "/NH").Output()
		if err != nil {
			return true // unknown: assume live, caller re-checks
		}
		return strings.Contains(string(out), strconv.Itoa(n))
	}
	return pidAliveUnixSignal(n)
}

// cleanInactiveSlot empties the update target dir. It REFUSES to touch the
// daemon's own slot (passing active==inactive or an own-dir path aborts):
// wiping the live slot would destroy the running daemon's storage.
func inactiveSlotPath(root, active, inactive, ownDir string) (string, error) {
	if (active != "a" && active != "b") || (inactive != "a" && inactive != "b") || active == inactive {
		return "", fmt.Errorf("invalid slot cleanup %q -> %q", active, inactive)
	}
	target := filepath.Join(root, "slots", "slot-"+inactive)
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	own, err := filepath.Abs(ownDir)
	if err != nil {
		return "", err
	}
	targetInfo, targetErr := os.Stat(absTarget)
	ownInfo, ownErr := os.Stat(own)
	if absTarget == own || (targetErr == nil && ownErr == nil && os.SameFile(targetInfo, ownInfo)) {
		return "", fmt.Errorf("refusing to clean own slot dir %q", absTarget)
	}
	if raw, err := os.ReadFile(filepath.Join(root, "slots", "active")); err == nil && strings.TrimSpace(string(raw)) == inactive {
		return "", fmt.Errorf("refusing to clean active slot %q", inactive)
	}
	return absTarget, nil
}

func removeInactiveSlot(root, active, inactive, ownDir string) error {
	target, err := inactiveSlotPath(root, active, inactive, ownDir)
	if err != nil {
		return err
	}
	return os.RemoveAll(target)
}

func cleanInactiveSlot(root, active, inactive, ownDir string) error {
	if err := removeInactiveSlot(root, active, inactive, ownDir); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(root, "slots", "slot-"+inactive), 0o700)
}

// spawnUpdateStart re-spawns THIS binary in --update-start mode (detached):
// the child SIGKILLs us once it is ready, so we just keep serving until
// that happens. root/active/inactive identify the slots, version is the
// manifest target, launcherPath is the verified new launcher binary.
func spawnUpdateStart(root, active, inactive, version, launcherPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	activeDir := filepath.Join(root, "slots", "slot-"+active)
	// The child needs the mirror: inherit INDIRECT_REPO_RAW (harness/mirror
	// override) plus the gateway base so launcher --update can fetch.
	envGateway := os.Getenv("INDIRECT_REPO_RAW")
	cmd := exec.Command(exe,
		"--data-dir", activeDir,
		"--config", filepath.Join(activeDir, "config.json"),
		"--slot", active,
		"--update-start",
		"--root-dir", root,
		"--from-slot", active,
		"--to-slot", inactive,
		"--expect-version", version,
		"--parent-pid", strconv.Itoa(os.Getpid()),
		"--launcher-path", launcherPath,
	)
	if envGateway != "" {
		cmd.Env = append(os.Environ(), "INDIRECT_REPO_RAW="+envGateway)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Detached: the parent keeps serving (and dies by SIGKILL, never by
	// waiting on this child).
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("spawn --update-start: %w", err)
	}
	return nil
}

// updateStartParams carries the --update-start CLI flags.
type updateStartParams struct {
	root, fromSlot, toSlot, expectVersion, launcherPath string
	parentPid                                           int
	stopServing                                         func()
}

// runUpdateStart is the naive updater: no sessions are ever loaded (fully
// naive pre-start), it kills the old daemon brutally, owns the host in
// "update" state, copies its own slot into the update slot, runs the new
// launcher and watches the fail/done signals. Returns the process exit code.
func runUpdateStart(dataDir, cfgPath string, p updateStartParams) int {
	logf := func(format string, args ...any) {
		fmt.Printf("[UPDATE-START] "+format+"\n", args...)
	}
	// Stale signals from a previous attempt must never gate this one.
	_ = os.Remove(updateFailPath(p.root))
	_ = os.Remove(updateDonePath(p.root))

	server := &DaemonServer{
		configPath: cfgPath,
		dataDir:    dataDir,
		sessions:   make(map[string]*ActiveSession),
	}
	server.sharedDir = filepath.Join(server.rootDir(), "external")
	if err := server.loadConfig(); err != nil || server.config == nil {
		logf("config: %v", err)
		return 1
	}
	// Claim this specific daemon's restart before SIGKILL. Its launcher
	// must exit instead of racing the updater by respawning the old side.
	requestPath := filepath.Join(dataDir, "update.req")
	if err := writeConfigFile(requestPath, []byte(strconv.Itoa(p.parentPid)+"\n")); err != nil {
		logf("claim restart: %v", err)
		return 1
	}
	logf("stopping old daemon pid %d...", p.parentPid)
	if err := killPidBrutal(p.parentPid); err != nil {
		_ = os.Remove(requestPath)
		logf("old daemon kill: %v (aborting)", err)
		return 1
	}
	// Take over the ACTIVE pidfile so --stop/install scripts find US now.
	server.writePidFile()

	// Record the target for forensics (broadcastUpdateState is a no-op
	// without a socket; the relay reports host_status updating from the
	// ?updating=1 query — that is the ONLY updating signal).
	server.updateChecker().mu.Lock()
	server.updateChecker().available = p.expectVersion
	server.updateChecker().mu.Unlock()

	// WS in the background with retry: without the relay the update still
	// proceeds (the frontend sees offline, then the normal state after).
	p.stopServing = server.startUpdateRelay(logf)
	defer p.stopServing()

	// Copy OUR OWN slot data into the update slot (disk is stable now —
	// the old daemon is dead, nothing appends; no quiesce needed).
	toDir := filepath.Join(p.root, "slots", "slot-"+p.toSlot)
	sl := server.slots()
	if err := server.copyToSlot(sl, toDir); err != nil {
		return updateStartFail(server, nil, p, fmt.Sprintf("copy sessions: %v", err), logf)
	}

	// Run the NEW launcher in --update mode (it migrates + fetches +
	// verifies the new daemon, then spawns --update-end detached).
	failFile := updateFailPath(p.root)
	doneFile := updateDonePath(p.root)
	_ = os.Remove(failFile)
	_ = os.Remove(doneFile)
	cmd := exec.Command(p.launcherPath,
		"--update",
		"--root-dir", p.root,
		"--from-slot", p.fromSlot,
		"--to-slot", p.toSlot,
		"--expect-version", p.expectVersion,
		"--old-version", daemonVersion,
		"--fail-file", failFile,
		"--done-file", doneFile,
		"--parent-pid", strconv.Itoa(os.Getpid()),
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	// Pass the paired gateway explicitly: --root-dir may be outside the
	// default install, and ambient mirror settings may belong to another host.
	cmd.Env = append(os.Environ(), "INDIRECT_GATEWAY="+gatewayBaseURL(server))
	if err := cmd.Start(); err != nil {
		return updateStartFail(server, nil, p, fmt.Sprintf("launcher start: %v", err), logf)
	}
	logf("launcher started (pid %d), watching signals...", cmd.Process.Pid)
	launcherDone := make(chan error, 1)
	go func() { launcherDone <- cmd.Wait() }()
	launcherErr, launcherExitedAt := error(nil), time.Time{}

	deadline := time.Now().Add(updateTimeout)
	for time.Now().Before(deadline) {
		if body, ok := readUpdateSignal(doneFile); (ok && body != "") || updateSlotCommitted(p) {
			logf("update done (%s), settling...", body)
			// --update-end owns the host now; it SIGKILLs us. If the
			// kill never arrives (it crashed post-flip), exit anyway
			// so no ghost serves the deleted slot.
			<-time.After(5 * time.Second)
			settle := time.Now().Add(updateSettleWait)
			for time.Now().Before(settle) {
				time.Sleep(updatePollInterval)
			}
			return 0
		}
		if body, ok := readUpdateSignal(failFile); ok && body != "" {
			return updateStartFail(server, cmd.Process, p, body, logf)
		}
		select {
		case err := <-launcherDone:
			launcherErr, launcherExitedAt = err, time.Now()
			logf("launcher exited: %v", err)
		default:
		}
		if launcherErr != nil && time.Since(launcherExitedAt) > 5*time.Second {
			// Launcher died WITHOUT writing the fail signal: synthesize
			// the failure (the signal must only come from the launcher
			// when it is ready, but a dead launcher is a failure too).
			return updateStartFail(server, nil, p, fmt.Sprintf("launcher exited: %v", launcherErr), logf)
		}
		time.Sleep(updatePollInterval)
	}
	return updateStartFail(server, cmd.Process, p, "update timed out (2min)", logf)
}

// updateStartFail kills the launcher if still alive, deletes the update
// slot, reports update_failed + back-to-normal to the relay, then re-execs
// THIS binary as a normal daemon on the untouched active slot (crash
// recovery resumes the SIGKILLed turns).
func updateStartFail(server *DaemonServer, launcherProc *os.Process, p updateStartParams, reason string, logf func(string, ...any)) int {
	// The active marker is authoritative even if the done signal was lost.
	if updateSlotCommitted(p) {
		return 0
	}
	logf("update failed: %s", reason)
	if launcherProc != nil {
		_ = launcherProc.Kill()
	}
	// Sweep the update slot: kill EVERYTHING still running from it
	// (launcher --update child, stray --update-end that booted but never
	// promoted) so the RemoveAll below never hits "text file busy" and
	// no zombie serves the dead slot afterwards.
	toDir := filepath.Join(p.root, "slots", "slot-"+p.toSlot)
	killSlotProcesses(toDir, os.Getpid(), logf)
	// Delete the update slot (never the active one: guard inside).
	_ = cleanInactiveSlot(p.root, p.fromSlot, p.toSlot, server.dataDir)
	_ = os.Remove(updateFailPath(p.root))
	_ = os.Remove(updateDonePath(p.root))
	st := server.updateChecker()
	st.mu.Lock()
	st.lastError = reason
	st.mu.Unlock()
	server.broadcastUpdateState()
	_ = server.sendWS(map[string]any{
		"type": "update_failed", "hostId": server.config.HostID, "reason": reason,
	})
	// Back to normal life by re-exec: the normal boot path (crash
	// recovery intact) resumes the interrupted turns. Brutal-philosophy:
	// rebirth instead of in-place resuscitation.
	activeDir := filepath.Join(p.root, "slots", "slot-"+p.fromSlot)
	if p.stopServing != nil {
		p.stopServing() // Join the loop before Windows spawns and waits.
	} else {
		server.closeWS()
	}
	exe, err := os.Executable()
	if err != nil {
		logf("exe: %v", err)
		return 1
	}
	code, err := spawnAndWait(exe, []string{
		"--data-dir", activeDir,
		"--config", filepath.Join(activeDir, "config.json"),
		"--slot", p.fromSlot,
	})
	if err != nil {
		logf("rebirth: %v", err)
	}
	return code
}

// updateStartServeLoop connects to the relay (retry forever) with
// ?updating=1: the relay registers the socket but broadcasts host_status
// updating (not online) — that broadcast is the ONLY updating signal.
// connectWebSocket blocks until the socket drops, then the loop redials;
// the relay re-emits updating on every (re)connect, and replays it to
// frontends that connect mid-update.
func updateSlotCommitted(p updateStartParams) bool {
	raw, err := os.ReadFile(filepath.Join(p.root, "slots", "active"))
	return err == nil && (p.toSlot == "a" || p.toSlot == "b") && strings.TrimSpace(string(raw)) == p.toSlot
}

// startUpdateRelay returns an idempotent stop that cancels an in-flight
// dial/read/backoff and waits until no updater can register again.
func (d *DaemonServer) startUpdateRelay(logf func(string, ...any)) func() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.updateStartServeLoop(ctx, logf)
	}()
	return func() {
		cancel()
		<-done
	}
}

func (d *DaemonServer) updateStartServeLoop(ctx context.Context, logf func(string, ...any)) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := d.connectWebSocketContext(ctx, "&updating=1"); err != nil {
			if ctx.Err() != nil {
				return
			}
			if errors.Is(err, errDaemonRevoked) {
				logf("relay revoked, continuing headless")
				return
			}
			logf("relay: %v (retry in %v)", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
			continue
		}
		backoff = time.Second
	}
}

// closeWS drops the relay socket (best-effort).
func (d *DaemonServer) closeWS() {
	d.wsMu.Lock()
	defer d.wsMu.Unlock()
	if d.wsConn != nil {
		_ = d.wsConn.Close()
		d.wsConn = nil
	}
}

// updateEndParams carries the --update-end CLI flags.
type updateEndParams struct {
	root, fromSlot, expectVersion string
	parentPid                     int
	slot                          string // own slot letter (informational)
}

var updateEndInfo *updateEndParams

// doUpdateEndPromote commits slots/active before retiring the waiting
// updater or removing recovery data. The relay hello is best-effort:
// normal reconnection retries later if the gateway is unavailable.
func doUpdateEndPromote(d *DaemonServer) error {
	if updateEndInfo == nil {
		return nil
	}
	p := updateEndInfo
	updateEndInfo = nil // once only
	logf := func(format string, args ...any) {
		fmt.Printf("[UPDATE-END] "+format+"\n", args...)
	}
	// Commit the active marker before announcing success or removing any
	// recovery process/data. On failure the waiter can still roll back.
	ownSlot := p.slot
	if ownSlot == "" {
		ownSlot = strings.TrimPrefix(filepath.Base(d.dataDir), "slot-")
	}
	if err := commitUpdateSlot(d, *p, ownSlot); err != nil {
		return err
	}
	// Best-effort hello after the local commit; no network rollback.
	if err := d.connectWebSocketOnce(); err != nil {
		logf("relay hello: %v (slot already committed)", err)
	} else {
		logf("relay hello ok")
	}
	doneFile := updateDonePath(p.root)
	// Signal FIRST (the waiter polls the file): even if the kill below
	// races, the old side already knows we serve.
	writeUpdateSignal(doneFile, p.expectVersion)
	if p.parentPid > 0 {
		if err := killPidBrutal(p.parentPid); err != nil {
			logf("old updater kill: %v (continuing)", err)
		} else {
			logf("old updater (pid %d) stopped", p.parentPid)
		}
	}
	if oldDir, err := inactiveSlotPath(p.root, ownSlot, p.fromSlot, d.dataDir); err == nil {
		// Sweep the old slot first: kill EVERYTHING still running from
		// it (a resurrected old daemon, stray children) so the RemoveAll
		// below never hits "text file busy" and no zombie serves the
		// deleted slot afterwards. Never kills us (own pid excluded;
		// plus the guard below refuses our own dir).
		killSlotProcesses(oldDir, os.Getpid(), logf)
		if err := removeInactiveSlot(p.root, ownSlot, p.fromSlot, d.dataDir); err != nil {
			logf("old slot cleanup: %v", err)
		}
	} else {
		logf("old slot cleanup refused: %v", err)
	}
	logf("promoted to slot %s", ownSlot)
	_ = os.Remove(updateFailPath(p.root))
	// Best-effort: if the hello above connected, this rides that socket;
	// otherwise it is a no-op and the next reconnect delivers state.
	_ = d.sendWS(map[string]any{
		"type": "update_done", "hostId": d.config.HostID, "version": daemonVersion,
	})
	st := d.updateChecker()
	st.mu.Lock()
	st.available = ""
	st.mu.Unlock()
	d.broadcastUpdateState()
	return nil
}

func commitUpdateSlot(d *DaemonServer, p updateEndParams, ownSlot string) error {
	if (ownSlot != "a" && ownSlot != "b") || (p.fromSlot != "a" && p.fromSlot != "b") || ownSlot == p.fromSlot {
		return fmt.Errorf("invalid promotion %q -> %q", p.fromSlot, ownSlot)
	}
	ownDir, err := filepath.Abs(d.dataDir)
	if err != nil {
		return err
	}
	expected, err := filepath.Abs(filepath.Join(p.root, "slots", "slot-"+ownSlot))
	if err != nil || expected != ownDir {
		return fmt.Errorf("promotion slot does not match data directory")
	}
	activePath := filepath.Join(p.root, "slots", "active")
	raw, err := os.ReadFile(activePath)
	if err != nil {
		return fmt.Errorf("read active slot: %w", err)
	}
	if strings.TrimSpace(string(raw)) != p.fromSlot {
		return fmt.Errorf("active slot changed before promotion")
	}
	if err := writeConfigFile(activePath, []byte(ownSlot+"\n")); err != nil {
		return fmt.Errorf("commit active slot: %w", err)
	}
	return nil
}
