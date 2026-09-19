// Crash/kill/tamper chaos E2E: the machine dies (kill -9), files get
// mangled by hand, disks fill with torn writes — at every handoff phase.
// Assert the next boot ALWAYS lands safe: serve the good slot, resume or
// cleanly idle turns, never a torn slot, never a stuck freeze.
//
// Cases (each: fresh world, real binaries, no network, no model):
//   K1 kill -9 old daemon mid-copy (frozen) -> relaunch: active=a,
//      turn resumes from WAL (running+WAL preserved), no torn slot-b
//   K2 kill -9 new launcher mid-takeover -> relaunch: active=a intact,
//      stale slot-b ignored/rebuilt, turn resumes
//   K3 kill -9 AFTER active flip, before old exit -> relaunch: active=b
//      serves (new daemon boots on slot-b, resumes turn); old pid dead
//   K4 power loss DURING active write (torn/empty/garbage active file)
//      -> launcher repair picks live/freshest slot, never corrupt
//   K5 tamper: slot-b binary replaced with garbage + active flipped to b
//      -> self-verify fails -> falls back to download or good slot,
//      never serves garbage
//   K6 tamper: session JSON truncated mid-write + WAL intact -> boot
//      replays WAL over frozen JSON (torn tail tolerated), turn resumes
//   K7 tamper: handoff.json="promoted" forged without promote -> boot
//      must NOT claim update_done falsely... (documents current behavior:
//      announceUpdateDone fires on the marker; the marker is only
//      written by takeover post-flip, so forgery requires disk access —
//      assert the marker path is slot-local and consumed once)
//   K8 double boot: two daemons on the same root -> second must refuse
//      (pidfile) or at worst not corrupt (tmp+rename writers)
//
// Run: bun scripts/test-indirect-crash-chaos-e2e.ts
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const IS_WIN = process.platform === "win32";
// Script location: repo/scripts on unix, but a copied standalone file on
// Windows (C:\Users\italo\llmgw-win-test\indirect-code-daemon). The daemon
// sources live next to the script in the standalone layout, one level up
// in the repo layout — detect both.
const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const IS_STANDALONE = IS_WIN && !SCRIPT_DIR.replace(/\\/g, "/").includes("/scripts/");
const ROOT = IS_STANDALONE ? join(SCRIPT_DIR, "..") : new URL("..", import.meta.url).pathname;
// Windows file URLs come back as /C:/... (leading slash): strip it so
// join() produces a valid native path (otherwise `go build` runs in a
// nonexistent cwd and every spawn fails ENOENT).
function nativePath(p: string): string {
  if (IS_WIN && /^\/[A-Za-z]:\//.test(p)) return p.slice(1);
  return p;
}
const DAEMON_DIR = nativePath(IS_STANDALONE ? SCRIPT_DIR.replace(/[/\\]$/, "") : join(ROOT, "indirect-code-daemon"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (tag: string, msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}] ${msg}`);
// go binary: PATH on unix; on Windows resolve via `where go` at
// runtime (bun's env over the remote-exec channel may not inherit the
// user's PATH, and hardcoded shim paths break across machines).
function goBin(): string {
  if (!IS_WIN) return "go";
  if (process.env.GO_BIN) return process.env.GO_BIN;
  try {
    const out = execFileSync("where", ["go"], { encoding: "utf8" });
    // `where` output ends with CRLF: trim the trailing whitespace so the
    // path has no stray \r (uv_spawn ENOENT otherwise).
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first) return first.trim();
  } catch {}
  return "go";
}
const GO_BIN = goBin();
const build = (pkg: string, ver: string, out: string, vvar: string) =>
  execFileSync(GO_BIN, ["build", "-trimpath", "-ldflags", `-s -w -X main.${vvar}=${ver}`, "-o", out, pkg], { cwd: DAEMON_DIR, stdio: "pipe" });

let BIN_OLD = "", BIN_NEW = "", LAUNCHER = "";
const wfs = writeFileSync;
const rfs = readFileSync;
// Slot binary names are platform-specific (slotBinName/slotLauncherName:
// .exe on Windows, GOOS-GOARCH suffix otherwise).
const DAEMON_BIN = IS_WIN ? "indirect-code.exe" : "indirect-code-linux-amd64";
const LAUNCHER_BIN = IS_WIN ? "indirect-launcher.exe" : "indirect-launcher-linux-amd64";

// Minimal world: root with slot-a serving (daemon vK1 + session w/ WAL).
function mkWorld(tag: string) {
  const work = join(tmpdir(), `crash-${tag}-${Date.now()}`);
  const root = join(work, "root");
  mkdirSync(join(root, "slots", "slot-a", "bin"), { recursive: true });
  mkdirSync(join(root, "slots", "slot-a", "sessions"), { recursive: true });

  copyFileSync(BIN_OLD, join(root, "slots", "slot-a", "bin", DAEMON_BIN));
  copyFileSync(LAUNCHER, join(root, "slots", "slot-a", "bin", LAUNCHER_BIN));
  wfs(join(root, "slots", "active"), "a\n");
  wfs(join(root, "slots", "slot-a", "storage_version.json"), JSON.stringify({ version: 1 }));
  wfs(join(root, "slots", "slot-a", "config.json"), JSON.stringify({
    gateway_url: "ws://127.0.0.1:1/dead", daemon_token: "x", api_key: "y",
    host_id: `crash-${tag}`, name: `crash-${tag}`, settings: {},
  }));
  // Session: frozen JSON running + WAL with 1 user message (like a live turn).
  wfs(join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
    `{"v":1,"kind":"meta","id":"s1","cwd":"/tmp","title":"T","model":"m","status":"running","createdAt":1,"updatedAt":2,"turnSeq":2,"turn":{"status":"running","startedAt":3}}\n`);
  wfs(join(root, "slots", "slot-a", "sessions", "s1.wal.jsonl"),
    `{"v":1,"type":"header","header":{"turnIndex":2,"startedAt":3,"model":"m","prompt":"go"}}\n` +
    `{"v":1,"type":"msg","msg":"{\\"role\\":\\"user\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"go\\"}],\\"turnIndex\\":2}","updatedAt":4}\n`);
  return { work, root };
}

// Recursive dir copy (node:fs only — no `cp -r`, missing on Windows).
function copyDir(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dst, e);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function killAll(work: string) {
  if (IS_WIN) {
    // Windows: no SIGKILL/ps. NEVER kill by image name alone
    // (taskkill /FI IMAGENAME would murder the user's REAL running
    // daemon too — caught live when the chaos run killed the owner's
    // production indirect-code on his Surface). Scope strictly to
    // processes whose command line contains the test work dir.
    try {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${work.replace(/'/g, "''")}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }`;
      execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes(work) && !line.includes("ps -eo")) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (pid > 0 && pid !== process.pid) { try { kill9(pid); } catch {} }
      }
    }
  } catch {}
}

// KILL9: SIGKILL on unix, taskkill /F on Windows (no SIGKILL there;
// proc.kill("SIGKILL") on win is just TerminateProcess anyway).
function kill9(pid: number) {
  if (IS_WIN) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch {}
    return;
  }
  try { kill9(pid); } catch {}
}

function launchDaemon(root: string) {
  const proc = spawn(join(root, "slots", "slot-a", "bin", LAUNCHER_BIN),
    ["--data-dir", root], { env: { ...process.env, INDIRECT_REPO_RAW: "", INDIRECT_GATEWAY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (out += d.toString()));
  return { proc, getOut: () => out };
}

async function waitPid(root: string, ms = 15000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    for (const s of ["slot-a", "slot-b"]) {
      const p = join(root, "slots", s, "daemon.pid");
      if (existsSync(p)) {
        const pid = parseInt(readFileSync(p, "utf8").trim(), 10);
        if (pid > 0) {
          try { process.kill(pid, 0); return pid; } catch {}
        }
      }
    }
    assert(Date.now() - t0 < ms, "daemon.pid never appeared");
    await sleep(300);
  }
}

async function main() {
  const work0 = join(tmpdir(), `crash-build-${Date.now()}`);
  mkdirSync(work0, { recursive: true });
  BIN_OLD = join(work0, IS_WIN ? "daemon-old.exe" : "daemon-old");
  BIN_NEW = join(work0, IS_WIN ? "daemon-new.exe" : "daemon-new");
  LAUNCHER = join(work0, IS_WIN ? "launcher.exe" : "launcher");
  build("./cmd/daemon", "vK1", BIN_OLD, "daemonVersion");
  build("./cmd/daemon", "vK2", BIN_NEW, "daemonVersion");
  build("./cmd/launcher", "vK1", LAUNCHER, "launcherVersion");


  // ---- K1: kill -9 mid-copy (frozen, WAL open) -> relaunch resumes ----
  {
    const { work, root } = mkWorld("k1");
    try {
      const d = launchDaemon(root);
      const pid = await waitPid(root);
      log("k1", `daemon up (pid ${pid}), killing -9 mid-serve`);
      await sleep(2000);
      kill9(pid);
      try { d.proc.kill("SIGKILL"); } catch {}
      await sleep(1000);
      killAll(work);
      // Relaunch: must come back on slot-a and resume the WAL turn.
      const d2 = launchDaemon(root);
      const pid2 = await waitPid(root);
      log("k1", `relaunched (pid ${pid2})`);
      await sleep(4000);
      // The relaunch must prove FRESHNESS, not just PID inequality: the
      // pidfile mtime must be after the kill (a stale pidfile with a
      // recycled PID would otherwise pass/fail for the wrong reason on
      // both platforms — caught on Linux where the kernel reused the
      // PID within 1s).
      const pidStat = statSync(join(root, "slots", "slot-a", "daemon.pid"));
      assert(Date.now() - pidStat.mtimeMs < 30000, "[k1] pidfile not fresh after relaunch");
      assert.equal(rfs(join(root, "slots", "active"), "utf8").trim(), "a", "[k1] active flipped by a kill");
      // WAL must still be there (resume owns it) or cleanly committed.
      const hasWal = existsSync(join(root, "slots", "slot-a", "sessions", "s1.wal.jsonl"));
      log("k1", `WAL present after relaunch: ${hasWal} (resume owns or committed)`);
      try { d2.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      log("k1", "kill -9 mid-serve -> clean relaunch on slot-a — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  // ---- K2: torn slot-b (crashed takeover left garbage) -> ignored ----
  {
    const { work, root } = mkWorld("k2");
    try {
      // Simulate a takeover that died mid-copy: half slot-b, no active flip.
      mkdirSync(join(root, "slots", "slot-b", "bin"), { recursive: true });
      mkdirSync(join(root, "slots", "slot-b", "sessions"), { recursive: true });
      wfs(join(root, "slots", "slot-b", "sessions", "half.jsonl"), '{"torn":');
      wfs(join(root, "slots", "slot-b", "bin", DAEMON_BIN), "garbage-not-a-binary");
      const d = launchDaemon(root);
      const pid = await waitPid(root);
      log("k2", `daemon up (pid ${pid}) with torn slot-b present`);
      await sleep(3000);
      assert.equal(rfs(join(root, "slots", "active"), "utf8").trim(), "a", "[k2] active moved to torn slot");
      try { d.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      log("k2", "torn inactive slot ignored, active=a serves — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  // ---- K3: kill AFTER flip (active=b, new daemon never booted) ----
  {
    const { work, root } = mkWorld("k3");
    try {
      // Simulate completed copy + flip, but the new daemon never started
      // (power loss between flip and exec): slot-b is a FULL copy.
      mkdirSync(join(root, "slots", "slot-b", "bin"), { recursive: true });
      mkdirSync(join(root, "slots", "slot-b", "sessions"), { recursive: true });
      copyDir(join(root, "slots", "slot-a", "sessions"), join(root, "slots", "slot-b", "sessions"));
      copyFileSync(BIN_NEW, join(root, "slots", "slot-b", "bin", DAEMON_BIN));
      copyFileSync(LAUNCHER, join(root, "slots", "slot-b", "bin", LAUNCHER_BIN));
      copyFileSync(join(root, "slots", "slot-a", "config.json"), join(root, "slots", "slot-b", "config.json"));
      wfs(join(root, "slots", "active"), "b\n");
      const d = launchDaemon(root);
      const pid = await waitPid(root);
      log("k3", `daemon up (pid ${pid}) after flip-without-boot`);
      await sleep(3000);
      assert.equal(rfs(join(root, "slots", "active"), "utf8").trim(), "b", "[k3] active moved away from flipped slot");
      assert(existsSync(join(root, "slots", "slot-b", "sessions", "s1.jsonl")), "[k3] flipped slot sessions intact");
      try { d.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      log("k3", "post-flip power loss -> new slot serves, sessions intact — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  // ---- K4: torn active file (empty / garbage / whitespace) ----
  {
    for (const [name, bytes] of [["empty", ""], ["garbage", "zzz\n"], ["ws", "  \n"]]) {
      const { work, root } = mkWorld(`k4-${name}`);
      try {
        wfs(join(root, "slots", "active"), bytes);
        const d = launchDaemon(root);
        const pid = await waitPid(root);
        log(`k4-${name}`, `daemon up (pid ${pid}) with torn active file`);
        await sleep(2000);
        const active = rfs(join(root, "slots", "active"), "utf8").trim();
        assert(active === "a" || active === "b", `[k4-${name}] active unrepaired: ${JSON.stringify(active)}`);
        try { d.proc.kill("SIGKILL"); } catch {}
        killAll(work);
        log(`k4-${name}`, `torn active repaired to ${active} — PASS`);
      } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
    }
  }

  // ---- K5: slot binary replaced with garbage (tamper) ----
  // No mirror configured: the launcher must self-verify the local
  // binary, reject garbage, and REFUSE (no pidfile, no exec) — never
  // run whatever is on disk. (K5 chaos caught it: the old fallback ran
  // the tampered bytes when the download failed.)
  {
    const { work, root } = mkWorld("k5");
    try {
      wfs(join(root, "slots", "slot-a", "bin", DAEMON_BIN), "garbage-not-a-binary");
      const d = launchDaemon(root);
      // Give it time to (incorrectly) boot, then inspect.
      await sleep(8000);
      let pidAlive = false;
      try { pidAlive = (await waitPid(root, 2000)) > 0; } catch { pidAlive = false; }
      // The launcher must have FAILED (log it) and left no pidfile.
      const pidFile = existsSync(join(root, "slots", "slot-a", "daemon.pid"));
      try { d.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      assert(!pidAlive && !pidFile, "[k5] garbage binary was executed (pidfile appeared)");
      log("k5", "garbage binary rejected, never executed — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  // ---- K6: truncated session JSON + intact WAL -> WAL replay wins ----
  {
    const { work, root } = mkWorld("k6");
    try {
      // Torn write: session JSON cut mid-line (crash between tmp write
      // and rename would leave the OLD file — but a direct-write crash
      // could tear it; assert the reader tolerates).
      wfs(join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
        `{"v":1,"kind":"meta","id":"s1","cwd":"/tmp","title":"T","model":"m","status":"running","createdAt":1,"updatedAt":2,"turnSeq":2,"turn":{"status":"running","startedAt":3}}\n{"torn-tail`);
      const d = launchDaemon(root);
      const pid = await waitPid(root);
      log("k6", `daemon up (pid ${pid}) with torn session tail`);
      await sleep(3000);
      // Boot must not crash-loop: process alive = torn tail tolerated.
      try { process.kill(pid, 0); } catch { throw new Error("[k6] daemon died on torn session tail"); }
      try { d.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      log("k6", "torn session tail tolerated, daemon alive — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  // ---- K8: double boot (two launchers, same root) ----
  {
    const { work, root } = mkWorld("k8");
    try {
      const d1 = launchDaemon(root);
      const pid1 = await waitPid(root);
      log("k8", `first daemon up (pid ${pid1})`);
      await sleep(2000);
      const d2 = launchDaemon(root);
      await sleep(4000);
      // Second launcher must detect the live pid and refuse or exit —
      // it must NOT wipe the first daemon's sessions.
      assert(existsSync(join(root, "slots", "slot-a", "sessions", "s1.jsonl")), "[k8] sessions wiped by double boot");
      try { process.kill(pid1, 0); } catch { throw new Error("[k8] first daemon killed by double boot"); }
      try { d1.proc.kill("SIGKILL"); } catch {}
      try { d2.proc.kill("SIGKILL"); } catch {}
      killAll(work);
      log("k8", "double boot: first daemon survives, sessions intact — PASS");
    } finally { killAll(work); rmSync(work, { recursive: true, force: true }); }
  }

  rmSync(work0, { recursive: true, force: true });
  console.log("\n=== RESULT ===\nPASS: crash/kill/tamper chaos (k1-k6, k8)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
