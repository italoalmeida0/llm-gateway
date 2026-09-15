/**
 * scripts/test-indirect-compaction-e2e.ts — full-stack compaction check with a
 * REAL browser + REAL gateway + REAL Go daemon + REAL Meta provider
 * (Anthropic-native, no translation involved).
 *
 *   META_API_KEY=... PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... \
 *     bun scripts/test-indirect-compaction-e2e.ts [manual|auto|chain|overflow|all]
 *
 * The gateway registry model gets a SMALL context_length so ShouldCompact
 * fires after a couple of turns (no need to burn a real 200k window).
 * Asserts what a user actually sees on #/code per trigger:
 *
 *   manual   — /compact command: session_compacted arrives, the dedicated
 *     balloon renders the summary, NO duplicate ## Context Summary user
 *     bubble (the <system-reminder> wrap hides it), zero page errors.
 *   auto     — auto_compact_threshold=70 + small window: heavy book-reading
 *     turns proactively compact (session_compacted without /compact),
 *     balloon shows, no duplicate bubble, zero page errors.
 *   chain    — second compaction on top of the first: count=2, previous
 *     summary chains, balloon shows latest, zero page errors.
 *   overflow — reactive path: the admin e2e-overflow hook (E2E_FORCE_OVERFLOW=1
 *     only, absent in production) forces one provider-style 400
 *     context-overflow mid-turn; the daemon compacts and retries cleanly,
 *     the turn completes, balloon shows, no duplicate bubble.
 *
 * Split-turn (cut landing mid-turn, "Turn Context (split turn)" merged
 * summary) is covered implicitly — scenarios auto/overflow already produced
 * Split Turn balloons — plus the Go unit TestCompactSplitTurn. A giant
 * single message is impractical e2e (a real 1M-window provider absorbs it
 * and the turn dies on timeouts before any registry-window cut).
 *
 * Prerequisites: web dist/ built, daemon binary built.
 * Slow on purpose (real model latency); manual gate, not part of `bun test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.dirname(new URL(import.meta.url).pathname);
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
  console.error("daemon binary missing: build it in indirect-code-daemon/");
  process.exit(2);
}
if (!(await fs.stat(path.join(WS, "dist", "index.html")).catch(() => null))) {
  console.error("web dist/ missing: run bun run build:web first");
  process.exit(2);
}
async function resolveChrome(): Promise<string> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  for (const d of ["chromium-1234", "chromium-1228"]) {
    for (const c of [`${cache}/${d}/chrome-linux64/chrome`, `${cache}/${d}/chrome-linux/chrome`]) {
      if (await fs.stat(c).catch(() => null)) return c;
    }
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  console.error("no Chrome found: set CHROMIUM_PATH");
  process.exit(2);
}

// Small window: reserve is 16384 + keep-recent 20000, so the window must
// exceed ~40k for ShouldCompact math to make sense. 48k keeps real-model
// cost low while compacting after a few tool-heavy turns.
const SMALL_WINDOW = Number(process.env.E2E_COMPACT_WINDOW || 48000);
const GW_PORT = Number(process.env.E2E_GW_PORT || 4611);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-compact-pass-1";
const procs: Array<{ kill: () => void }> = [];
function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

async function boot() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-cmp-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW, E2E_FORCE_OVERFLOW: "1",
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
  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-cmp-d-"));
  mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
  const workDir = path.join(daemonDir, "workspace");
  const daemonProc = Bun.spawn(
    [daemonBin, "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Compact E2E"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);
  // Meta provider (Anthropic-native) + registry model with a small window.
  const _prov: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "meta-e2e", openaiBaseUrl: META_BASE, apiKey: META_KEY, openaiAuthStyle: "bearer" }),
  })).json();
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const created = (list.providers || []).find((p: any) => p.name === "meta-e2e");
  const providerId = created?.id;
  assert(providerId, `provider not found after create: ${JSON.stringify(list).slice(0, 300)}`);
  let mkModel: any = await (await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: SMALL_WINDOW }),
  })).json();
  if (!mkModel.success && /already registered/.test(mkModel.error || "")) {
    // Auto-import already registered it: shrink its window via PATCH.
    mkModel = await (await fetch(`${GW}/api/admin/models/${encodeURIComponent(MODEL)}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ providerId, upstreamModel: MODEL, contextLength: SMALL_WINDOW }),
    })).json();
  }
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);
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
  const events: any[] = [];
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
      events.push(msg);
    } catch {}
  };
  {
    const start = Date.now();
    while (!hostId && Date.now() - start < 20000) {
      const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
      const f = (h.hosts || []).find((x: any) => x.name === "Compact E2E" && x.status === "online");
      if (f) hostId = f.id;
      else await Bun.sleep(300);
    }
  }
  assert(hostId, "daemon host never came online");
  log("boot", `gateway + daemon up (host ${hostId}, window ${SMALL_WINDOW})`);
  return { jwt, login, hostId, ws, send, workDir, events, gw: GW, auth };
}

async function openSessionPage(ctx: any, sessionId: string, shot: string) {
  const browser = await chromium.launch({ executablePath: await resolveChrome(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
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
  await page.screenshot({ path: shot, fullPage: false });
  return { browser, page, pageErrors, consoleErrors };
}

function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `${where}: console errors: ${consoleErrors.join(" | ")}`);
}

async function waitForIdle(ctx: any, sessionId: string, timeoutMs = 300000) {
  const t0 = Date.now();
  let lastStatus = "";
  for (;;) {
    await Bun.sleep(3000);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const st = data?.session?.status;
    if (st !== lastStatus) { lastStatus = st; log("turn", `status=${st} after ${Math.round((Date.now() - t0) / 1000)}s`); }
    if (st !== "running") return data;
    if (Date.now() - t0 >= timeoutMs) {
      const tail = ctx.events.slice(-15).map((e: any) => JSON.stringify(e).slice(0, 200));
      log("turn", `TIMEOUT event tail:\n${tail.join("\n")}`);
      assert(false, "turn timed out");
    }
  }
}

async function waitForCompaction(ctx: any, sessionId: string, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(2500);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    if (data?.session?.compaction?.previousSummary) return data;
    assert(Date.now() - t0 < timeoutMs, "compaction never landed");
  }
}

/** Seed a tool-heavy history so ShouldCompact has something to chew on. */
async function seedHistory(ctx: any, sessionId: string, turns = 3) {
  for (let i = 0; i < turns; i++) {
    ctx.ws.send(JSON.stringify({
      type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
      text: `Run these bash commands one by one and report: echo seed-${i}-alpha && echo seed-${i}-beta && ls ${ctx.workDir}. Then reply SEED-${i}-DONE.`,
    }));
    const data = await waitForIdle(ctx, sessionId);
    assert(JSON.stringify(data?.session?.messages || []).includes(`SEED-${i}-DONE`), `seed turn ${i} failed`);
    log("seed", `turn ${i} done`);
  }
}

/** Heavy seed: read real books (test/books corpus, ~1.1M tokens) into
 * context. One Moby-Dick read (~270k input tokens) overflows a small
 * test window by itself — exercising proactive AND reactive paths. */
const BOOKS = [
  "Mary-Wollstonecraft-Shelley-Frankenstein.md", // ~92k
  "Oscar-Wilde-The-Picture-of-Dorian-Gray.md", // ~100k
  "Jane-Austen-Emma.md", // ~205k
  "Bram-Stoker-Dracula.md", // ~197k
  "Fyodor-Dostoyevsky-Crime-and-Punishment.md", // ~262k
  "Herman-Melville-Moby-Dick.md", // ~270k
];
async function seedHeavyHistory(ctx: any, sessionId: string, turns = 3) {
  const { copyFileSync } = await import("fs");
  for (let i = 0; i < turns; i++) {
    const book = BOOKS[i % BOOKS.length];
    copyFileSync(`/home/user/workspace/llm-gateway/test/books/${book}`, `${ctx.workDir}/${book}`);
    ctx.ws.send(JSON.stringify({
      type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
      text: `Read the file ${book} fully with the read tool, then write a detailed chapter-by-chapter summary (be thorough, quote key passages). End your reply with HEAVY-${i}-DONE.`,
    }));
    const data = await waitForIdle(ctx, sessionId, 600000);
    assert(JSON.stringify(data?.session?.messages || []).includes(`HEAVY-${i}-DONE`), `heavy seed turn ${i} failed`);
    const usage = data?.session?.usage;
    log("seed", `heavy turn ${i} (${book}) done (in=${usage?.inTok ?? usage?.input_tokens} out=${usage?.outTok ?? usage?.output_tokens})`);
  }
}

async function checkBalloonState(ctx: any, sessionId: string, shot: string, where: string) {
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId, shot);
  try {
    // The balloon anchors above the first kept block (likely above the
    // fold): scroll the chat container to top so it mounts in the window.
    await page.evaluate(() => {
      const els = [...document.querySelectorAll("*")];
      for (const el of els) {
        const h = el as HTMLElement;
        if (h.scrollHeight > h.clientHeight + 200 && /overflow|auto|scroll/i.test(getComputedStyle(h).overflowY)) {
          h.scrollTop = 0;
        }
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const body = document.body.innerHTML || "";
      const text = document.body.textContent || "";
      // Dedicated balloon: "Context Compacted" header + Expand control.
      const balloonHit = /Context Compacted/.test(text);
      return {
        balloonVisible: balloonHit,
        balloonText: balloonHit ? text.slice(text.indexOf("Context Compacted"), text.indexOf("Context Compacted") + 300) : "",
        // The leak: raw "## Context Summary (compacted)" header rendered
        // as message text (the balloon strips it; a user bubble would not).
        hasSummaryBubble: /## Context Summary \(compacted\)/.test(text),
        hasSystemTagLeak: /&lt;system-reminder&gt;|<system-reminder>/.test(body),
      };
    });
    // Screenshot the balloon itself for visual confirmation.
    const balloonEl = page.locator("text=Context Compacted").first();
    if (await balloonEl.count()) {
      await balloonEl.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: shot, fullPage: false });
    log(where, `balloon=${state.balloonVisible} summaryBubble=${state.hasSummaryBubble} tagLeak=${state.hasSystemTagLeak}`);
    log(where, `balloon: ${state.balloonText.slice(0, 160)}`);
    assert(state.balloonVisible, `${where}: dedicated compaction balloon must render`);
    assert(!state.hasSummaryBubble, `${where}: duplicate ## Context Summary user bubble must NOT render`);
    assert(!state.hasSystemTagLeak, `${where}: raw <system-reminder> tags must not leak into the DOM`);
    assertNoPageErrors(pageErrors, consoleErrors, where);
    return state;
  } finally {
    await browser.close();
  }
}

// A. manual /compact
async function scenarioManual(ctx: any) {
  log("test", "scenario A: manual /compact");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e compact manual", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await seedHistory(ctx, sessionId, 3);
  ctx.events.length = 0;
  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const data = await waitForCompaction(ctx, sessionId);
  const comp = data?.session?.compaction;
  assert(comp?.previousSummary?.length > 50, "previousSummary missing/short");
  assert.equal(comp?.count, 1, `count should be 1, got ${comp?.count}`);
  log("test", `compacted: count=${comp.count} keepFrom=${comp.keepFrom} summary=${comp.previousSummary.slice(0, 100)}…`);
  await checkBalloonState(ctx, sessionId, "/tmp/cmp-manual.png", "manual");
  // The turn keeps working after compaction.
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Reply exactly POST-COMPACT-OK.",
  }));
  const after = await waitForIdle(ctx, sessionId);
  assert(JSON.stringify(after?.session?.messages || []).includes("POST-COMPACT-OK"), "post-compact turn failed");
  log("test", "scenario A PASS");
}

// B. proactive auto-compact via low threshold
async function scenarioAuto(ctx: any) {
  log("test", "scenario B: proactive auto-compact");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e compact auto", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  // Threshold 70: with the small window the daemon's own heuristic
  // (usage*100 >= threshold*window) fires once heavy turns fill it.
  await ctx.send({ type: "config", settings: { auto_compact_threshold: 70 } });
  await seedHeavyHistory(ctx, sessionId, 5);
  const data = await waitForCompaction(ctx, sessionId, 240000);
  const comp = data?.session?.compaction;
  assert(comp?.previousSummary, "auto compaction never fired");
  log("test", `auto-compacted: count=${comp.count} keepFrom=${comp.keepFrom}`);
  await checkBalloonState(ctx, sessionId, "/tmp/cmp-auto.png", "auto");
  log("test", "scenario B PASS");
}

// C. chain: second compaction on top of the first
async function scenarioChain(ctx: any) {
  log("test", "scenario C: compaction chain");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e compact chain", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await seedHistory(ctx, sessionId, 3);
  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const first = await waitForCompaction(ctx, sessionId);
  const firstSummary = first?.session?.compaction?.previousSummary || "";
  assert(firstSummary.length > 50, "first compaction failed");
  log("test", `first: count=${first?.session?.compaction?.count}`);
  await seedHistory(ctx, sessionId, 3);
  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(2500);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const comp = data?.session?.compaction;
    if (comp?.count >= 2) {
      assert.equal(comp.count, 2, `count should be 2, got ${comp.count}`);
      assert(comp?.previousSummary?.length > 50, "chained summary missing");
      log("test", `chained: count=2 summary=${comp.previousSummary.slice(0, 100)}…`);
      break;
    }
    assert(Date.now() - t0 < 180000, "second compaction never landed");
  }
  await checkBalloonState(ctx, sessionId, "/tmp/cmp-chain.png", "chain");
  log("test", "scenario C PASS");
}

// D. split-turn: covered implicitly — when keepFrom lands mid-turn the
// summary merges history + turn prefix ("Turn Context (split turn)" marker
// and the balloon shows the Split Turn badge). Scenarios B/E already
// produced Split Turn balloons; assert the marker path via unit tests in
// indirect-code-daemon/packages/core (compaction_test.go) rather than a
// giant single message (impractical: a real 1M-window provider absorbs it
// and the turn dies on timeouts before any cut).

// E. reactive overflow: gateway returns a forced 400 context-overflow
// (armed via admin hook — the real 1M Meta window would never fire).
// The daemon must compact mid-turn and retry cleanly; the user sees the
// turn complete plus the dedicated balloon, no duplicate bubble.
async function scenarioOverflow(ctx: any) {
  log("test", "scenario E: reactive overflow");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e compact overflow", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  // Heavy seed: the reactive Compact(keepTail=0) refuses transcripts
  // that fit under the keep floor, so the history must be worth cutting.
  await seedHeavyHistory(ctx, sessionId, 2);
  const arm: any = await (await fetch(`${ctx.gw}/api/admin/e2e-overflow`, {
    method: "POST", headers: ctx.auth, body: JSON.stringify({ armed: true }),
  })).json();
  assert(arm.success && arm.armed, `overflow hook not armed: ${JSON.stringify(arm)}`);
  const check: any = await (await fetch(`${ctx.gw}/api/admin/e2e-overflow`, { headers: ctx.auth })).json();
  log("test", `hook armed check: ${JSON.stringify(check)}`);
  assert(check.success && check.armed, "hook did not stay armed");
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL,
    text: "Reply exactly OVERFLOW-RECOVERED.",
  }));
  const data = await waitForIdle(ctx, sessionId, 900000);
  const msgs = JSON.stringify(data?.session?.messages || []);
  assert(msgs.includes("OVERFLOW-RECOVERED"), "turn did not recover after forced overflow");
  // Did the daemon even see the forced 400? The reactive path emits a
  // "Context limit reached upstream" progress notice before compacting.
  const sawNotice = ctx.events.some((e: any) => JSON.stringify(e).includes("Context limit reached upstream"));
  log("test", `daemon saw forced overflow: ${sawNotice}`);
  assert(sawNotice, "daemon never reacted to the forced 400 (hook may have fired on the wrong request)");
  const comp = data?.session?.compaction;
  assert(comp?.previousSummary?.length > 50, "reactive compaction missing");
  log("test", `recovered: count=${comp.count} keepFrom=${comp.keepFrom}`);
  await checkBalloonState(ctx, sessionId, "/tmp/cmp-overflow.png", "overflow");
  log("test", "scenario E PASS");
}

const only = (process.argv[2] || "").toLowerCase();
try {
  const ctx = await boot();
  if (!only || only === "manual" || only === "a") await scenarioManual(ctx);
  if (!only || only === "auto" || only === "b") await scenarioAuto(ctx);
  if (!only || only === "chain" || only === "c") await scenarioChain(ctx);
  if (!only || only === "overflow" || only === "e") await scenarioOverflow(ctx);
  console.log("\n=== RESULT ===\nPASS: indirect compaction E2E complete");
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) {
    try { p.kill(); } catch {}
  }
}
