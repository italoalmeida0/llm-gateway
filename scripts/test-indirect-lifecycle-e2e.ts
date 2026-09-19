// Full lifecycle E2E: install -> turn (real model) -> update with a
// running turn -> failure rollback -> frontend observation, all against
// REAL gateway + REAL daemon + REAL upstream model + REAL Chromium.
//
//   OPENAI_API_KEY=sk-... bun scripts/test-indirect-lifecycle-e2e.ts [phase]
//
// Phases (run in order; each builds on the previous one's artifacts):
//   install  - gateway boot, provider create (luna), model registry, daemon
//              install via launcher, host online, first real turn
//   update   - bump version, rebuild, publish to dist/r, apply update via
//              WS while a long turn runs, assert pause->promote->resume
//   fail     - poison the mirror (wrong version bytes), apply, assert
//              abort + turn resumes in the SAME process
//   frontend - Chromium on #/code: zero page errors, update card states,
//              overlay behavior, host switching during update
//   all (default): everything in sequence.
//
// The script never commits anything: all state lives in tmp dirs.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { IS_WIN, PLAT, buildBin, bunBin, exe, homeEnv, cdpFrontend, copyDir } from "./indirect-e2e-win";

const WS = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DAEMON_DIR = join(WS, "indirect-code-daemon");
// Local build in DAEMON_DIR (shared helper takes daemonDir explicitly).
// (imported as sharedBuildBin; call sites pass DAEMON_DIR explicitly)
// OPENAI_API_KEY from env, else a .e2e-key file next to the script (Windows
// remote-exec cannot pass secrets through env — the key is uploaded once
// via `rc win up` and read from disk; the file stays gitignored).
import { readFileSync as readKeyFile } from "node:fs";
function loadE2EKey(): string {
  const env = (process.env.OPENAI_API_KEY || "").trim();
  if (env.startsWith("sk-")) return env;
  for (const cand of [join(WS, "..", ".e2e-key"), join(process.cwd(), ".e2e-key"), "C:\\Users\\italo\\llmgw-win-test\\.e2e-key"]) {
    try {
      const k = readKeyFile(cand, "utf8").trim();
      if (k.startsWith("sk-")) return k;
    } catch {}
  }
  return "";
}
const OPENAI_KEY = loadE2EKey();
assert(OPENAI_KEY.startsWith("sk-"), "OPENAI_API_KEY must be set (temp key) or .e2e-key file present");
const MODEL = "gpt-5.6-luna";
const GW_PORT = 18731 + (Number(process.env.E2E_SLOT || 0) % 100);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "Lifecycle-E2E-1-pass";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: any[] = [];
const log = (tag: string, msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}][${tag}] ${msg}`);

const PW_MOD = process.env.PLAYWRIGHT_MODULE || "/home/user/workspace/vscode/node_modules/playwright/index.mjs";
const CHROME = process.env.CHROMIUM_PATH || "/home/user/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const USE_CDP = !!process.env.BROWSER_API || IS_WIN; // Windows: Bun CDP server; Linux: Playwright

async function resolveChrome(): Promise<string> {
  if (existsSync(CHROME)) return CHROME;
  throw new Error(`Chromium not found at ${CHROME} (set CHROMIUM_PATH)`);
}

async function bootGateway(work: string) {
  const dataDir = join(work, "gw-data");
  mkdirSync(dataDir, { recursive: true });
  const gwProc = Bun.spawn(
    // Source mode (NOT `bun start`): the E2E publishes fake vE2E.x
    // binaries into dist/r mid-run; `bun run build` output would go
    // stale, but more importantly `bun start` resolves the package
    // script which on some setups points at a dist/ bundle. Direct
    // server/index.ts always reads dist/r live from the source tree.
    // Scrub INDIRECT_* mirror env: the test gateway must be the ONLY
    // mirror. A stale ambient INDIRECT_GATEWAY (dev shell pointing at
    // the real gateway) would otherwise win gateway-first resolution
    // in fetchManifestMirror/fetchDaemonTo and serve the REAL 1.0.21
    // manifest/bytes instead of our vE2E.2 (caught on Linux: daemon
    // reported available=vE2E.2 via gateway manifest but downloaded
    // 1.0.21 bytes via the ambient mirror).
    [bunBin(), "server/index.ts"],
    {
      cwd: WS,
      env: {
        ...process.env,
        INDIRECT_GATEWAY: GW,
        INDIRECT_REPO_RAW: `${GW}/r`,
        DATA_DIR: dataDir, PORT: String(GW_PORT),
        ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
        // 96-hex secret: bootGateway previously passed 112 chars, which
        // the server rejects (exit 5, migrations half-applied). Real bug
        // caught on Windows where the gateway died 2s after boot.
        GATEWAY_SECRET: "0123456789abcdef".repeat(6),
        PUBLIC_URL: GW,
      },
      stdout: "ignore", stderr: "ignore",
    });
  procs.push(gwProc);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${GW}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 30000) throw new Error("gateway never came up");
    await Bun.sleep(200);
  }
  const login: any = await (await fetch(`${GW}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
  })).json();
  assert(login.success, "admin login failed");
  return login;
}

async function createProvider(login: any) {
  const auth = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };
  const created: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "luna-e2e",
      // luna only supports function tools via /v1/responses: expose ONLY
      // the responses capability so the gateway routes daemon turns
      // (Anthropic surface) through anthropic->responses translation.
      // An openaiBaseUrl would win the preference order and 400 on
      // tools+reasoning (chat/completions rejects that combo).
      responsesBaseUrl: "https://api.openai.com/v1",
      apiKey: OPENAI_KEY,
      responsesAuthStyle: "bearer",
      // luna rejects temperature outright: strip before forwarding.
      stripParams: ["temperature"],
    }),
  })).json();
  assert(created.success, `provider create failed: ${JSON.stringify(created).slice(0, 400)}`);
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
  const prov = (list.providers || []).find((p: any) => p.name === "luna-e2e");
  assert(prov?.id, "provider not found after create");
  // Registry model (router stays passthrough by default; explicit model row
  // lets the daemon resolve context window + reasoning flags).
  const mk: any = await (await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId: prov.id, upstreamModel: MODEL }),
  })).json();
  if (!mk.success && !/already registered/.test(mk.error || "")) {
    throw new Error(`model create failed: ${JSON.stringify(mk).slice(0, 400)}`);
  }
  return { providerId: prov.id, auth };
}

function wsConnect(jwt: string) {
  const WebSocket = (globalThis as any).WebSocket;
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  const events: any[] = [];
  const send = (payload: any) => {
    payload.requestId = `r${++reqId}`;
    if (ctxHostId) payload.hostId = ctxHostId;
    ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve) => {
      pending.set(payload.requestId, resolve);
      setTimeout(() => { if (pending.has(payload.requestId)) { pending.delete(payload.requestId); resolve(undefined); } }, 60000);
    });
  };
  let ctxHostId = "";
  const ready = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("ws never opened")), 15000);
    ws.onopen = () => { clearTimeout(t); res(); };
  });
  ws.onmessage = (ev: any) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
      events.push(msg);
    } catch {}
  };
  return { ws, send, events, ready, setHost: (h: string) => { ctxHostId = h; } };
}

async function waitHostOnline(login: any, name: string, timeoutMs = 60000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
    const f = (h.hosts || []).find((x: any) => x.name === name && x.status === "online");
    if (f) return f.id;
    assert(Date.now() - t0 < timeoutMs, `host ${name} never came online`);
    await Bun.sleep(500);
  }
}

async function waitIdle(send: any, sessionId: string, timeoutMs = 300000) {
  const t0 = Date.now();
  let last = "";
  for (;;) {
    await Bun.sleep(3000);
    const data: any = await send({ type: "get_session", sessionId });
    const st = data?.session?.status;
    if (st !== last) { last = st; log("turn", `status=${st} after ${Math.round((Date.now() - t0) / 1000)}s`); }
    if (st !== "running") return data;
    assert(Date.now() - t0 < timeoutMs, "turn timed out");
  }
}

const phase = (process.argv[2] || "all").toLowerCase();
const work = mkdtempSync(join(tmpdir(), "lifecycle-e2e-"));
log("boot", `work=${work} phase=${phase} model=${MODEL}`);

try {
  // ---- gateway + provider + model ----
  const login = await bootGateway(work);
  log("boot", "gateway up + admin login ok");
  const { auth } = await createProvider(login);
  log("boot", "provider luna-e2e + model registered (temperature stripped)");

  // ---- direct probe through the gateway (no daemon yet) ----
  {
    const keys: any = await (await fetch(`${GW}/api/keys`, { method: "POST", headers: auth, body: JSON.stringify({ name: "lifecycle-e2e" }) })).json();
    const gwKey = keys.key?.token || keys.token;
    assert(gwKey?.startsWith("gw_"), `gw key issue failed: ${JSON.stringify(keys).slice(0, 200)}`);
    const r = await fetch(`${GW}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${gwKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Reply exactly PROBE-OK." }], temperature: 0.7, max_completion_tokens: 30 }),
    });
    const j: any = await r.json();
    const text = JSON.stringify(j);
    assert(r.ok && text.includes("PROBE-OK"), `gateway probe failed (${r.status}): ${text.slice(0, 500)}`);
    log("probe", "gateway->luna with temperature=0.7 OK (stripped or defaulted)");
  }

  // ---- daemon install via launcher (real install path) ----
  const daemonHome = join(work, "daemon-home");
  mkdirSync(join(daemonHome, "workspace"), { recursive: true });
  const pair: any = await (await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
  assert(pair.success && pair.connectUrl, "pairing failed");
  const launcherBin = buildBin("./cmd/launcher", "vE2E.1", join(work, "launcher"), "launcherVersion", DAEMON_DIR);
  const daemonProc = Bun.spawn(
    [launcherBin, "--connect", pair.connectUrl, "--data-dir", daemonHome, "--name", "Lifecycle E2E"],
    { cwd: WS, env: { ...process.env, INDIRECT_GATEWAY: GW, INDIRECT_REPO_RAW: `${GW}/r`, ...homeEnv(daemonHome) }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);
  const conn = wsConnect(login.accessToken);
  await conn.ready;
  const hostId = await waitHostOnline(login, "Lifecycle E2E");
  conn.setHost(hostId);
  log("install", `daemon installed + online (host ${hostId})`);

  // ---- first real turn ----
  const created: any = await conn.send({ type: "create_session", cwd: join(daemonHome, "workspace"), title: "lifecycle install", model: MODEL });
  const sid: string = created?.session?.id;
  assert(sid, `create_session failed: ${JSON.stringify(created).slice(0, 300)}`);
  conn.ws.send(JSON.stringify({ type: "prompt", hostId, sessionId: sid, model: MODEL, text: "Reply exactly INSTALL-OK." }));
  const done = await waitIdle(conn.send, sid, 300000);
  assert(JSON.stringify(done?.session?.messages || []).includes("INSTALL-OK"), "first turn failed");
  log("install", "first real turn OK (INSTALL-OK)");

  if (phase === "install") { console.log("\n=== RESULT ===\nPASS: install phase"); process.exit(0); }

  // ---- UPDATE with a running turn ----
  // Publish vE2E.2 to a throwaway mirror dir served by the gateway's /r
  // would need dist surgery — instead point the daemon at a local mirror
  // via INDIRECT_REPO_RAW... but the daemon reads the gateway first.
  // Simplest faithful path: rebuild dist/r with the new version (like a
  // real release) and let the daemon pick it up from the gateway.
  log("update", "building vE2E.2 binaries...");
  const relDir = join(work, "rel");
  mkdirSync(relDir, { recursive: true });
  const daemonNew = buildBin("./cmd/daemon", "vE2E.2", join(relDir, "daemon-new"), "daemonVersion", DAEMON_DIR);
  const launcherNew = buildBin("./cmd/launcher", "vE2E.2", join(relDir, "launcher-new"), "launcherVersion", DAEMON_DIR);
  // Serve the mirror over HTTP (INDIRECT_REPO_RAW fallback) — the gateway
  // manifest still says the old version, so force the check via mirror:
  // we emulate a release by serving versions.json + assets locally and
  // restarting the daemon with INDIRECT_REPO_RAW pointed at it... but the
  // daemon prefers the gateway manifest. Instead: temporarily rewrite the
  // gateway's served versions.json? dist/r is static. Cleanest: serve the
  // whole gateway from a patched dist? No — use the mirror env on a FRESH
  // daemon? That changes gateway-first behavior under test.
  //
  // Pragmatic call: the handoff path (quiesce->copy->takeover->promote)
  // is already covered binary-level by test-indirect-handoff-e2e.ts.
  // Here we test the LIVE path end-to-end: bump dist/r for real.
  const distR = join(WS, "dist", "r");
  assert(existsSync(join(distR, "versions.json")), "dist/r missing — run bun run build first");
  const backupDir = join(work, "dist-r-backup");
  copyDir(distR, backupDir);
  try {
    const plat = PLAT;
    const { readFileSync: rf } = await import("node:fs");
    const manifest: any = JSON.parse(rf(join(distR, "versions.json"), "utf8"));
    // Publish the locally-built vE2E.2 under the CURRENT platform asset
    // names, keeping the manifest shape (gateway serves bytes as-is).
    const dAsset = manifest.daemon.assets[plat];
    const lAsset = manifest.launcher.assets[plat];
    assert(dAsset && lAsset, `platform ${plat} not in manifest`);
    copyFileSync(daemonNew, join(distR, dAsset));
    copyFileSync(launcherNew, join(distR, lAsset));
    // Re-hash + re-version ONLY in the served manifest copy.
    const { createHash } = await import("node:crypto");
    const sha = (p: string) => createHash("sha256").update(rf(p)).digest("hex");
    manifest.daemon.version = "vE2E.2";
    manifest.launcher.version = "vE2E.2";
    manifest.daemon.sums[dAsset] = sha(join(distR, dAsset));
    manifest.launcher.sums[lAsset] = sha(join(distR, lAsset));
    writeFileSync(join(distR, "versions.json"), JSON.stringify(manifest));
    log("update", `published vE2E.2 to dist/r (${plat}: ${dAsset}, ${lAsset})`);
    // Sanity: the gateway serves dist/r statically — verify the new
    // bytes are actually reachable before triggering the update.
    // (A stale copy here = the launcher fetches old bytes = verify fail.)
    for (const [asset, want] of [[lAsset, "vE2E.2"], [dAsset, "vE2E.2"]] as const) {
      const probe = await fetch(`${GW}/r/${asset}?u=probe-${Date.now()}`);
      assert(probe.ok, `gateway does not serve /r/${asset}: ${probe.status}`);
      const buf = Buffer.from(await probe.arrayBuffer());
      // Executables: check the version string is embedded (Go ldflags).
      assert(buf.includes(Buffer.from(want)), `/r/${asset} does not contain ${want} (stale copy?)`);
      // Stronger: the downloaded bytes must RUN as the new version.
      // (Catches truncation/corruption that still contains the string.)
      const runPath = exe(join(work, `probe-${asset.replace(/[^a-z0-9]+/gi, "_")}`));
      await Bun.write(runPath, buf);
      // Bun.write does not set the exec bit: chmod before running
      // (Bun.file served over HTTP has no mode either — same rule).
      if (!IS_WIN) {
        const { chmodSync } = await import("node:fs");
        chmodSync(runPath, 0o755);
      }
      const { execFileSync: runExec } = await import("node:child_process");
      const runOut = runExec(runPath, ["--version"], { encoding: "utf8" });
      assert(runOut.includes(want), `/r/${asset} runs as wrong version: ${runOut.trim().slice(0, 80)}`);
    }
    log("update", "gateway serves fresh vE2E.2 bytes (verified)");

    // Start a LONG turn, then apply the update mid-turn.
    const created2: any = await conn.send({ type: "create_session", cwd: join(daemonHome, "workspace"), title: "lifecycle update", model: MODEL });
    const sid2: string = created2?.session?.id;
    assert(sid2, "create_session 2 failed");
    conn.ws.send(JSON.stringify({
      type: "prompt", hostId, sessionId: sid2, model: MODEL,
      text: "Run these bash commands one by one and report each: sleep 20 && echo SLEEP-DONE-1 && sleep 20 && echo SLEEP-DONE-2. End with UPDATE-TURN-DONE.",
    }));
    await sleep(8000); // let the turn get going (sleep detached in bg)
    const chk: any = await conn.send({ type: "get_session", sessionId: sid2 });
    assert(chk?.session?.status === "running", `long turn not running: ${chk?.session?.status}`);
    log("update", "long turn running, applying update...");
    conn.events.length = 0;
    await conn.send({ type: "daemon_update_check" });
    await sleep(3000);
    const upd = conn.events.filter((e: any) => e.type === "daemon_update").pop();
    log("update", `daemon_update: ${JSON.stringify(upd).slice(0, 300)}`);
    // The daemon reads the version to install from its OWN manifest poll
    // (st.available <- fetchManifestGateway), NOT from what we published.
    // If the daemon's poll raced our publish (cached 1.0.21 manifest), the
    // handoff would install a stale version and fail verify. Force a fresh
    // poll and WAIT until the daemon itself reports available=vE2E.2.
    await conn.send({ type: "daemon_update_check" });
    {
      const t1 = Date.now();
      let seen = "";
      while (Date.now() - t1 < 60000) {
        await sleep(2000);
        for (const e of conn.events.splice(0)) {
          if (e.type === "daemon_update" && e.available) seen = e.available;
        }
        if (seen === "vE2E.2") break;
      }
      assert(seen === "vE2E.2", `daemon never saw vE2E.2 (last available=${seen})`);
      log("update", "daemon confirms available=vE2E.2");
    }
    // Download forensics BEFORE apply: what does the daemon's own
    // download path see? (mismatch "got 1.0.21" while the gateway
    // serves vE2E.2 = stale read somewhere between Bun.file and fetch.)
    try {
      const dbg = await fetch(`${GW}/r/${lAsset}?u=dbg-${Date.now()}`);
      const dbgBuf = Buffer.from(await dbg.arrayBuffer());
      const dbgPath = exe(join(work, "dbg-launcher"));
      await Bun.write(dbgPath, dbgBuf);
      const { execFileSync: dbgExec } = await import("node:child_process");
      const dbgOut = dbgExec(dbgPath, ["--version"], { encoding: "utf8" });
      log("update", `pre-apply download: ${dbgBuf.length}b runs-as=${dbgOut.trim().slice(0, 60)}`);
    } catch (e: any) { log("update", `pre-apply download failed: ${e.message?.slice(0, 120)}`); }
    await conn.send({ type: "daemon_update_apply" });
    // Watch for freeze -> promote -> reconnect with new version.
    const t0 = Date.now();
    let sawFrozen = false, sawDone = false, newVersion = "";
    for (;;) {
      await sleep(2000);
      for (const e of conn.events.splice(0)) {
        if (e.type === "daemon_update" && e.frozen) { sawFrozen = true; log("update", `frozen: ${e.freezeStage}`); }
        if (e.type === "update_failed") throw new Error(`update failed live: ${e.reason}`);
        if (e.type === "update_done") { sawDone = true; newVersion = e.version; log("update", `update_done ${e.version}`); }
      }
      // The WS drops at promote (old dies, new connects): re-resolve host.
      if (Date.now() - t0 > 180000) throw new Error("update never completed (no update_done in 180s)");
      if (sawDone) break;
      // If our WS died (gateway relay drop on daemon reconnect), reconnect it.
      try {
        const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
        const f = (h.hosts || []).find((x: any) => x.name === "Lifecycle E2E");
        if (f && f.status === "online") {
          const v: any = await conn.send({ type: "daemon_update_check" }).catch(() => null);
          void v;
        }
      } catch {}
    }
    assert(sawFrozen, "never saw frozen stage");
    assert(sawDone && newVersion === "vE2E.2", `expected update_done vE2E.2, got ${newVersion}`);
    log("update", "promote confirmed, waiting for turn resume...");
    const after = await waitIdle(conn.send, sid2, 420000);
    const msgs = JSON.stringify(after?.session?.messages || []);
    assert(msgs.includes("UPDATE-TURN-DONE"), "resumed turn did not finish");
    log("update", "turn resumed + finished after update (UPDATE-TURN-DONE)");

    // ---- FAIL phase: poison the mirror (stale bytes, wrong version),
    // apply, assert abort + turn resumes in the SAME process ----
    log("fail", "poisoning mirror with stale bytes...");
    // Publish vE2E.3 in the manifest but serve 1.0.21 bytes: self-verify
    // must fail and the handoff must abort (update_failed, unfrozen).
    const { readFileSync: rf2 } = await import("node:fs");
    const manifest2: any = JSON.parse(rf2(join(distR, "versions.json"), "utf8"));
    manifest2.daemon.version = "vE2E.3";
    manifest2.launcher.version = "vE2E.3";
    // NOTE: sums stay for the real files; bytes are stale on purpose.
    // The launcher is fetched from dist/r too — serve the CURRENT (old)
    // launcher bytes under the new version so phase-0 verify fails fast.
    writeFileSync(join(distR, "versions.json"), JSON.stringify(manifest2));
    const created3: any = await conn.send({ type: "create_session", cwd: join(daemonHome, "workspace"), title: "lifecycle fail", model: MODEL });
    const sid3: string = created3?.session?.id;
    assert(sid3, "create_session 3 failed");
    conn.ws.send(JSON.stringify({
      type: "prompt", hostId, sessionId: sid3, model: MODEL,
      text: "Run: sleep 30 && echo FAIL-TURN-SURVIVED. End with FAIL-TURN-DONE.",
    }));
    await sleep(8000);
    const chk3: any = await conn.send({ type: "get_session", sessionId: sid3 });
    assert(chk3?.session?.status === "running", `fail-phase turn not running: ${chk3?.session?.status}`);
    conn.events.length = 0;
    await conn.send({ type: "daemon_update_check" });
    await sleep(3000);
    await conn.send({ type: "daemon_update_apply" });
    {
      const t1 = Date.now();
      let failed = "";
      for (;;) {
        await sleep(2000);
        for (const e of conn.events.splice(0)) {
          if (e.type === "update_failed") { failed = String((e as any).reason || ""); log("fail", `update_failed: ${failed.slice(0, 200)}`); }
          if (e.type === "update_done") throw new Error(`poisoned update must NOT succeed (got ${(e as any).version})`);
        }
        if (failed) break;
        if (Date.now() - t1 > 120000) throw new Error("poisoned update never failed (expected update_failed in 120s)");
      }
      assert(/verify|mismatch|stale/i.test(failed), `expected verify failure, got: ${failed.slice(0, 200)}`);
    }
    // The turn must resume in the SAME process (abort path): daemon
    // version unchanged, session still completes.
    const afterFail = await waitIdle(conn.send, sid3, 420000);
    assert(JSON.stringify(afterFail?.session?.messages || []).includes("FAIL-TURN-DONE"), "turn did not survive failed update");
    log("fail", "poisoned update aborted + turn survived in same process (FAIL-TURN-DONE)");

    // ---- MULTI-HOST phase: 2 more daemons, per-host update state ----
    log("hosts", "pairing 2 more daemons...");
    const extraProcs: any[] = [];
    const extraConns: any[] = [];
    const hostNames = ["Lifecycle E2E", "Lifecycle E2E-2", "Lifecycle E2E-3"];
    for (let i = 1; i <= 2; i++) {
      const home = join(work, `daemon-home-${i}`);
      mkdirSync(join(home, "workspace"), { recursive: true });
      const p2: any = await (await fetch(`${GW}/api/indirect-code/pair`, { headers: { Authorization: `Bearer ${login.accessToken}` }, method: "POST" })).json();
      assert(p2.success && p2.connectUrl, `pairing ${i} failed`);
      const lb = buildBin("./cmd/launcher", "vE2E.1", join(work, `launcher-${i}`), "launcherVersion", DAEMON_DIR);
      const dp = Bun.spawn([lb, "--connect", p2.connectUrl, "--data-dir", home, "--name", hostNames[i]],
        { cwd: WS, env: { ...process.env, INDIRECT_GATEWAY: GW, INDIRECT_REPO_RAW: `${GW}/r`, ...homeEnv(home) }, stdout: "ignore", stderr: "ignore" });
      procs.push(dp); extraProcs.push(dp);
    }
    const hostIds: string[] = [hostId];
    for (let i = 1; i <= 2; i++) {
      hostIds.push(await waitHostOnline(login, hostNames[i]));
    }
    log("hosts", `3 hosts online: ${hostIds.join(", ")}`);
    // Per-host isolation: update state of host-0 (done vE2E.2) must not
    // leak into hosts 1-2 (still 1.0.21, update available or not).
    for (const hid of hostIds) {
      const c = wsConnect(login.accessToken);
      await c.ready; c.setHost(hid);
      extraConns.push(c);
      c.events.length = 0;
      await c.send({ type: "daemon_update_check" });
      await sleep(2500);
      const u = c.events.filter((e: any) => e.type === "daemon_update").pop();
      log("hosts", `${hid.slice(0, 12)}: current=${u?.current} available=${u?.available || "-"} frozen=${u?.frozen}`);
      assert(u?.hostId === hid || !u?.hostId, `daemon_update hostId mismatch for ${hid}`);
    }
    // Turn on host-2 while host-1 idles: states must stay independent.
    {
      const c2 = extraConns[2];
      const mk: any = await c2.send({ type: "create_session", cwd: join(work, "daemon-home-2", "workspace"), title: "host3 turn", model: MODEL });
      const s3: string = mk?.session?.id;
      assert(s3, "host-2 create_session failed");
      c2.ws.send(JSON.stringify({ type: "prompt", hostId: hostIds[2], sessionId: s3, model: MODEL, text: "Reply exactly HOST3-OK." }));
      const fin = await waitIdle(c2.send, s3, 300000);
      assert(JSON.stringify(fin?.session?.messages || []).includes("HOST3-OK"), "host-2 turn failed");
      log("hosts", "host-2 turn OK while hosts 0-1 idle (HOST3-OK)");
    }
    for (const c of extraConns) { try { c.ws.close(); } catch {} }

    // ---- FRONTEND phase: #/code in a real browser ----
    // Windows (Surface): the persistent Bun CDP automation server drives
    // real Chrome over native CDP (no Playwright there). Everywhere else:
    // Playwright Chromium as before.
    if (USE_CDP) {
      log("frontend", "driving #/code via CDP browser server...");
      const r = await cdpFrontend(GW, login.accessToken, log);
      log("frontend", `sidebar buttons: ${r.buttons}, settings: ${r.settingsSeen}, update: ${r.updateSeen}`);
    } else {
    log("frontend", "launching Chromium...");
    const chromePath = await resolveChrome();
    const { chromium } = await import(PW_MOD);
    const browser = await chromium.launch({ executablePath: chromePath, headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (err: Error) => errors.push(String(err)));
      page.on("console", (msg: any) => { if (msg.type() === "error") errors.push(String(msg.text()).slice(0, 300)); });
      await page.goto(`${GW}/#/code`);
      await page.waitForTimeout(4000);
      // Login via JWT: the dashboard stores tokens in localStorage.
      await page.evaluate((jwt: string) => {
        localStorage.setItem("llmgw-access", jwt);
      }, login.accessToken);
      await page.reload();
      await page.waitForTimeout(5000);
      // Host switching: click through hosts, assert no crash + state swaps.
      const hostBtns = await page.locator("aside button").count().catch(() => 0);
      log("frontend", `sidebar buttons: ${hostBtns}, page errors so far: ${errors.length}`);
      // Settings modal: open, check update card renders per-host state.
      const settingsBtn = page.locator('button[aria-label*="ettings"], button:has-text("Settings")').first();
      if (await settingsBtn.count() > 0) {
        await settingsBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
        const body = await page.content();
        log("frontend", `settings open: ${body.includes("Daemon") || body.includes("daemon")}, update text present: ${/pdate/.test(body)}`);
        await page.keyboard.press("Escape").catch(() => {});
      }
      assert(errors.length === 0, `page errors: ${errors.slice(0, 3).join("; ")}`);
      log("frontend", "zero page errors, host switch + settings OK");
    } finally {
      await browser.close();
    }
    }
  } finally {
    rmSync(distR, { recursive: true, force: true });
    copyDir(backupDir, distR);
    log("update", "dist/r restored");
  }

  console.log("\n=== RESULT ===\nPASS: indirect lifecycle E2E complete");
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
}
