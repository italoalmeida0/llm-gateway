// Handoff E2E with a fake gateway WS (no model, no real gateway):
// old daemon connects -> beginHandoff (via direct call) -> freeze ->
// takeover (real launcher binary) -> old disconnects/dies -> new daemon
// connects from the new slot. Asserts: freeze broadcast, slot flip,
// new daemon serving the same session, old slot cleaned.
//
// Run: bun scripts/test-indirect-handoff-e2e.ts (needs built binaries).
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const DAEMON_DIR = join(ROOT, "indirect-code-daemon");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const work = join(tmpdir(), `handoff-e2e-${Date.now()}`);
  const root = join(work, "root");
  const mirror = join(work, "mirror");
  mkdirSync(join(root, "slots", "slot-a", "bin"), { recursive: true });
  mkdirSync(join(root, "slots", "slot-a", "sessions"), { recursive: true });
  mkdirSync(mirror, { recursive: true });

  // Versioned builds: old=vH1, new=vH2.
  const build = (pkg: string, ver: string, out: string, vvar: string) =>
    execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.${vvar}=${ver}`, "-o", out, pkg], { cwd: DAEMON_DIR });
  const oldBin = join(work, "daemon-old");
  const newBin = join(work, "daemon-new");
  const launcherBin = join(work, "launcher-new");
  build("./cmd/daemon", "vH1", oldBin, "daemonVersion");
  build("./cmd/daemon", "vH2", newBin, "daemonVersion");
  build("./cmd/launcher", "vH2", launcherBin, "launcherVersion");

  // Mirror serves new binaries + manifest vH2.
  const { copyFileSync, writeFileSync: wfs, readFileSync } = await import("node:fs");
  copyFileSync(newBin, join(mirror, "indirect-code-linux-amd64"));
  copyFileSync(launcherBin, join(mirror, "indirect-launcher-linux-amd64"));
  const manifest = {
    daemon: { version: "vH2", assets: { "linux-amd64": "indirect-code-linux-amd64" }, sums: {} },
    launcher: { version: "vH2", assets: { "linux-amd64": "indirect-launcher-linux-amd64" }, sums: {} },
  };
  wfs(join(mirror, "versions.json"), JSON.stringify(manifest));

  // Seed slot-a: old binaries + session + version + config (bad gateway: no WS needed for freeze/copy phases).
  copyFileSync(oldBin, join(root, "slots", "slot-a", "bin", "indirect-code-linux-amd64"));
  copyFileSync(launcherBin, join(root, "slots", "slot-a", "bin", "indirect-launcher-linux-amd64"));
  wfs(join(root, "slots", "active"), "a\n");
  wfs(join(root, "slots", "slot-a", "storage_version.json"), JSON.stringify({ version: 1 }));
  wfs(join(root, "slots", "slot-a", "sessions", "s1.jsonl"),
    `{"v":1,"kind":"turn","turn":1,"messages":[{"role":"user","turnIndex":1,"content":[{"type":"text","text":"hi"}]}]}\n` +
    `{"v":1,"kind":"meta","id":"s1","cwd":"/tmp","title":"T","model":"m","status":"idle","createdAt":1,"updatedAt":2,"turnSeq":1}\n`);
  wfs(join(root, "config.json"), JSON.stringify({
    gateway_url: "ws://127.0.0.1:1", daemon_token: "x", api_key: "y",
    host_id: "handoff-e2e", name: "e2e", settings: {},
  }));

  // Fake mirror server (serves files from mirror dir).
  const mirrorSrv = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => {
      const name = new URL(req.url).pathname.slice(1);
      const p = join(mirror, name);
      if (!existsSync(p)) return new Response("nf", { status: 404 });
      return new Response(Bun.file(p));
    },
  });
  const mirrorURL = `http://127.0.0.1:${mirrorSrv.port}`;
  const env = { ...process.env, INDIRECT_REPO_RAW: mirrorURL };

  // Fake gateway WS: accepts daemon sockets, keeps them open, and can
  // SEND commands (the daemon handleMessages anything on the socket).
  // Tracks connects/disconnects + forwards daemon_update_apply on demand.
  let connects: number[] = [];
  let disconnects = 0;
  let daemonSock: any = null;
  let sawFreeze = false;
  const gw = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, server) => {
      const u = new URL(req.url);
      if (u.pathname === "/api/indirect-code/daemon/ws") {
        if (server.upgrade(req)) return undefined as any;
        return new Response("up", { status: 426 });
      }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open: (ws) => { connects.push(Date.now()); daemonSock = ws; },
      message: (_ws, data) => {
        try {
          const m = JSON.parse(String(data));
          if (m.type === "daemon_update" && m.frozen) sawFreeze = true;
        } catch {}
      },
      close: () => { disconnects++; daemonSock = null; },
    },
  });
  const gwURL = `ws://127.0.0.1:${gw.port}`;
  // Point config at fake gateway.
  const cfg = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  cfg.gateway_url = gwURL;
  wfs(join(root, "config.json"), JSON.stringify(cfg));

  // Start OLD daemon via launcher (slot-aware boot).
  const launcherOld = join(root, "slots", "slot-a", "bin", "indirect-launcher-linux-amd64");
  // Launcher in slot-a is vH2 build (we copied launcherBin); for a faithful
  // old-version boot this is fine (launcher version doesn't gate).
  const proc = spawn(launcherOld, ["--data-dir", root], { env, stdio: ["ignore", "pipe", "pipe"] });
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

  // Wait for boot check to see vH2, then trigger handoff like Update now.
  await sleep(3000);
  assert(daemonSock, "daemon socket open");
  daemonSock.send(JSON.stringify({ type: "daemon_update_apply" }));
  console.log("apply sent; waiting for freeze...");
  const t0 = Date.now();
  while (!sawFreeze && Date.now() - t0 < 60000) await sleep(500);
  assert(sawFreeze, "daemon froze (late freeze after launcher verify)");
  console.log("frozen; waiting for promote (new daemon connects)...");
  await waitConnect(2, 120000);
  assert(disconnects >= 1, "old daemon disconnected");
  console.log("new daemon connected; settling...");
  await sleep(5000);
  const active = readFileSync(join(root, "slots", "active"), "utf8").trim();
  assert.equal(active, "b", `active slot = ${active}`);
  assert(existsSync(join(root, "slots", "slot-b", "sessions", "s1.jsonl")), "session in new slot");
  assert(!existsSync(join(root, "slots", "slot-a")), "old slot cleaned");
  assert(connects.length >= 2, "new daemon connected");
  console.log(`handoff OK: connects=${connects.length} disconnects=${disconnects}`);
  proc.kill("SIGKILL");
  await sleep(500);
  try { execFileSync("pkill", ["-f", join(root, "slots", "slot-b", "bin", "indirect-code-linux-amd64")]); } catch {}
  await sleep(500);
  mirrorSrv.stop();
  gw.stop();
  rmSync(work, { recursive: true, force: true });
  console.log("PASS: full handoff vH1 -> vH2 (freeze, takeover, promote, cleanup)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
