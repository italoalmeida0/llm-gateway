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
const META_KEY = envGet("META_API_KEY") || envGet("META_TEST_KEY");
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
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
    } catch {}
  };
  // Session-owned tasks: the source of truth is session_data bgTasks
  // (bg_list/bg_update no longer exist).
  const bgSnapshot = async (sessionId: string) => {
    const data: any = await send({ type: "get_session", sessionId });
    return ((data?.session as any)?.bgTasks || []) as any[];
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

// Google GSI (auth widget) trips a CSP console error on every page load —
// environment noise unrelated to bg tasks. Fail only on new errors.
const KNOWN_CONSOLE_NOISE = [/Content Security Policy.*accounts\.google\.com/i, /gsi\/client/i];
function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  const fresh = consoleErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(fresh, [], `${where}: console errors: ${fresh.join(" | ")}`);
}

// A. finish flow: detach -> sleep(waitingFor+summary) -> bg_check read.
// The tool row keeps the detach placeholder; the output lives in the
// session BgTask (bg card + bg_check), with full runner logs retained on disk.
async function scenarioFinish(ctx: any) {
  log("test", "scenario A: finish flow");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e bg finish", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Run `sleep 15 && echo done-gamma` with the bash tool. It will go to the background after 10s. Then use the sleep tool with waitingFor=<the bg task id> and a short summary to wait, then read the output with bg_check (job_id <id>), then reply exactly DONE-GAMMA plus the echo text.",
  }));
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(3000);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const txt = JSON.stringify(data?.session?.messages || []);
    if (txt.includes("DONE-GAMMA") && data?.session?.status !== "running") break;
    assert(Date.now() - t0 < 300000, "turn timed out");
  }
  // Wire-side: the session owns the finished task with its output.
  const tasks = await ctx.bgSnapshot(sessionId);
  const task = tasks.find((x: any) => x.status === "done" || x.status === "error");
  assert(task, `no finished bg task in session (tasks: ${JSON.stringify(tasks.map((t: any) => ({ id: t.id, status: t.status })))} )`);
  assert((task.content || "").includes("done-gamma"), `session task content missing output: ${(task.content || "").slice(-200)}`);
  assert(Number(task.totalLines || 0) > 0, "task must report totalLines");
  // Runner paths remain internal; the session exposes its display tail.
  assert(!task.logPath, "session must not expose runner log paths");
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    const rows: any[] = await page.evaluate(() => [...document.querySelectorAll("[data-toolseg]")].map((s) => ({
      text: (s.textContent || ""),
      pres: [...s.querySelectorAll("pre")].map((el) => (el.textContent || "")),
    })));
    const bash = rows.find((r) => /sleep 15/.test(r.text));
    assert(bash, `bash row missing (rows: ${rows.map((r) => r.text.slice(0, 60)).join(" // ")})`);
    // The tool row keeps the detach placeholder (no fold: results live in the card).
    assert(/background/i.test(bash.text), `row must keep the detach placeholder: ${bash.text.slice(0, 200)}`);
    // Finished tasks move out of the running list but retain their logs.
    const card: string = await page.evaluate(() => document.body.textContent || "");
    assert(/Background tasks/.test(card), "bg card missing");
    const archive = page.locator("[data-bg-archive-toggle]");
    assert.equal(await archive.count(), 1, "archive toggle missing after finish");
    assert.equal(await page.locator(`[data-bg-row="${task.id}"]`).count(), 0, "finished task remained in running view");
    await archive.click();
    const archivedRow = page.locator(`[data-bg-row="${task.id}"]`);
    assert.equal(await archivedRow.locator('[data-bg-status][aria-label="Completed"]').count(), 1, "finished task status icon missing");
    assert.match(await archivedRow.locator("[data-bg-duration]").textContent() || "", /\d+[smh]/, "finished task duration missing");
    await archivedRow.getByRole("button", { name: "Logs", exact: true }).click();
    assert.match(await archivedRow.locator("pre").textContent() || "", /done-gamma/, "archived task output missing");
    assertNoPageErrors(pageErrors, consoleErrors, "finish flow");
    log("test", "scenario A PASS");
  } finally {
    await browser.close();
  }
}

// B. manual cancel: while a job runs, the dashboard Stop button is
// clicked. The AI must get a cancellation notice pointing at bg_check,
// the session task goes cancelled, and the row keeps the placeholder.
async function scenarioCancel(ctx: any) {
  log("test", "scenario B: manual cancel");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e bg cancel", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Run `sleep 60 && echo done-never` with the bash tool. It will go to the background after 10s. Then use the sleep tool with waitingFor=<the bg task id> and a short summary to wait 90 seconds, then report what happened.",
  }));
  let jobId = "";
  {
    const t0 = Date.now();
    while (!jobId && Date.now() - t0 < 90000) {
      await Bun.sleep(2000);
      const tasks = await ctx.bgSnapshot(sessionId);
      const j = tasks.find((x: any) => x.status === "running");
      if (j) jobId = j.id;
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
        const txt = JSON.stringify(data?.session?.messages || []);
        if (txt.includes("cancelled by the user") && txt.includes("bg_check")) noticed = true;
      }
    }
    assert(noticed, "AI never got the cancellation notice pointing at bg_check");
    // …the session task carries the cancelled state…
    const tasks = await ctx.bgSnapshot(sessionId);
    const job = tasks.find((x: any) => x.id === jobId);
    assert.equal(job?.status, "cancelled", `job status: ${job?.status}`);
    const archive = page.locator("[data-bg-archive-toggle]");
    assert.equal(await archive.count(), 1, "archive toggle missing after cancel");
    await page.waitForFunction((id) => !document.querySelector(`[data-bg-row="${id}"]`), jobId);
    await archive.click();
    const archivedRow = page.locator(`[data-bg-row="${jobId}"]`);
    assert.equal(await archivedRow.locator('[data-bg-status][aria-label="Cancelled"]').count(), 1, "cancelled task status icon missing");
    assert.match(await archivedRow.locator("[data-bg-duration]").textContent() || "", /\d+[smh]/, "cancelled task duration missing");
    // The row keeps the placeholder (no fold).
    const rows: any[] = await page.evaluate(() => [...document.querySelectorAll("[data-toolseg]")].map((s) => ({
      text: (s.textContent || ""),
    })));
    const bash = rows.find((r) => /sleep 60/.test(r.text));
    assert(bash, "bash row missing after cancel");
    assert(/background/i.test(bash.text), `row must keep the placeholder: ${bash.text.slice(0, 200)}`);
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
