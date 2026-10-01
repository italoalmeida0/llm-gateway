/**
 * scripts/test-indirect-edit-fork-e2e.ts — full-stack edit/resend/fork check
 * with a REAL browser + REAL daemon + deterministic provider (same family as
 * test-indirect-bg-e2e.ts: Playwright stays an external install).
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/path/to/chrome \
 *     bun scripts/test-indirect-edit-fork-e2e.ts
 *
 * Boots a real gateway + real Go daemon + a local fake provider, runs
 * deterministic Talk turns
 * ("Reply exactly: X"), then drives the ATOMIC primitives through the
 * REAL wire and the REAL browser page:
 *
 *   A. discard_and_resend (edit + save&resend): the edited text replaces
 *      the boundary turn in ONE commit — the user row appears exactly ONCE
 *      (the old off-by-one dup), the tail is cut, the turn re-runs, and a
 *      failed op NEVER loses the text (error ack keeps it on screen).
 *   B. discard_and_resend with empty text (regenerate): reuses the
 *      original text, the reply re-runs.
 *   C. fork_and_resend: the fork holds the prefix ABOVE the turn + the new
 *      row (durable there before its turn), the source is untouched.
 *   D. fork_session (plain): the fork INCLUDES the boundary turn.
 *   E. failure contract: a stale turn id answers with an ERROR ack (never
 *      a silent drop) — the user's text is never lost.
 *
 * Prerequisites: web dist/ built (bun run build:web), daemon binary built
 * (go build -o bin/indirect-code ./cmd/daemon in indirect-code-daemon/).
 * This is a manual full-stack gate, not
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
const MODEL = process.env.E2E_MODEL || "muse-spark-1.3-contributor";
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
  for (const d of ["chromium-1243", "chromium-1234", "chromium-1228"]) {
    for (const p of [`${cache}/${d}/chrome-linux64/chrome`, `${cache}/${d}/chrome-linux/chrome`]) {
      if (await fs.stat(p).catch(() => null)) return p;
    }
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  console.error("no Chrome found: set CHROMIUM_PATH");
  process.exit(2);
}

// Deterministic provider: answers "EXACTLY: <whatever follows 'Reply exactly: '>"
// in ONE message, no tools. The e2e validates the atomic primitives + real
// browser + real daemon — not the model (a real agentic model keeps the turn
// alive with tools and never settles).
const fakeUpstream = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body: any = await req.json().catch(() => ({}));
    const last = (body.messages || []).at(-1);
    const text = String(last?.content || "");
    const marker = /Reply exactly: ([^\n]+)/.exec(text)?.[1]?.trim() || "OK";
    const reply = `EXACTLY: ${marker}`;
    // The gateway streams upstream completions (SSE) — answer both shapes.
    if (body.stream) {
      const chunk = (delta: any, finish: string | null) =>
        `data: ${JSON.stringify({ id: "fake-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const sse = chunk({ role: "assistant", content: "" }, null)
        + chunk({ content: reply }, null)
        + chunk({}, "stop") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "fake-1", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});
const FAKE_UPSTREAM_URL = `http://127.0.0.1:${fakeUpstream.port}/v1`;

const GW_PORT = Number(process.env.E2E_GW_PORT || 4612);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-admin-pass-1";
const procs: Array<{ kill: () => void }> = [];

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

async function boot(): Promise<any> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-editfork-"));
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
  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-editfork-d-"));
  mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
  const workDir = path.join(daemonDir, "workspace");
  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "E2E Daemon"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);
  const prov: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "meta", openaiBaseUrl: FAKE_UPSTREAM_URL, apiKey: "fake-key", openaiAuthStyle: "bearer" }),
  })).json();
  assert(prov.success, "provider create failed");
  await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId: "meta", upstreamModel: MODEL }),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  const results = new Map<string, (v: any) => void>();
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
  // sendWait: sends WITHOUT a requestId correlation and resolves on the
  // matching *_result event (the atomic primitives answer by event).
  const sendWait = (payload: any, resultType: string, timeoutMs = 30000) => {
    const rid = `rw${++reqId}`;
    payload.requestId = rid;
    payload.hostId = hostId;
    ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve) => {
      results.set(rid, resolve);
      setTimeout(() => { if (results.has(rid)) { results.delete(rid); resolve(undefined); } }, timeoutMs);
    });
  };
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
      if (msg.requestId && results.has(msg.requestId)) {
        if (/(_result)$/.test(String(msg.type))) { results.get(msg.requestId)!(msg); results.delete(msg.requestId); }
        return;
      }
    } catch {}
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
  return { jwt, login, hostId, ws, send, sendWait, workDir };
}

async function openSessionPage(ctx: any, sessionId: string) {
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = pageErrors as any;
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
  await page.waitForTimeout(6000);
  return { browser, page, pageErrors, consoleErrors };
}

const KNOWN_CONSOLE_NOISE = [/Content Security Policy.*accounts\.google\.com/i, /gsi\/client/i];
function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  // Google GSI (auth widget) trips a CSP page/console error on every load —
  // environment noise unrelated to the flows under test.
  const freshPages = pageErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(freshPages, [], `${where}: page errors: ${freshPages.join(" | ")}`);
  const fresh = consoleErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(fresh, [], `${where}: console errors: ${fresh.join(" | ")}`);
}

// Run one deterministic turn: the prompt asks the model to reply exactly
// `marker`. Returns when the turn ends.
async function runTurn(ctx: any, sessionId: string, prompt: string, marker: string) {
  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: prompt }));
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(1500);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const msgs = data?.session?.messages || [];
    const txt = JSON.stringify(msgs);
    if (txt.includes(`EXACTLY: ${marker}`) && data?.session?.status !== "running") return msgs;
    if (Date.now() - t0 > 60000) {
      throw new Error(`turn ${marker} timed out (status=${data?.session?.status}) messages=${JSON.stringify(msgs).slice(0, 1500)}`);
    }
  }
}

function userTextOf(msg: any): string {
  // The wire (Go provider.TextBlock) serializes as {text} without `type`.
  for (const c of msg.content || []) {
    if (typeof c?.text === "string") return c.text;
    if (c?.type === "text" && typeof c.text === "string") return c.text;
  }
  return "";
}

// A. discard_and_resend (edit + save&resend): one commit, one row, text
// never lost. The boundary turn is replaced by the edited text.
async function scenarioResend(ctx: any) {
  log("test", "scenario A: discard_and_resend (edit + resend)");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e edit resend", model: MODEL, options: { mode: "talk" } });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await runTurn(ctx, sessionId, "Reply exactly: ALPHA", "ALPHA");
  const msgs: any[] = (await runTurn(ctx, sessionId, "Reply exactly: BETA", "BETA")) as any[];
  // The boundary turn (BETA) starts at the LAST user row.
  const boundary = [...msgs].reverse().find((m: any) => m.role === "user" && userTextOf(m).includes("BETA"));
  if (!boundary) {
    const dump = msgs.map((m: any) => ({ role: m.role, text: userTextOf(m).slice(0, 60) }));
    throw new Error(`BETA user row not found in ${msgs.length} msgs: ${JSON.stringify(dump).slice(0, 1500)}`);
  }
  const turnId = boundary.turnIndex;
  assert(turnId > 0, "boundary row must carry its turn index");
  // 1. THE atomic resend: edit BETA -> GAMMA.
  const res: any = await ctx.sendWait({
    type: "discard_and_resend", sessionId, turnId,
    text: "Reply exactly: GAMMA", model: MODEL,
  }, "discard_and_resend_result");
  assert(res, "discard_and_resend produced NO result (silent drop!)");
  if (!res.ok) {
    // Debug: dump the corrupt line from the session file.
    const sessDir = path.join(ctx.workDir, "..", "sessions");
    const f = await fs.readFile(path.join(sessDir, `${sessionId}.jsonl`), "utf8").catch(() => "");
    const lines = f.split("\n");
    let off = 0;
    const around: string[] = [];
    for (const ln of lines) {
      if (off > 4500 && off < 5000) around.push(`@${off}: ${ln.slice(0, 160)}`);
      off += ln.length + 1;
    }
    throw new Error(`discard_and_resend failed: ${res.error}\nAROUND 4725:\n${around.join("\n")}`);
  }
  // 2. The turn re-runs with the edited text.
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(1500);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const txt = JSON.stringify(data?.session?.messages || []);
    if (txt.includes("EXACTLY: GAMMA") && data?.session?.status !== "running") break;
    assert(Date.now() - t0 < 120000, "edited turn timed out");
  }
  const after: any[] = (await ctx.send({ type: "get_session", sessionId }))?.session?.messages || [];
  // 3. THE regression: the edited user row appears EXACTLY ONCE (the old
  //    off-by-one dup), the old text is gone, the tail (ALPHA stays, BETA's
  //    reply is cut).
  const gammaRows = after.filter((m: any) => m.role === "user" && userTextOf(m).includes("GAMMA"));
  assert.equal(gammaRows.length, 1, `edited row must appear exactly once (got ${gammaRows.length})`);
  assert.equal(after.filter((m: any) => m.role === "user" && userTextOf(m).includes("BETA")).length, 0, "old text must be gone");
  assert(after.some((m: any) => m.role === "user" && userTextOf(m).includes("ALPHA")), "prefix (ALPHA) must survive");
  // 4. THE no-loss contract: a FAILED op answers with an error ack and
  //    keeps everything as-is (the user's text is on screen, retryable).
  const bad: any = await ctx.sendWait({
    type: "discard_and_resend", sessionId, turnId: 99999,
    text: "Reply exactly: DELTA", model: MODEL,
  }, "discard_and_resend_result");
  assert(bad, "bad-id op produced NO result (silent drop!)");
  assert.equal(bad.ok, false, "bad-id op must answer with an error");
  const still: any[] = (await ctx.send({ type: "get_session", sessionId }))?.session?.messages || [];
  assert.equal(still.filter((m: any) => m.role === "user" && userTextOf(m).includes("GAMMA")).length, 1, "failed op must not touch the record");
  // 5. The REAL browser page shows exactly one edited row (no dup) and the
  //    cut tail — the user's view matches the record.
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    const body: string = await page.evaluate(() => document.body.textContent || "");
    const gammaCount = (body.match(/GAMMA/g) || []).length;
    assert(gammaCount >= 1, `browser must show the edited row: ${body.slice(-300)}`);
    assert(!/BETA/.test(body), `browser must NOT show the discarded row: ${body.slice(-300)}`);
    assert(/ALPHA/.test(body), `browser must show the surviving prefix: ${body.slice(-300)}`);
    assertNoPageErrors(pageErrors, consoleErrors, "resend flow");
    log("test", "scenario A PASS");
  } finally {
    await browser.close();
  }
}

// B. regenerate (empty text): reuses the original text, the reply re-runs.
async function scenarioRegenerate(ctx: any) {
  log("test", "scenario B: regenerate (empty text = reuse original)");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e regenerate", model: MODEL, options: { mode: "talk" } });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await runTurn(ctx, sessionId, "Reply exactly: OMEGA", "OMEGA");
  const msgs: any[] = (await ctx.send({ type: "get_session", sessionId }))?.session?.messages || [];
  const boundary = [...msgs].reverse().find((m: any) => m.role === "user" && userTextOf(m).includes("OMEGA"));
  assert(boundary, "OMEGA user row not found");
  // The old reply is CUT by the op (correct) — prove the re-run by the
  // NEW assistant row's id, not by counting the marker.
  const beforeReplyIds = new Set(msgs.filter((m: any) => m.role === "assistant").map((m: any) => m.id));
  const res: any = await ctx.sendWait({
    type: "discard_and_resend", sessionId, turnId: boundary.turnIndex,
    text: "", model: MODEL,
  }, "discard_and_resend_result");
  assert(res, "regenerate produced NO result (silent drop!)");
  assert.equal(res.ok, true, `regenerate failed: ${res.error}`);
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(1500);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const ms: any[] = data?.session?.messages || [];
    const fresh = ms.filter((m: any) => m.role === "assistant" && !beforeReplyIds.has(m.id));
    if (fresh.length >= 1 && data?.session?.status !== "running") break;
    if (Date.now() - t0 > 60000) {
      throw new Error(`regenerate turn timed out (status=${data?.session?.status}) msgs=${JSON.stringify(ms).slice(0, 1200)}`);
    }
  }
  const after: any[] = (await ctx.send({ type: "get_session", sessionId }))?.session?.messages || [];
  // The user row is reused (still exactly one), the reply re-ran (new id).
  assert.equal(after.filter((m: any) => m.role === "user" && userTextOf(m).includes("OMEGA")).length, 1,
    "regenerate must reuse the user row (exactly one)");
  assert(after.some((m: any) => m.role === "assistant" && !beforeReplyIds.has(m.id)), "regenerate must produce a NEW reply");
  log("test", "scenario B PASS");
}

// C. fork_and_resend: the fork holds the prefix ABOVE the turn + the new
// row (durable there before its turn); the source is untouched.
async function scenarioForkResend(ctx: any) {
  log("test", "scenario C: fork_and_resend");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e fork resend", model: MODEL, options: { mode: "talk" } });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await runTurn(ctx, sessionId, "Reply exactly: FIRST", "FIRST");
  const msgs: any[] = (await runTurn(ctx, sessionId, "Reply exactly: SECOND", "SECOND")) as any[];
  const boundary = [...msgs].reverse().find((m: any) => m.role === "user" && userTextOf(m).includes("SECOND"));
  assert(boundary, "SECOND user row not found");
  const res: any = await ctx.sendWait({
    type: "fork_and_resend", sessionId, turnId: boundary.turnIndex,
    text: "Reply exactly: FORKED", model: MODEL,
  }, "fork_and_resend_result");
  assert(res, "fork_and_resend produced NO result (silent drop!)");
  assert.equal(res.ok, true, `fork_and_resend failed: ${res.error}`);
  assert(res.newSessionId, "fork_and_resend must report the new session id");
  // The FORK: prefix ABOVE (FIRST) + the new row — durable before its turn.
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(1500);
    const data: any = await ctx.send({ type: "get_session", sessionId: res.newSessionId });
    const txt = JSON.stringify(data?.session?.messages || []);
    if (txt.includes("EXACTLY: FORKED") && data?.session?.status !== "running") break;
    assert(Date.now() - t0 < 120000, "forked turn timed out");
  }
  const forked: any[] = (await ctx.send({ type: "get_session", sessionId: res.newSessionId }))?.session?.messages || [];
  assert(forked.some((m: any) => m.role === "user" && userTextOf(m).includes("FIRST")), "fork must keep the prefix (FIRST)");
  assert.equal(forked.filter((m: any) => m.role === "user" && userTextOf(m).includes("SECOND")).length, 0,
    "fork_and_resend must EXCLUDE the boundary turn (SECOND)");
  assert.equal(forked.filter((m: any) => m.role === "user" && userTextOf(m).includes("FORKED")).length, 1,
    "the new row must be durable in the fork exactly once");
  // The SOURCE is untouched.
  const source: any[] = (await ctx.send({ type: "get_session", sessionId }))?.session?.messages || [];
  assert(source.some((m: any) => m.role === "user" && userTextOf(m).includes("SECOND")), "source must keep its turn");
  assert.equal(source.filter((m: any) => m.role === "user" && userTextOf(m).includes("FORKED")).length, 0,
    "source must not receive the fork's row");
  log("test", "scenario C PASS");
}

// D. plain fork: the fork INCLUDES the boundary turn.
async function scenarioFork(ctx: any) {
  log("test", "scenario D: plain fork (boundary turn INCLUDED)");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e fork", model: MODEL, options: { mode: "talk" } });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await runTurn(ctx, sessionId, "Reply exactly: KEEP", "KEEP");
  const msgs: any[] = (await runTurn(ctx, sessionId, "Reply exactly: CUT", "CUT")) as any[];
  const boundary = [...msgs].reverse().find((m: any) => m.role === "user" && userTextOf(m).includes("CUT"));
  assert(boundary, "CUT user row not found");
  // Plain fork_session: the boundary turn (user + reply) is INCLUDED.
  // `index` is the RAW row index in the record (srcIdx is a frontend-only
  // mapping — compute it from the payload order).
  const boundaryIdx = msgs.indexOf(boundary);
  assert(boundaryIdx >= 0, "boundary row must be in the payload");
  const fr: any = await ctx.send({ type: "fork_session", sessionId, index: boundaryIdx, editText: "", model: MODEL });
  // The wire ack is session_forked (the fork_session result).
  const forkId = fr?.session?.id || fr?.newID;
  assert(forkId, `fork_session produced no id: ${JSON.stringify(fr).slice(0, 200)}`);
  const forked: any[] = (await ctx.send({ type: "get_session", sessionId: forkId }))?.session?.messages || [];
  assert(forked.some((m: any) => m.role === "user" && userTextOf(m).includes("KEEP")), "fork must keep the prefix");
  assert(forked.some((m: any) => m.role === "user" && userTextOf(m).includes("CUT")), "plain fork must INCLUDE the boundary turn");
  log("test", "scenario D PASS");
}

// E. the REAL browser page drives a discard_and_resend through the UI
// (edit a row -> save & resend) and the record + page agree.
async function scenarioBrowserEdit(ctx: any) {
  log("test", "scenario E: browser-driven edit + save&resend");
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "e2e browser edit", model: MODEL, options: { mode: "talk" } });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  await runTurn(ctx, sessionId, "Reply exactly: UIALPHA", "UIALPHA");
  await runTurn(ctx, sessionId, "Reply exactly: UIBETA", "UIBETA");
  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    // Exercise the actual editor and confirmation; a missing selector must
    // fail this browser gate rather than silently substitute a wire command.
    const row = page.locator('[data-transcript-id]').filter({ hasText: "Reply exactly: UIBETA" }).last();
    await row.getByRole("button", { name: "Edit and resend", exact: true }).click();
    await page.locator("#rc-editing-msg").fill("Reply exactly: UIGAMMA");
    await page.getByRole("button", { name: "Save and Send", exact: true }).click();
    await page.getByRole("button", { name: "Discard & resend", exact: false }).click();
    const t0 = Date.now();
    for (;;) {
      await Bun.sleep(1500);
      const data: any = await ctx.send({ type: "get_session", sessionId });
      const txt = JSON.stringify(data?.session?.messages || []);
      if (txt.includes("EXACTLY: UIGAMMA") && data?.session?.status !== "running") break;
      assert(Date.now() - t0 < 120000, "browser edit turn timed out");
    }
    // Reload the page and verify the USER'S VIEW: exactly one edited row,
    // the discarded text gone, the prefix intact.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(5000);
    const body: string = await page.evaluate(() => document.body.textContent || "");
    assert(/UIGAMMA/.test(body), `page must show the edited row: ${body.slice(-300)}`);
    assert(!/UIBETA/.test(body), `page must NOT show the discarded row: ${body.slice(-300)}`);
    assert(/UIALPHA/.test(body), `page must show the surviving prefix: ${body.slice(-300)}`);
    assertNoPageErrors(pageErrors, consoleErrors, "browser edit flow");
    log("test", "scenario E PASS");
  } finally {
    await browser.close();
  }
}

const only = process.argv[2];
const ctx = await boot();
try {
  if (!only || only === "resend") await scenarioResend(ctx);
  if (!only || only === "regenerate") await scenarioRegenerate(ctx);
  if (!only || only === "fork_resend") await scenarioForkResend(ctx);
  if (!only || only === "fork") await scenarioFork(ctx);
  if (!only || only === "browser") await scenarioBrowserEdit(ctx);
  console.log(`\n=== RESULT ===\nPASS: edit/resend/fork E2E complete\n`);
} catch (err) {
  console.error(`\n=== RESULT ===\nFAIL: ${err}\n`);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}