/**
 * scripts/test-indirect-bg-e2e.ts — full-stack background-task check with a
 * REAL browser (same family as test-indirect-turn-ui.ts: Playwright stays an
 * external install, never an app dependency).
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome \
 *     bun scripts/test-indirect-bg-e2e.ts
 *
 * Boots a real gateway + real Go daemon + the Meta provider from .env
 * (META_API_KEY / META_BASE_URL), runs two model turns, and asserts what a
 * user actually sees on #/code:
 *
 *   A. finish flow — bash detaches (~10s), the model sleep-waits, the job
 *      finishes: the tool row folds the .log result (no "still running"
 *      placeholder), the header shows the full duration, zero page errors.
 *   B. manual cancel — while a job runs, the dashboard Stop button is
 *      clicked: the AI gets a cancellation notice in context, the .log
 *      records who stopped it, the row folds a truthful marker, zero page
 *      errors.
 *
 * Prerequisites: web dist/ built (bun run build:web), daemon binary built
 * (go build -o bin/indirect-code ./cmd/daemon in indirect-code-daemon/).
 * Slow on purpose (~3 min, real model latency); this is a manual gate, not
 * part of `bun test`. Fails non-zero with the collected evidence printed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname));
const WS = path.join(ROOT, "..");
const envFile = await fs.readFile(path.join(WS, ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};
const META_KEY = envGet("META_API_KEY");
const META_BASE = envGet("META_BASE_URL") || "https://api.meta.ai/v1";
const MODEL = process.env.E2E_MODEL || "muse-spark-1.3-contributor";
if (!META_KEY) {
  console.error("META_API_KEY missing — put it in .env (gitignored) or the environment");
  process.exit(2);
}
const daemonBin = path.join(WS, "indirect-code-daemon", "bin", "indirect-code");
if (!(await fs.stat(daemonBin).catch(() => null))) {
  console.error(`daemon binary missing: run go build -o bin/indirect-code ./cmd/daemon in indirect-code-daemon/`);
  process.exit(2);
}
if (!(await fs.stat(path.join(WS, "dist", "index.html")).catch(() => null))) {
  console.error("web dist/ missing: run bun run build:web first");
  process.exit(2);
}
async function resolveChrome(): Promise<string> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  const cands: string[] = [];
  for (const d of ["chromium-1234", "chromium-1228"]) {
    cands.push(`${cache}/${d}/chrome-linux/chrome`, `${cache}/${d}/chrome-linux64/chrome`);
    cands.push(`${cache}/${d.replace("chromium", "chromium_headless_shell")}/chrome-headless-shell-linux64/chrome-headless-shell`);
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  for (const c of cands) {
    if (await fs.stat(c).catch(() => null)) return c;
  }
  console.error("no Chrome found: set CHROMIUM_PATH");
  process.exit(2);
}

const GW_PORT = Number(process.env.E2E_GW_PORT || 4610);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-admin-pass-1";
const procs: Array<{ kill: () => void }> = [];

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

async function boot(): Promise<{ jwt: string; login: any; hostId: string; ws: WebSocket; send: (p: any) => Promise<any>; workDir: string }> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-e2e-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW,
    },
    stdout: "ignore", stderr: "ignore",
  });
  procs.push(gwProc);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${GW}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }
  const login: any = await (await fetch(`${GW}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
  })).json();
  assert(login.success, "admin login failed");
  const jwt = login.accessToken;
  const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };
  const pair: any = await (await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert(pair.success && pair.connectUrl, "pairing failed");
  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-e2e-d-"));
  mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
  const workDir = path.join(daemonDir, "workspace");
  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "E2E Daemon"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);
  const prov: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "meta", openaiBaseUrl: META_BASE, apiKey: META_KEY, openaiAuthStyle: "bearer" }),
  })).json();
  assert(prov.success, "provider create failed");
  await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId: "meta", upstreamModel: MODEL }),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  let hostId = "";
  const send = (payload: any) => {
    payload.requestId = `r${++reqId}`;
    payload.hostId = hostId;
    ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve) => {
      pending.set(payload.requestId, resolve);
      setTimeout(() => { if (pending.has(payload.requestId)) { pending.delete(payload.requestId); resolve(undefined); } }, 30000);
    });
  };
  let lastBg: any = null;
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
      if (msg.type === "bg_list" || msg.type === "bg_update") lastBg = msg;
    } catch {}
  };
  const bgSnapshot = async () => {
    ws.send(JSON.stringify({ type: "bg_list", hostId, requestId: "bgx" }));
    await Bun.sleep(1200);
    return (lastBg?.jobs || []) as any[];
  };
  {
    const start = Date.now();
    while (!hostId && Date.now() - start < 20000) {
      const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
      const f = (h.hosts || []).find((x: any) => x.name === "E2E Daemon" && x.status === "online");
      if (f) hostId = f.id;
      else await Bun.sleep(300);
    }
  }
  assert(hostId, "daemon host never came online");
  log("boot", `gateway + daemon up (host ${hostId})`);
  return { jwt, login, hostId, ws, send, workDir, bgSnapshot } as any;
}

async function openSessionPage(ctx: any, sessionId: string) {
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 300)); });
  await page.addInitScript(({ sess, hid, sid }: any) => {
    localStorage.setItem("llm_gateway_session", JSON.stringify(sess));
    localStorage.setItem(`llmgw-rc-session:${hid}`, sid);
  }, {
    sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
    hid: ctx.hostId, sid: sessionId,
  });
  await page.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
  await page.waitForTimeout(8000);
  // Open the turn aggregate, then every tool row (row toggles are divs).
  await page.evaluate(() => {
    for (const b of [...document.querySelectorAll("button")]) {
      if (/Explored|command/i.test(b.textContent || "")) { try { (b as HTMLElement).click(); } catch {} }
    }
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    for (const h of [...document.querySelectorAll("[data-toolseg] div.group\\/tool")]) {
      try { (h as HTMLElement).click(); } catch {}
    }
  });
  await page.waitForTimeout(2000);
  return { browser, page, pageErrors, consoleErrors };
}

function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `${where}: console errors: ${consoleErrors.join(" | ")}`);
}

// A. finish flow: detach -> sleep-wait -> done. The row must fold the
// result (never the "still running" placeholder) with the full duration.
async function scenarioFinish(ctx: any) {
  log("test", "scenario A: finish flow");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e bg finish", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Run `sleep 15 && echo done-gamma` with the bash tool. Wait for it with the sleep tool (NOT a bare sleep command), then reply exactly DONE-GAMMA plus the echo text.",
  }));
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(3000);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const txt = JSON.stringify(data?.session?.messages || []);
    if (txt.includes("DONE-GAMMA") && data?.session?.status !== "running") break;
    assert(Date.now() - t0 < 240000, "turn timed out");
  }
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    const rows: any[] = await page.evaluate(() => [...document.querySelectorAll("[data-toolseg]")].map((s) => ({
      text: (s.textContent || ""),
      pres: [...s.querySelectorAll("pre")].map((el) => (el.textContent || "")),
      duration: s.querySelector("[data-tool-duration]")?.textContent || null,
    })));
    const bash = rows.find((r) => /sleep 15/.test(r.text));
    assert(bash, `bash row missing (rows: ${rows.map((r) => r.text.slice(0, 60)).join(" // ")})`);
    assert(!/still running/i.test(bash.pres.join("\n")), `row body kept the placeholder: ${bash.pres.join("|").slice(0, 200)}`);
    assert(/done-gamma/.test(bash.pres.join("\n")), `row body missing the result: ${bash.pres.join("|").slice(0, 200)}`);
    const secs = bash.duration ? Number(/(\d+)s/.exec(bash.duration)?.[1]) : NaN;
    assert(Number.isFinite(secs) && secs >= 14, `row must show the full ~15s duration, got ${bash.duration}`);
    assertNoPageErrors(pageErrors, consoleErrors, "finish flow");
    log("test", `scenario A PASS (duration ${bash.duration})`);
  } finally {
    await browser.close();
  }
}

// B. manual cancel: while a job runs, the dashboard Stop button is
// clicked. The AI must get a cancellation notice, the .log must record
// who stopped it, and the row must fold a truthful marker.
async function scenarioCancel(ctx: any) {
  log("test", "scenario B: manual cancel");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e bg cancel", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Run `sleep 60 && echo done-never` with the bash tool. Then wait with the sleep tool (90 seconds) and report what happened.",
  }));
  let jobId = "", logPath = "";
  {
    const t0 = Date.now();
    while (!jobId && Date.now() - t0 < 90000) {
      await Bun.sleep(2000);
      const jobs = await ctx.bgSnapshot();
      const j = jobs.find((x: any) => x.sessionId === sessionId && x.status === "running");
      if (j) { jobId = j.id; logPath = j.logPath; }
    }
  }
  assert(jobId, "job never detached");
  log("test", `detached ${jobId}`);
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    const stop = page.locator("[data-bg-stop]");
    assert.equal(await stop.count(), 1, "expected exactly one Stop button while the job runs");
    await stop.first().click();
    await page.waitForTimeout(8000);
    // Wire-side: the cancellation notice reached the AI's context…
    let noticed = false;
    {
      const t0 = Date.now();
      while (!noticed && Date.now() - t0 < 60000) {
        await Bun.sleep(2500);
        const data: any = await ctx.send({ type: "get_session", sessionId });
        if (JSON.stringify(data?.session?.messages || []).includes("cancelled by the user")) noticed = true;
      }
    }
    assert(noticed, "AI never got the cancellation notice");
    // …the snapshot carries the cancelled state…
    const jobs = await ctx.bgSnapshot();
    const job = jobs.find((x: any) => x.id === jobId);
    assert.equal(job?.status, "cancelled", `job status: ${job?.status}`);
    assert.match(job?.result || "", /cancelled by user/, "snapshot result must name the cancellation");
    // …and the .log records who stopped it.
    const logTail = await fs.readFile(logPath, "utf8").then((t) => t.slice(-200)).catch((e) => `(read fail: ${e})`);
    assert.match(logTail, /\[cancelled by user\]/, `.log tail: ${JSON.stringify(logTail)}`);
    // The folded row reads truthfully.
    await page.evaluate(() => {
      for (const h of [...document.querySelectorAll("[data-toolseg] div.group\\/tool")]) {
        try { (h as HTMLElement).click(); } catch {}
      }
    });
    await page.waitForTimeout(1500);
    const rows: any[] = await page.evaluate(() => [...document.querySelectorAll("[data-toolseg]")].map((s) => ({
      text: (s.textContent || ""),
      pres: [...s.querySelectorAll("pre")].map((el) => (el.textContent || "")),
    })));
    const bash = rows.find((r) => /sleep 60/.test(r.text));
    assert(bash, "bash row missing after cancel");
    assert.match(bash.pres.join("\n"), /cancelled by user/, `row body: ${bash.pres.join("|").slice(0, 200)}`);
    assertNoPageErrors(pageErrors, consoleErrors, "manual cancel");
    log("test", "scenario B PASS");
  } finally {
    await browser.close();
  }
}

const only = (process.argv[2] || "").toLowerCase();
try {
  const ctx = await boot();
  if (!only || only === "finish" || only === "a") await scenarioFinish(ctx);
  if (!only || only === "cancel" || only === "b") await scenarioCancel(ctx);
  console.log("\n=== RESULT ===\nPASS: indirect background E2E complete");
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) {
    try { p.kill(); } catch {}
  }
}
