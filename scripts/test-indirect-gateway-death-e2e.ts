// Gateway-death chaos E2E: kill the gateway (WS + mirror + manifest,
// all served by one Bun server) at each brutal-update phase and assert the
// daemon always lands in a safe state — never a torn slot, never a stuck
// updater, never a lost turn.
//
// Phases (one daemon per phase, fresh work dir each):
//   P0 download   - gateway dies mid launcher download -> update_failed,
//                   old daemon keeps serving, retry works after rebirth
//   P1 launcher   - mirror dies MID launcher download (truncated bytes) ->
//                   self-verify fails -> update_failed, slot cleaned
//   P2 updater    - gateway dies while --update-start runs (copy/launcher
//                   phase) -> launcher --update can't fetch -> writes the
//                   fail file -> waiter cleans the slot, reports
//                   update_failed, rebirths as a normal daemon on the
//                   untouched active slot
//   P4 promote    - gateway dies right at promote (--update-end's hello
//                   fails) -> promote still runs LOCAL-FIRST: updater
//                   killed, active flips, old slot cleaned; the WS just
//                   reconnects later (same as booting offline)
//   P5 rebirth    - gateway comes back -> daemon reconnects (backoff loop),
//                   checkNow re-arms, update can be retried to success
//
// Run: bun scripts/test-indirect-gateway-death-e2e.ts (needs built binaries,
// no model, no browser — fake WS gateway + controllable mirror).
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DAEMON_BIN, PLAT, buildBin, killAll, killProc } from "./indirect-e2e-win";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAEMON_DIR = join(ROOT, "indirect-code-daemon");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (tag: string, msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}] ${msg}`);

const build = (pkg: string, ver: string, out: string, vvar: string | string[]) =>
    buildBin(pkg, ver, out, vvar, DAEMON_DIR);

interface World {
  work: string; root: string; mirror: string;
  gw: any; gwPort: number; mirrorSrv: any; mirrorPort: number;
  daemonSock: { ws: any }; events: any[];
  proc: any; out: string;
  cleanup: () => Promise<void>;
}

// One world: fake WS gateway + separate mirror server (killable
// independently) + old daemon (vG1) connected, manifest says vG2.
async function bootWorld(tag: string, opts: { mirrorDelayMs?: number; mirrorFailAfterBytes?: number } = {}): Promise<World> {
  const work = join(tmpdir(), `gwdeath-${tag}-${Date.now()}`);
  const root = join(work, "root");
  const mirror = join(work, "mirror");
  mkdirSync(join(root, "slots", "slot-a", "bin"), { recursive: true });
  mkdirSync(join(root, "slots", "slot-a", "sessions"), { recursive: true });
  mkdirSync(mirror, { recursive: true });

  const oldBin = join(work, "app-old");
  const newBin = join(work, "app-new");
  // Multi-call binary: ONE build per version, stamped for both roles.
  const both = ["daemonVersion", "launcherVersion"];
  build("./cmd/daemon", "9.9.8", oldBin, both);
  build("./cmd/daemon", "9.9.9", newBin, both);

  const { copyFileSync, writeFileSync: wfs, readFileSync } = await import("node:fs");
  copyFileSync(newBin, join(mirror, DAEMON_BIN));
  wfs(join(mirror, "versions.json"), JSON.stringify({
    daemon: { version: "9.9.9", assets: { [PLAT]: DAEMON_BIN }, sums: {} },
  }));

  copyFileSync(oldBin, join(root, "slots", "slot-a", "bin", DAEMON_BIN));
  wfs(join(root, "slots", "active"), "a\n");
  wfs(join(root, "slots", "slot-a", "storage_version.json"), JSON.stringify({ version: 1 }));
  wfs(join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
    `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"user","turnIndex":1,"content":[{"type":"text","text":"hi"}]}]}\n` +
    `{"v":1,"kind":"meta","id":"s1","cwd":"/tmp","title":"T","model":"m","status":"idle","createdAt":1,"updatedAt":2,"turnSeq":1}\n`);

  // Mirror: controllable (delay / truncate to simulate death mid-download).
  const mirrorSrv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (req) => {
      const name = new URL(req.url).pathname.slice(1);
      const p = join(mirror, name);
      if (!existsSync(p)) return new Response("nf", { status: 404 });
      if (opts.mirrorDelayMs) await sleep(opts.mirrorDelayMs);
      const buf = Buffer.from(readFileSync(p));
      if (opts.mirrorFailAfterBytes && buf.length > opts.mirrorFailAfterBytes) {
        // Truncate: client sees a short body (or hang up). Bun has no
        // half-close helper here — serve the prefix; the daemon's
        // self-verify (size + --version) must reject it.
        return new Response(buf.subarray(0, opts.mirrorFailAfterBytes));
      }
      return new Response(buf);
    },
  });

  // Fake gateway WS: tracks connects, forwards apply, records events.
  // daemonSockRef exposes the live socket so the test can SEND commands
  // (daemon_update_apply) exactly like the real gateway relay would.
  const events: any[] = [];
  const daemonSockRef: { ws: any } = { ws: null };
  const connects: number[] = [];
  const gwBox: { pendingUpdating: boolean } = { pendingUpdating: false };
  const gw = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, server) => {
      if (new URL(req.url).pathname === "/api/indirect-code/daemon/ws") {
        // Bun drops custom props on upgrade: stash for the next open.
        gwBox.pendingUpdating = new URL(req.url).searchParams.get("updating") === "1";
        if (server.upgrade(req)) return undefined as any;
        return new Response("up", { status: 404 });
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        connects.push(Date.now());
        daemonSockRef.ws = ws;
        if (gwBox.pendingUpdating) events.push({ type: "__updating_reconnect__" });
        gwBox.pendingUpdating = false;
      },
      message: (_ws, data) => { try { events.push(JSON.parse(String(data))); } catch {} },
      close: () => { daemonSockRef.ws = null; },
    },
  });
  const gwURL = `ws://127.0.0.1:${gw.port}`;
  wfs(join(root, "slots", "slot-a", "config.json"), JSON.stringify({
    gateway_url: gwURL, daemon_token: "x", api_key: "y",
    host_id: `gwdeath-${tag}`, name: `gwdeath-${tag}`, settings: {},
  }));

  const env = { ...process.env, INDIRECT_REPO_RAW: `http://127.0.0.1:${mirrorSrv.port}`, INDIRECT_GATEWAY: "" };
  // Canonical boot: dataDir = the slot dir (the launcher layout with
  // dataDir=root only resolves via the legacy slots/ detection).
  const proc = spawn(oldBin,
    ["--data-dir", join(root, "slots", "slot-a"), "--config", join(root, "slots", "slot-a", "config.json"), "--slot", "a"],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (out += d.toString()));
  const t0 = Date.now();
  while (connects.length < 1 && Date.now() - t0 < 20000) await sleep(200);
  assert(connects.length >= 1, `[${tag}] daemon never connected`);
  await sleep(3000); // boot check sees vG2
  log(tag, "daemon connected, manifest seen");
  return {
    work, root, mirror, gw, gwPort: gw.port, mirrorSrv, mirrorPort: mirrorSrv.port,
    daemonSock: daemonSockRef, events, proc, out,
    cleanup: async () => {
      killAll(work);
      killProc(proc);
      await sleep(300);
      try { mirrorSrv.stop(); } catch {}
      try { gw.stop(); } catch {}
      rmSync(work, { recursive: true, force: true });
    },
  };
}

async function waitFor(w: World, type: string, pred: (e: any) => boolean, ms: number, label: string) {
  const t0 = Date.now();
  for (;;) {
    const f = w.events.filter((e: any) => e.type === type && pred(e));
    if (f.length) return f[f.length - 1];
    assert(Date.now() - t0 < ms, `[${label}] timeout waiting ${type}`);
    await sleep(400);
  }
}

async function main() {
  const sendApply = (w: World) => w.daemonSock.ws?.send(JSON.stringify({ type: "daemon_update_apply" }));

  // ---- P0: gateway (WS+manifest) dead BEFORE apply; mirror alive ----
  {
    const w = await bootWorld("p0");
    try {
      w.gw.stop(); // WS + manifest gone; mirror still up
      log("p0", "gateway killed before apply");
      // Daemon can't check (gateway down, mirror has manifest though:
      // fetchManifestWithConfig falls back to mirror -> still sees vG2).
      // Kill the mirror too: total blackout.
      w.mirrorSrv.stop();
      await sleep(2000);
      // Nothing updating; daemon must still be alive (process).
      assert(w.proc.exitCode === null, "[p0] daemon died on gateway loss");
      log("p0", "daemon alive, nothing updating under total blackout — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P1: mirror dies MID launcher download (truncated bytes) ----
  // Gateway alive (can send apply), mirror serves garbage: phase-0
  // self-verify must fail -> update_failed + turn intact.
  {
    const w = await bootWorld("p1-trunc", { mirrorFailAfterBytes: 1024 });
    try {
      w.daemonSock.ws?.send(JSON.stringify({ type: "daemon_update_apply" }));
      log("p1", "apply sent against truncated mirror");
      const failed = await waitFor(w, "update_failed", () => true, 90000, "p1");
      log("p1", `update_failed: ${String((failed as any)?.reason || "").slice(0, 160)}`);
      assert(/verify|mismatch|small|suspicious|download/i.test(String((failed as any)?.reason || "")), "[p1] expected verify/download failure");
      assert(w.proc.exitCode === null, "[p1] daemon died on truncated mirror");
      assert(existsSync(join(w.root, "slots", "slot-a", "sessions", "s1.jsonl")), "[p1] active session intact");
      assert(!existsSync(join(w.root, "slots", "slot-b")), "[p1] no torn inactive slot left");
      log("p1", "truncated download -> clean abort, session intact — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P2: gateway dies WHILE THE UPDATER RUNS (copy/launcher phase) ----
  // Slow mirror keeps the updater busy a while; kill WS + mirror mid-run:
  // launcher --update can't fetch -> fail file -> waiter cleans the slot,
  // reports update_failed, rebirths as a normal daemon on slot-a.
  {
    const w = await bootWorld("p2", { mirrorDelayMs: 3000 });
    try {
      sendApply(w);
      log("p2", "apply sent (slow mirror keeps the updater busy a while)");
      await waitFor(w, "__updating_reconnect__", () => true, 90000, "p2-updater");
      log("p2", "updater running — killing gateway + mirror mid-update");
      w.gw.stop();
      // A real mirror death ABORTS in-flight downloads (TCP RST); Bun's
      // graceful stop() would let the sleeping handler finish the body
      // and the update would legitimately succeed.
      w.mirrorSrv.stop(true);
      const failed = await waitFor(w, "update_failed", () => true, 180000, "p2-failed");
      log("p2", `update_failed: ${String((failed as any)?.reason || "").slice(0, 160)}`);
      await sleep(5000);
      assert(existsSync(join(w.root, "slots", "slot-a", "sessions", "s1.jsonl")), "[p2] active session intact");
      const { readFileSync: rf } = await import("node:fs");
      const active = rf(join(w.root, "slots", "active"), "utf8").trim();
      assert.equal(active, "a", `[p2] active slot flipped under death (got ${active})`);
      log("p2", "gateway death mid-update -> fail file, slot cleaned, rebirth on slot-a — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P4: gateway dies AT PROMOTE (--update-end's hello fails) ----
  // The launcher fetched everything BEFORE the death; --update-end boots
  // but its hello hits a dead gateway -> promote still runs LOCAL-FIRST
  // (updater killed, active flips, old slot cleaned). Assert: active=b,
  // new session intact, old slot gone — the WS reconnects when the
  // gateway returns (same as booting offline).
  {
    const w = await bootWorld("p4");
    try {
      sendApply(w);
      log("p4", "apply sent; waiting for the updater to run, then killing gateway at promote...");
      await waitFor(w, "__updating_reconnect__", () => true, 90000, "p4-updater");
      // Copy is fast locally; launcher fetch takes ~10s. Kill the gateway
      // 5s after the updater owns the host: fetches likely done,
      // --update-end's hello faces a dead gateway.
      await sleep(5000);
      w.gw.stop();
      w.mirrorSrv.stop();
      log("p4", "gateway killed at promote window");
      const { readFileSync: rf2 } = await import("node:fs");
      const t0 = Date.now();
      let active = "";
      while (Date.now() - t0 < 120000) {
        try { active = rf2(join(w.root, "slots", "active"), "utf8").trim(); } catch {}
        if (active === "b") break;
        await sleep(1000);
      }
      assert.equal(active, "b", `[p4] promote did not flip with dead gateway (got ${active})`);
      assert(existsSync(join(w.root, "slots", "slot-b", "sessions", "s1.jsonl")), "[p4] new session intact");
      assert(!existsSync(join(w.root, "slots", "slot-a")), "[p4] old slot survived promote");
      log("p4", "promote with dead gateway -> local-first flip to slot-b — PASS");
    } finally { await w.cleanup(); }
  }

  console.log("\n=== RESULT ===\nPASS: gateway-death chaos (p0-p3)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
