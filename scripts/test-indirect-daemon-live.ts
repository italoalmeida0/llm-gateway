/**
 * test-indirect-daemon-live.ts — LIVE smoke test for indirect-code-daemon.
 *
 * Boots a real gateway + the daemon binary + the Meta provider from .env
 * (META_API_KEY / META_BASE_URL), pairs via --connect, opens a session and
 * runs ONE real model turn ("reply with exactly: PONG") over the client WS,
 * asserting the transcript streams back.
 *
 * Usage:
 *   bun run build:web            # not needed (no browser here)
 *   bun run build:daemon (or go build -o /tmp/indirect-code ./cmd/daemon in indirect-code-daemon/)
 *   bun scripts/test-indirect-daemon-live.ts
 *
 * Env: E2E_GW_PORT (default 4620), E2E_MODEL (default muse-spark-1.3-contributor).
 * Fails non-zero with evidence. Slow on purpose (real model latency).
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname));
const WS = path.join(ROOT, "..");
const envFile = await fs.readFile(path.join(WS, ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};
const META_KEY = envGet("META_TEST_KEY") || envGet("META_API_KEY");
const META_BASE = envGet("META_BASE_URL") || "https://api.meta.ai/v1";
const MODEL = process.env.E2E_MODEL || "muse-spark-1.3-contributor";
if (!META_KEY) { console.error("META_API_KEY missing"); process.exit(2); }

const GW_PORT = Number(process.env.E2E_GW_PORT || 4620);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "daemon-live-pass-1";
const procs: Array<{ kill: () => void }> = [];
const log = (t: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${t}] ${m}`);

process.on("exit", () => { for (const p of procs) try { p.kill(); } catch {} });

// daemon binary: prefer repo build, fall back to /tmp.
async function findDaemonBin(): Promise<string> {
  const cands = [
    path.join(WS, "indirect-code-daemon", "bin", "indirect-code"),
    "/tmp/indirect-code",
  ];
  for (const c of cands) if (await fs.stat(c).catch(() => null)) return c;
  console.error("daemon binary missing: bun run build:daemon");
  process.exit(2);
}

const v2bin = await findDaemonBin();
const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-icd-"));
const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
  cwd: WS,
  env: { ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir, ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW, GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", PUBLIC_URL: GW },
  stdout: "ignore", stderr: "ignore",
});
procs.push(gwProc);
{
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${GW}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }
}
const login: any = await (await fetch(`${GW}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
})).json();
assert(login.success, "admin login failed");
const auth = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };
const pair: any = await (await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { authorization: `Bearer ${login.accessToken}` } })).json();
assert(pair.success && pair.connectUrl, "pairing failed");
const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-icd-d-"));
mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
const workDir = path.join(daemonDir, "workspace");
const daemonProc = Bun.spawn([v2bin, "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "Test Daemon"],
  { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
procs.push(daemonProc);
const prov: any = await (await fetch(`${GW}/api/admin/providers`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ name: "meta", openaiBaseUrl: META_BASE, apiKey: META_KEY, openaiAuthStyle: "bearer" }),
})).json();
assert(prov.success, "provider create failed: " + JSON.stringify(prov));
await fetch(`${GW}/api/admin/models`, {
  method: "POST", headers: auth,
  body: JSON.stringify({ id: MODEL, providerId: "meta", upstreamModel: MODEL }),
});
const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(login.accessToken)}`);
let hostId = "";
const seen: any[] = [];
await new Promise<void>((res) => { ws.onopen = () => res(); });
ws.onmessage = (ev) => { try { seen.push(JSON.parse(ev.data)); } catch {} };
{
  const start = Date.now();
  while (!hostId && Date.now() - start < 30000) {
    const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json();
    const f = (h.hosts || []).find((x: any) => x.name === "Test Daemon" && x.status === "online");
    if (f) hostId = f.id;
    else await Bun.sleep(500);
  }
}
assert(hostId, "daemon host never came online");
log("boot", `gateway + daemon up (host ${hostId})`);

const send = (p: any) => ws.send(JSON.stringify({ ...p, hostId }));
// 1. create session
send({ type: "create_session", requestId: "r1", cwd: workDir, title: "live test", model: MODEL, options: { effort: "none", mode: "talk", access: "full" } });
let sessId = "";
{
  const t0 = Date.now();
  while (!sessId && Date.now() - t0 < 15000) {
    await Bun.sleep(300);
    const m = seen.find((x) => x.type === "session_created");
    if (m) sessId = m.session.id;
  }
}
assert(sessId, "no session_created");
log("session", sessId);
// 2. prompt: reply with exactly PONG (talk mode, no tools)
send({ type: "prompt", sessionId: sessId, text: "Reply with exactly: PONG", model: MODEL });
let done = false, text = "";
let sawRunning = false, sawIdle = false, sawSnapshot = false;
{
  const t0 = Date.now();
  while (!done && Date.now() - t0 < 180000) {
    await Bun.sleep(1000);
    for (const m of seen) {
      if (m.type === "agent_event" && m.sessionId === sessId) {
        const e = m.event;
        if (e?.type === "text_delta" && e.delta) text += e.delta;
        if (e?.type === "turn_end") done = true;
      }
      // Foreground contract (v1 parity): running status at start, completion
      // snapshot + idle status at end. A passing turn_end alone is NOT enough
      // (it once passed with the UI stuck on running).
      if (m.type === "session_status" && m.sessionId === sessId) {
        if (m.status === "running") sawRunning = true;
        if (m.status === "idle") sawIdle = true;
      }
      if (m.type === "session_data" && m.session?.id === sessId) {
        const s = m.session;
        if (s.status === "idle" && Array.isArray(s.messages) && s.messages.length >= 2 && s.history) sawSnapshot = true;
      }
    }
  }
}
log("turn", `done=${done} text=${JSON.stringify(text.slice(0, 200))}`);
assert(done, "turn never ended");
// Drain grace: session_data snapshot + session_status idle are emitted
// right after turn_end; give the relay a few seconds to deliver them.
{
  const t0 = Date.now();
  const need = () => {
    let idle = sawIdle, snap = sawSnapshot;
    for (const m of seen) {
      if (m.type === "session_status" && m.sessionId === sessId && m.status === "idle") idle = true;
      if (m.type === "session_data" && m.session?.id === sessId) {
        const x = m.session;
        if (x.status === "idle" && Array.isArray(x.messages) && x.messages.length >= 2 && x.history) snap = true;
      }
    }
    return { idle, snap };
  };
  while (Date.now() - t0 < 15000) {
    const { idle, snap } = need();
    sawIdle = idle; sawSnapshot = snap;
    if (sawIdle && sawSnapshot) break;
    await Bun.sleep(500);
  }
}
assert(/PONG/i.test(text), `PONG not in transcript: ${text.slice(0, 500)}`);
assert(sawRunning, "missing session_status running (Stop button never flips)");
assert(sawIdle, "missing session_status idle (UI stuck on running)");
assert(sawSnapshot, "missing completion snapshot (session_data idle + tail + cursor)");
// 2b. follow-up turn on the same session (refresh identity): the worker
// re-runs the BeforeRequest refresh round-trip against the actor and the
// request carries the growing history, so the model must still see turn 1.
send({
  type: "prompt",
  sessionId: sessId,
  text: "What single word did I ask you to reply with in the previous message? Reply with exactly that one word.",
  model: MODEL,
});
let done2 = false, text2 = "";
{
  const t0 = Date.now();
  // Incremental scan: only messages appended after the prompt was sent
  // belong to turn 2 (the shared `seen` array holds every event).
  let idx = seen.length;
  while (!done2 && Date.now() - t0 < 180000) {
    await Bun.sleep(1000);
    for (; idx < seen.length; idx++) {
      const m = seen[idx];
      if (m.type === "agent_event" && m.sessionId === sessId) {
        const e = m.event;
        if (e?.type === "text_delta" && e.delta) text2 += e.delta;
        if (e?.type === "turn_end") done2 = true;
      }
    }
  }
}
log("follow-up", `done=${done2} text=${JSON.stringify(text2.slice(0, 200))}`);
assert(done2, "follow-up turn never ended");
assert(/PONG/i.test(text2), `turn-1 context lost on follow-up: ${text2.slice(0, 500)}`);
// 3. session persisted on daemon disk
const files = await fs.readdir(path.join(daemonDir, "sessions")).catch(() => []);
assert(files.some((f) => f.startsWith(sessId)), `session file missing: ${files.join(",")}`);
log("disk", `session file present (${files.length} files)`);
log("PASS", "daemon live turn OK");
process.exit(0);
