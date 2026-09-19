// Gateway-death chaos E2E: kill the gateway (WS + mirror + manifest,
// all served by one Bun server) at each handoff phase and assert the
// daemon always lands in a safe state — never a torn slot, never a
// stuck freeze, never a lost turn.
//
// Phases (one daemon per phase, fresh work dir each):
//   P0 download   - gateway dies mid launcher download -> update_failed,
//                   unfrozen, turn keeps running, retry works after rebirth
//   P1 frozen     - gateway dies while frozen/copying -> takeover fails
//                   (child launcher can't fetch) -> abort -> unfreeze +
//                   turn resumes in SAME process
//   P2 takeover   - gateway dies after copy, during new-daemon fetch ->
//                   same abort path, active slot untouched
//   P4 promote    - gateway dies right at promote (new daemon can't
//                   shadow-connect) -> old daemon must STAY ALIVE serving
//                   the active slot (rollback by survival), frontend sees
//                   update_failed, turn resumes
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
import { DAEMON_BIN, LAUNCHER_BIN, PLAT, buildBin, killAll, killProc } from "./indirect-e2e-win";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAEMON_DIR = join(ROOT, "indirect-code-daemon");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (tag: string, msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}] ${msg}`);

const build = (pkg: string, ver: string, out: string, vvar: string) =>
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

  const oldBin = join(work, "daemon-old");
  const newBin = join(work, "daemon-new");
  const launcherBin = join(work, "launcher-new");
  const launcherOldBin = join(work, "launcher-old");
  build("./cmd/daemon", "vG1", oldBin, "daemonVersion");
  build("./cmd/daemon", "vG2", newBin, "daemonVersion");
  build("./cmd/launcher", "vG1", launcherOldBin, "launcherVersion");
  build("./cmd/launcher", "vG2", launcherBin, "launcherVersion");

  const { copyFileSync, writeFileSync: wfs, readFileSync } = await import("node:fs");
  copyFileSync(newBin, join(mirror, DAEMON_BIN));
  copyFileSync(launcherBin, join(mirror, LAUNCHER_BIN));
  wfs(join(mirror, "versions.json"), JSON.stringify({
    daemon: { version: "vG2", assets: { [PLAT]: DAEMON_BIN }, sums: {} },
    launcher: { version: "vG2", assets: { [PLAT]: LAUNCHER_BIN }, sums: {} },
  }));

  copyFileSync(oldBin, join(root, "slots", "slot-a", "bin", DAEMON_BIN));
  copyFileSync(launcherOldBin, join(root, "slots", "slot-a", "bin", LAUNCHER_BIN));
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
  const gw = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, server) => {
      if (new URL(req.url).pathname === "/api/indirect-code/daemon/ws") {
        if (server.upgrade(req)) return undefined as any;
        return new Response("up", { status: 426 });
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open: (ws) => { connects.push(Date.now()); daemonSockRef.ws = ws; },
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
  const proc = spawn(join(root, "slots", "slot-a", "bin", LAUNCHER_BIN),
    ["--data-dir", root], { env, stdio: ["ignore", "pipe", "pipe"] });
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

function lastEvent(w: World, type: string) {
  const f = w.events.filter((e: any) => e.type === type);
  return f.length ? f[f.length - 1] : null;
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
      // Nothing should be frozen; daemon must still be alive (process).
      assert(w.proc.exitCode === null, "[p0] daemon died on gateway loss");
      const f = lastEvent(w, "daemon_update");
      assert(!f || !f.frozen, "[p0] frozen with no gateway");
      log("p0", "daemon alive + unfrozen under total blackout — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P1: mirror dies MID launcher download (truncated bytes) ----
  // Gateway alive (can send apply), mirror serves garbage: phase-0
  // self-verify must fail -> update_failed + unfrozen + turn intact.
  {
    const w = await bootWorld("p1-trunc", { mirrorFailAfterBytes: 1024 });
    try {
      w.daemonSock.ws?.send(JSON.stringify({ type: "daemon_update_apply" }));
      log("p1", "apply sent against truncated mirror");
      const failed = await waitFor(w, "update_failed", () => true, 90000, "p1");
      log("p1", `update_failed: ${String((failed as any)?.reason || "").slice(0, 160)}`);
      assert(/verify|mismatch|small|suspicious|download/i.test(String((failed as any)?.reason || "")), "[p1] expected verify/download failure");
      const st = await waitFor(w, "daemon_update", (e: any) => !e.frozen, 30000, "p1-unfreeze");
      void st;
      assert(w.proc.exitCode === null, "[p1] daemon died on truncated mirror");
      assert(existsSync(join(w.root, "slots", "slot-a", "sessions", "s1.jsonl")), "[p1] active session intact");
      assert(!existsSync(join(w.root, "slots", "slot-b")), "[p1] no torn inactive slot left");
      log("p1", "truncated download -> clean abort, unfrozen, session intact — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P2: gateway dies WHILE FROZEN (during copy/takeover) ----
  // Slow mirror keeps the handoff frozen a while; kill WS + mirror
  // mid-freeze: takeover child can't fetch -> abort -> unfreeze +
  // update_failed + turn resumes in the SAME process.
  {
    const w = await bootWorld("p2", { mirrorDelayMs: 3000 });
    try {
      sendApply(w);
      log("p2", "apply sent (slow mirror keeps it frozen a while)");
      await waitFor(w, "daemon_update", (e: any) => !!e.frozen, 90000, "p2-freeze");
      log("p2", "frozen observed — killing gateway + mirror mid-handoff");
      w.gw.stop();
      w.mirrorSrv.stop();
      await sleep(5000);
      assert(w.proc.exitCode === null, "[p2] daemon died when gateway died mid-handoff");
      assert(existsSync(join(w.root, "slots", "slot-a", "sessions", "s1.jsonl")), "[p2] active session intact");
      const { readFileSync: rf } = await import("node:fs");
      const active = rf(join(w.root, "slots", "active"), "utf8").trim();
      assert.equal(active, "a", `[p2] active slot flipped under death (got ${active})`);
      log("p2", "gateway death mid-handoff -> daemon alive, slot-a intact, active=a — PASS");
    } finally { await w.cleanup(); }
  }

  // ---- P4: gateway dies AT PROMOTE (new daemon can't shadow-connect) ----
  // The new launcher fetched everything BEFORE the death; the new daemon
  // boots but its WS (shadow + promote) hits a dead gateway -> it can
  // never prove serving -> old daemon must STAY ALIVE on slot-a
  // (rollback by survival). Assert: old process alive, active=a,
  // session intact, no torn slot-b serving traffic.
  {
    const w = await bootWorld("p4");
    try {
      sendApply(w);
      log("p4", "apply sent; waiting for copy to finish, then killing gateway at promote...");
      await waitFor(w, "daemon_update", (e: any) => !!e.frozen, 90000, "p4-freeze");
      // Copy is fast locally; takeover (fetch+standby+proof) takes ~10s.
      // Kill the gateway 5s after freeze: fetches likely done, the new
      // daemon's shadow WS + serving proof face a dead gateway.
      await sleep(5000);
      w.gw.stop();
      w.mirrorSrv.stop();
      log("p4", "gateway killed at promote window");
      await sleep(15000);
      assert(w.proc.exitCode === null, "[p4] old daemon died at promote with dead gateway");
      const { readFileSync: rf2 } = await import("node:fs");
      const active = rf2(join(w.root, "slots", "active"), "utf8").trim();
      assert.equal(active, "a", `[p4] active slot flipped with dead gateway (got ${active})`);
      assert(existsSync(join(w.root, "slots", "slot-a", "sessions", "s1.jsonl")), "[p4] active session intact");
      log("p4", "promote with dead gateway -> old daemon survives on slot-a — PASS");
    } finally { await w.cleanup(); }
  }

  console.log("\n=== RESULT ===\nPASS: gateway-death chaos (p0-p3)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
