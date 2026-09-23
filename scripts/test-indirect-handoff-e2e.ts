// Brutal update E2E with a fake gateway WS (no model, no real gateway):
// old daemon connects -> runHandoff (clean slot, fetch launcher, spawn
// --update-start, keep serving) -> updater SIGKILLs old -> updater copies
// slot + runs launcher --update -> launcher spawns --update-end detached
// -> new daemon connects, kills the waiter, flips active, deletes the old
// slot. Asserts: updater reconnect (?updating=1), local-first promote, slot flip,
// new daemon serving the same session, old slot cleaned, update_done.
//
// Run: bun scripts/test-indirect-handoff-e2e.ts (needs built binaries).
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DAEMON_BIN, LAUNCHER_BIN, PLAT, buildBin, killAll, killProc } from "./indirect-e2e-win";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAEMON_DIR = join(ROOT, "indirect-code-daemon");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const work = join(tmpdir(), `handoff-e2e-${Date.now()}`);
  const root = join(work, "root");
  const mirror = join(work, "mirror");
  mkdirSync(join(root, "slots", "slot-a", "bin"), { recursive: true });
  mkdirSync(join(root, "slots", "slot-a", "sessions"), { recursive: true });
  mkdirSync(mirror, { recursive: true });

  // Versioned builds: old=9.9.8, new=9.9.9 (numeric: the brutal path requires strictly-newer).
  const build = (pkg: string, ver: string, out: string, vvar: string) =>
    buildBin(pkg, ver, out, vvar, DAEMON_DIR);
  const oldBin = join(work, "daemon-old");
  const newBin = join(work, "daemon-new");
  const launcherBin = join(work, "launcher-new");
  const launcherOldBin = join(work, "launcher-old");
  build("./cmd/daemon", "9.9.8", oldBin, "daemonVersion");
  build("./cmd/daemon", "9.9.9", newBin, "daemonVersion");
  build("./cmd/launcher", "9.9.8", launcherOldBin, "launcherVersion");
  build("./cmd/launcher", "9.9.9", launcherBin, "launcherVersion");

  // Mirror serves new binaries + manifest 9.9.9.
  const { copyFileSync, writeFileSync: wfs, readFileSync, mkdirSync: mkMirror } = await import("node:fs");
  mkMirror(mirror, { recursive: true });
  copyFileSync(newBin, join(mirror, DAEMON_BIN));
  copyFileSync(launcherBin, join(mirror, LAUNCHER_BIN));
  const manifest = {
    daemon: { version: "9.9.9", assets: { [PLAT]: DAEMON_BIN }, sums: {} },
    launcher: { version: "9.9.9", assets: { [PLAT]: LAUNCHER_BIN }, sums: {} },
  };
  wfs(join(mirror, "versions.json"), JSON.stringify(manifest));

  // Seed slot-a: old binaries + session + version + config.
  // Canonical layout: the daemon runs with dataDir = the SLOT dir
  // (<root>/slots/slot-x), so slots/active lives two levels up.
  copyFileSync(oldBin, join(root, "slots", "slot-a", "bin", DAEMON_BIN));
  copyFileSync(launcherOldBin, join(root, "slots", "slot-a", "bin", LAUNCHER_BIN));
  wfs(join(root, "slots", "active"), "a\n");
  wfs(join(root, "slots", "slot-a", "daemon.pid"), "1\n"); // stale pid: proves the updater takes over the pidfile
  wfs(join(root, "slots", "slot-a", "storage_version.json"), JSON.stringify({ version: 1 }));
  wfs(join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
    `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"user","turnIndex":1,"content":[{"type":"text","text":"hi"}]}]}\n` +
    `{"v":1,"kind":"meta","id":"s1","cwd":"/tmp","title":"T","model":"m","status":"idle","createdAt":1,"updatedAt":2,"turnSeq":1}\n`);
  wfs(join(root, "slots", "slot-a", "config.json"), JSON.stringify({
    gateway_url: "ws://127.0.0.1:1", daemon_token: "x", api_key: "y",
    host_id: "handoff-e2e", name: "e2e", settings: {},
  }));

  // Fake mirror server (serves files from mirror dir; strips the /r/
  // prefix the launcher adds when resolving via INDIRECT_GATEWAY).
  const mirrorSrv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => {
      let name = new URL(req.url).pathname.slice(1);
      if (name.startsWith("r/")) name = name.slice(2);
      const p = join(mirror, name);
      if (!existsSync(p)) return new Response("nf", { status: 404 });
      return new Response(Bun.file(p));
    },
  });
  const mirrorURL = `http://127.0.0.1:${mirrorSrv.port}`;
  // Gateway-first mirror resolution (daemon fetchLauncherTo + launcher
  // fetchDaemonTo both try the GATEWAY before INDIRECT_REPO_RAW). The
  // daemon's slot config gateway_url is rewritten to the fake gateway
  // below; ALSO export INDIRECT_GATEWAY in the child env so the
  // launcher --update child (spawned by --update-start, env inherited) resolves the
  // same fake mirror instead of a stale ambient gateway from the shell.
  const env = { ...process.env, INDIRECT_GATEWAY: mirrorURL, INDIRECT_REPO_RAW: mirrorURL };

  // Fake gateway WS: accepts daemon sockets, keeps them open, and can
  // SEND commands (the daemon handleMessages anything on the socket).
  // Tracks connects/disconnects + forwards daemon_update_apply on demand.
  const connects: number[] = [];
  const updatingConnects: number[] = [];
  let disconnects = 0;
  let daemonSock: any = null;
  let sawDone: any = null;
  let pendingUpdating = false;
  const gw = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, server) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/indirect-code/daemon/ws") {
        // Bun drops custom props on upgrade: stash the flag for the
        // next open (connections here are sequential, one at a time).
        pendingUpdating = u.searchParams.get("updating") === "1";
        if (server.upgrade(req)) return undefined as any;
        return new Response("up", { status: 426 });
      }
      // Serve the update mirror under /r/ (same server): the daemon
      // fetchLauncherTo + the launcher --update child both resolve the mirror
      // gateway-first from the slot config gateway_url, which points
      // here. Without this the download 404s against the WS stub.
      if (u.pathname.startsWith("/r/")) {
        const p = join(mirror, u.pathname.slice(3));
        if (!existsSync(p)) return new Response("nf", { status: 404 });
        return new Response(Bun.file(p));
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        connects.push(Date.now());
        if (pendingUpdating) updatingConnects.push(Date.now());
        pendingUpdating = false;
        if (disconnects === 0) daemonSock = ws;
      },
      message: (_ws, data) => {
        try {
          const m = JSON.parse(String(data));
          if (m.type === "update_done") sawDone = m;
        } catch {}
      },
      close: () => { disconnects++; daemonSock = null; },
    },
  });
  const gwURL = `ws://127.0.0.1:${gw.port}`;
  // Point config at the fake gateway WS (the daemon MUST connect here
  // to be observed). The update MIRROR is resolved separately: the daemon
  // fetchLauncherTo tries the config gateway first, so the fake gateway
  // ALSO serves the mirror files under /r/ (same trick the gateway-death
  // script uses: fake gateway + /r/ in one server).
  const cfg = JSON.parse(readFileSync(join(root, "slots", "slot-a", "config.json"), "utf8"));
  cfg.gateway_url = gwURL;
  wfs(join(root, "slots", "slot-a", "config.json"), JSON.stringify(cfg));

  // Start OLD daemon directly (canonical: dataDir = the slot dir).
  const proc = spawn(oldBin, ["--data-dir", join(root, "slots", "slot-a"), "--config", join(root, "slots", "slot-a", "config.json"), "--slot", "a"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (out += d.toString()));
  const waitConnect = async (n: number, ms: number) => {
    const t0 = Date.now();
    while (connects.length < n && Date.now() - t0 < ms) await sleep(200);
    assert(connects.length >= n, `expected ${n} connects, got ${connects.length}`);
  };
  await waitConnect(1, 20000);
  console.log("old daemon connected");

  // Wait for boot check to see 9.9.9, then trigger handoff like Update now.
  await sleep(3000);
  assert(daemonSock, "daemon socket open");
  daemonSock.send(JSON.stringify({ type: "daemon_update_apply" }));
  console.log("apply sent; waiting for updater (?updating=1 reconnect)...");
  const t0 = Date.now();
  while (updatingConnects.length < 1 && Date.now() - t0 < 60000) await sleep(500);
  assert(updatingConnects.length >= 1, "updater reconnected with ?updating=1 (owns host)");
  console.log("updater owns host; waiting for brutal promote (old SIGKILLed, new connects)...");
  // Brutal order: the old daemon is SIGKILLed by --update-start (disconnect
  // lands), THEN the new daemon (--update-end) connects, kills the waiter,
  // flips active and reports update_done.
  const tProm = Date.now();
  while ((disconnects < 1 || connects.length < 2 || !sawDone) && Date.now() - tProm < 120000) await sleep(500);
  assert(disconnects >= 1, "old daemon disconnected (SIGKILLed by updater)");
  assert(connects.length >= 2, `new daemon connected (connects=${connects.length})`);
  assert(sawDone && sawDone.version === "9.9.9", `expected update_done 9.9.9, got ${JSON.stringify(sawDone)}`);
  console.log("new daemon connected + update_done; settling...");
  await sleep(5000);
  const active = readFileSync(join(root, "slots", "active"), "utf8").trim();
  assert.equal(active, "b", `active slot = ${active}`);
  assert(existsSync(join(root, "slots", "slot-b", "sessions", "s1.jsonl")), "session in new slot");
  assert(!existsSync(join(root, "slots", "slot-a")), "old slot cleaned");
  assert(!existsSync(join(root, "slots", "update.fail")), "no fail signal");
  console.log(`brutal update OK: connects=${connects.length} disconnects=${disconnects}`);
  // Scoped kill (work dir only — never broad pkill: a wide pattern once
  // killed the real VPS daemon).
  killAll(work);
  killProc(proc);
  await sleep(500);
  mirrorSrv.stop();
  gw.stop();
  rmSync(work, { recursive: true, force: true });
  console.log("PASS: brutal update 9.9.8 -> 9.9.9 (updating, SIGKILL, promote, cleanup)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
