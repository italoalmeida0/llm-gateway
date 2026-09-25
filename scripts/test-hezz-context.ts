/**
 * scripts/test-hezz-context.ts — probe a buggy provider through the gateway:
 * hezz (OpenAI-only) + daemon speaking Anthropic (gateway translates
 * OpenAI→Anthropic). Reports what the daemon sees per turn:
 * session.usage (LastTurnUsage → ShouldCompact input) and session.context
 * (estimateContext shown in the UI). Read-only probe; not part of `bun test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";

const WS = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const envFile = await fs.readFile(path.join(WS, ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};
const HEZZ_KEY = envGet("HEZZ_API_KEY") || "gw_f0f28a99ac5f8ffae72bbefdcd04e0a459b4cddd3506c99f";
const HEZZ_BASE = envGet("HEZZ_BASE_URL") || "https://llm.hezz.it/v1";
const MODEL = process.env.E2E_MODEL || "hf:zai-org/GLM-5.3-Flash";
const GW_PORT = Number(process.env.E2E_GW_PORT || 4631);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-hezz-pass-1";
const procs: Array<{ kill: () => void }> = [];
const log = (t: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${t}] ${m}`);
const daemonBin = path.join(WS, "indirect-code-daemon", "bin", "indirect-code");

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-hezz-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
  assert(login.success, "login failed");
  const auth = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };
  const pair: any = await (await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
  assert(pair.success, "pair failed");
  const prov: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "hezz", openaiBaseUrl: HEZZ_BASE, apiKey: HEZZ_KEY, openaiAuthStyle: "bearer" }),
  })).json();
  assert(prov.success, `provider failed: ${JSON.stringify(prov)}`);
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
  const providerId = (list.providers || []).find((p: any) => p.name === "hezz")?.id;
  assert(providerId, "hezz provider id missing");
  let mk: any = await (await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 128000 }),
  })).json();
  if (!mk.success && /already registered/.test(mk.error || "")) {
    mk = await (await fetch(`${GW}/api/admin/models/${encodeURIComponent(MODEL)}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ providerId, upstreamModel: MODEL, contextLength: 128000 }),
    })).json();
  }
  assert(mk.success, `model failed: ${JSON.stringify(mk)}`);
  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-hezz-d-"));
  mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
  const workDir = path.join(daemonDir, "workspace");
  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Hezz Probe"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(login.accessToken)}`);
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
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); }
    } catch {}
  };
  {
    const start = Date.now();
    while (!hostId && Date.now() - start < 20000) {
      const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
      const f = (h.hosts || []).find((x: any) => x.name === "Hezz Probe" && x.status === "online");
      if (f) hostId = f.id;
      else await Bun.sleep(300);
    }
  }
  assert(hostId, "daemon never online");
  log("boot", `up (host ${hostId})`);
  const raw = await (await fetch(`${HEZZ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${HEZZ_KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply exactly HI." }] }),
  })).json();
  log("raw-hezz", `usage=${JSON.stringify((raw as any).usage)}`);
  const keyRes: any = await (await fetch(`${GW}/api/keys`, { method: "POST", headers: auth, body: JSON.stringify({ name: "hezz" }) })).json();
  const gwKey: string = keyRes.token;
  const viaGW = await (await fetch(`${GW}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gwKey}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply exactly HI." }] }),
  })).json();
  log("gw-openai", `usage=${JSON.stringify((viaGW as any).usage)}`);
  const viaAnth = await (await fetch(`${GW}/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${gwKey}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: "user", content: "Reply exactly HI." }] }),
  })).json();
  log("gw-anthropic", `usage=${JSON.stringify((viaAnth as any).usage)}`);
  const { copyFileSync } = await import("fs");
  copyFileSync(`${WS}/test/books/Mary-Wollstonecraft-Shelley-Frankenstein.md`, `${workDir}/frankenstein.md`);
  const created: any = await send({ type: "create_session", cwd: workDir, title: "hezz probe", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  ws.send(JSON.stringify({
    type: "prompt", hostId, sessionId, model: MODEL,
    text: "Read frankenstein.md fully with the read tool, then reply HEZZ-DONE with the line count.",
  }));
  const start = Date.now();
  for (;;) {
    await Bun.sleep(5000);
    const data: any = await send({ type: "get_session", sessionId });
    const st = data?.session?.status;
    if (st !== "running") {
      const sess = data?.session;
      log("session", `status=${sess?.status}`);
      log("session", `usage=${JSON.stringify(sess?.usage)}`);
      log("session", `context=${JSON.stringify(sess?.context)}`);
      const msgs = JSON.stringify(sess?.messages || []);
      log("session", `hezz-done=${msgs.includes("HEZZ-DONE")} msgs=${sess?.messages?.length}`);
      break;
    }
    if (Date.now() - start > 600000) throw new Error("turn timed out");
  }
  console.log("\n=== RESULT ===\nDONE: hezz context probe complete (see logs above)");
}

try { await main(); }
catch (e) { console.error(`FAIL: ${e instanceof Error ? e.stack || e.message : e}`); process.exitCode = 1; }
finally { for (const p of procs) { try { p.kill(); } catch {} } }
