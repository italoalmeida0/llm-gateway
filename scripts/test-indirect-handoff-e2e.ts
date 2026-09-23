// Brutal update E2E with a fake gateway WS (no model, no real gateway):
// supervised old daemon connects -> runHandoff (clean slot, fetch launcher, spawn
// --update-start, keep serving) -> updater SIGKILLs old -> updater copies
// slot + runs launcher --update -> launcher spawns --update-end detached
// -> new daemon commits active, connects, kills the waiter, deletes the old
// slot. Asserts: updater reconnect (?updating=1), local-first promote, slot flip,
// new daemon serving the same session, old slot cleaned, update_done.
//
// Run: bun scripts/test-indirect-handoff-e2e.ts [--rollback]. Builds its fixtures.
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DAEMON_BIN, LAUNCHER_BIN, PLAT, IS_WIN, buildBin, killAll, killProc } from "./indirect-e2e-win";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAEMON_DIR = join(ROOT, "indirect-code-daemon");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rollback = process.argv.includes("--rollback");
  const work = join(tmpdir(), `handoff-e2e-${Date.now()}`);
  const root = join(work, "root");
  const mirror = join(work, "mirror");
  mkdirSync(join(root, "slots", "slot-a", "bin"), { recursive: true });
  mkdirSync(join(root, "slots", "slot-a", "sessions"), { recursive: true });
  mkdirSync(mirror, { recursive: true });

  // Versioned builds: old=9.9.8, new=9.9.9 (numeric: the brutal path requires strictly-newer).
  const build = (pkg: string, ver: string, out: string, vvar: string) =>
    buildBin(pkg, ver, out, vvar, DAEMON_DIR);
  const oldBin = build("./cmd/daemon", "9.9.8", join(work, "daemon-old"), "daemonVersion");
  const newBin = build("./cmd/daemon", "9.9.9", join(work, "daemon-new"), "daemonVersion");
  const launcherOldBin = build("./cmd/launcher", "9.9.8", join(work, "launcher-old"), "launcherVersion");
  const launcherBin = build("./cmd/launcher", "9.9.9", join(work, "launcher-new"), "launcherVersion");
  const daemonAsset = `indirect-code-${PLAT}${IS_WIN ? ".exe" : ""}`;
  const launcherAsset = `indirect-launcher-${PLAT}${IS_WIN ? ".exe" : ""}`;

  // Mirror serves new binaries + manifest 9.9.9.
  const { copyFileSync, writeFileSync: wfs, readFileSync, mkdirSync: mkMirror } = await import("node:fs");
  mkMirror(mirror, { recursive: true });
  copyFileSync(newBin, join(mirror, daemonAsset));
  copyFileSync(launcherBin, join(mirror, launcherAsset));
  const manifest = {
    daemon: { version: "9.9.9", assets: { [PLAT]: daemonAsset }, sums: {} },
    launcher: { version: "9.9.9", assets: { [PLAT]: launcherAsset }, sums: {} },
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

  // Custom root, no ambient mirror: updates must use the paired gateway.
  const env = { ...process.env, INDIRECT_GATEWAY: "", INDIRECT_REPO_RAW: "" };

  // Fake gateway WS: accepts daemon sockets, keeps them open, and can
  // SEND commands (the daemon handleMessages anything on the socket).
  // Tracks connects/disconnects + forwards daemon_update_apply on demand.
  const connects: number[] = [];
  const updatingConnects: number[] = [];
  let disconnects = 0;
  let daemonSock: any = null;
  let sawDone: any = null;
  let sawFailed: any = null;
  let sawSession: any = null;
  const gw = Bun.serve<{ updating: boolean }>({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req, server) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/indirect-code/daemon/ws") {
        if (server.upgrade(req, { data: { updating: u.searchParams.get("updating") === "1" } })) return undefined;
        return new Response("up", { status: 426 });
      }
      if (u.pathname === "/api/indirect-code/versions") return Response.json(manifest);
      // Serve the update mirror under /r/ (same server): the daemon
      // fetchLauncherTo + the launcher --update child both resolve the mirror
      // gateway-first from the slot config gateway_url, which points
      // here. Without this the download 404s against the WS stub.
      if (u.pathname.startsWith("/r/")) {
        const p = join(mirror, u.pathname.slice(3));
        if (!existsSync(p)) return new Response("nf", { status: 404 });
        // Exceed the supervisor's 5s restart delay during the update.
        if (u.pathname.endsWith(daemonAsset)) {
          await sleep(7000);
          if (rollback) return new Response("update download unavailable", { status: 503 });
        }
        return new Response(Bun.file(p));
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        connects.push(Date.now());
        if (ws.data.updating) updatingConnects.push(Date.now());
        daemonSock = ws;
      },
      message: (_ws, data) => {
        try {
          const m = JSON.parse(String(data));
          if (m.type === "update_done") sawDone = m;
          if (m.type === "update_failed") sawFailed = m;
          if (m.type === "session_data" && m.session?.id === "s1") sawSession = m;
        } catch {}
      },
      close: (ws) => { disconnects++; if (daemonSock === ws) daemonSock = null; },
    },
  });
  const gwURL = `http://127.0.0.1:${gw.port}`;
  // Point config at the fake gateway WS (the daemon MUST connect here
  // to be observed). The update MIRROR is resolved separately: the daemon
  // fetchLauncherTo tries the config gateway first, so the fake gateway
  // ALSO serves the mirror files under /r/ (same trick the gateway-death
  // script uses: fake gateway + /r/ in one server).
  const cfg = JSON.parse(readFileSync(join(root, "slots", "slot-a", "config.json"), "utf8"));
  cfg.gateway_url = gwURL;
  wfs(join(root, "slots", "slot-a", "config.json"), JSON.stringify(cfg));

  // Exercise the real supervisor. The explicit binary prevents normal
  // boot from fetching the new release before we request the handoff.
  const proc = spawn(launcherOldBin, ["--daemon", join(root, "slots", "slot-a", "bin", DAEMON_BIN), "--data-dir", join(root, "slots", "slot-a"), "--", "--slot", "a"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (out += d.toString()));
  const waitConnect = async (n: number, ms: number) => {
    const t0 = Date.now();
    while (connects.length < n && Date.now() - t0 < ms) await sleep(200);
    assert(connects.length >= n, `expected ${n} connects, got ${connects.length}`);
  };
  try {
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
    await sleep(6000);
    assert.equal(proc.exitCode, 0, `supervisor did not hand over cleanly: ${out}`);
    assert.equal(connects.length, 2, "old daemon restarted while the updater was downloading");
    if (rollback) {
      const start = Date.now();
      while ((!sawFailed || !daemonSock || daemonSock.data.updating) && Date.now() - start < 30000) await sleep(100);
      assert(sawFailed, `update failure was never reported: ${out}`);
      assert(!sawDone, "failed update reported success");
      assert(daemonSock && !daemonSock.data.updating, "rollback never restored a normal daemon");
      await sleep(2000); // The old updater must not reconnect and reclaim it.
      assert(!daemonSock.data.updating, "updater reclaimed the restored host");
      daemonSock.send(JSON.stringify({ type: "get_session", sessionId: "s1" }));
      const sessionStart = Date.now();
      while (!sawSession && Date.now() - sessionStart < 5000) await sleep(100);
      assert(sawSession, `restored daemon is not serving its sessions: ${out}`);
      assert.equal(readFileSync(join(root, "slots", "active"), "utf8").trim(), "a", "failed update flipped active");
      assert(existsSync(join(root, "slots", "slot-a", "sessions", "s1.jsonl")), "rollback lost the session");
      console.log("PASS: download failure restored the old daemon and session without updater reconnects");
      return;
    }
    console.log("updater owns host; waiting for brutal promote (old SIGKILLed, new connects)...");
    // Brutal order: the old daemon is SIGKILLed by --update-start (disconnect
    // lands), THEN the new daemon (--update-end) commits active, connects,
    // kills the waiter and reports update_done.
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
  } finally {
    // Scoped kill (work dir only — never broad pkill: a wide pattern once
    // killed the real VPS daemon).
    killAll(work);
    killProc(proc);
    await sleep(500);
    gw.stop(true);
    rmSync(work, { recursive: true, force: true });
  }
  console.log("PASS: brutal update 9.9.8 -> 9.9.9 (updating, SIGKILL, promote, cleanup)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
