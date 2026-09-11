import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { $ } from "bun";

/**
 * Web Push black-box: subscribe -> simulated turn end with no tab open ->
 * the push service receives an encrypted delivery; with a tab open the
 * relay stays silent (Camada A owns it); dead endpoints (410) are pruned.
 *
 * The "push service" is a tiny local HTTP server standing in for
 * Mozilla/Google autopush: web-push POSTs the encrypted payload to the
 * subscription endpoint URL, so any local URL works.
 */

const GW_PORT = 4511;
const GW = `http://127.0.0.1:${GW_PORT}`;
const GW_WS = `ws://127.0.0.1:${GW_PORT}`;
const PUSH_PORT = 4591;
const ADMIN_PW = "push-admin-pass-1";

let gwProc: ReturnType<typeof Bun.spawn>;
let dataDir: string;
let pushServer: ReturnType<typeof Bun.serve>;
const deliveries: { url: string; body: ArrayBuffer }[] = [];
let pushStatus = 200;

async function waitForServer(): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    try {
      const res = await fetch(`${GW}/api/health`);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("gateway did not come up");
}

beforeAll(async () => {
  // web-push always uses https.request (even for http:// URLs), so the fake
  // push service must be TLS. Self-signed cert + NODE_TLS_REJECT_UNAUTHORIZED=0
  // on the gateway side (test-only).
  const certDir = mkdtempSync(path.join(tmpdir(), "llmgw-push-cert-"));
  await $`openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 1 -nodes -subj /CN=127.0.0.1`.quiet();
  pushServer = Bun.serve({
    port: PUSH_PORT,
    tls: { key: Bun.file(`${certDir}/key.pem`), cert: Bun.file(`${certDir}/cert.pem`) },
    fetch(req) {
      const url = new URL(req.url).pathname;
      return req.arrayBuffer().then((body) => {
        deliveries.push({ url, body });
        return new Response("ok", { status: pushStatus });
      });
    },
  });

  dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-push-test-"));
  mkdirSync(dataDir, { recursive: true });

  gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(GW_PORT),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  await waitForServer();
});

afterAll(() => {
  try {
    gwProc.kill();
  } catch {}
  try {
    pushServer.stop();
  } catch {}
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

describe("Turn-end Web Push", () => {
  let userToken: string;
  let daemonToken: string;
  let hostId: string;

  test("login + pair + connect a host", async () => {
    const login = await fetch(`${GW}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
    });
    expect(login.status).toBe(200);
    userToken = ((await login.json()) as any).accessToken;

    const pair = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pair.json()) as any;
    const connect = await fetch(pairJson.connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Push Host", hostname: "push.local", os: "linux", arch: "amd64" }),
    });
    const cJson = (await connect.json()) as any;
    hostId = cJson.hostId;
    daemonToken = cJson.daemonToken;
    expect(hostId).toStartWith("host_");
  });

  test("GET /api/push/vapid-key returns a public key", async () => {
    const res = await fetch(`${GW}/api/push/vapid-key`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.success).toBe(true);
    expect(typeof j.publicKey).toBe("string");
    expect(j.publicKey.length).toBeGreaterThan(50);
  });

  // Real RFC 8291 client keys generated via WebCrypto (same shape as the browser's).
  async function fakeBrowserSubscription(endpointPath: string) {
    const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    return {
      endpoint: `https://127.0.0.1:${PUSH_PORT}${endpointPath}`,
      keys: { p256dh: b64u(raw), auth: b64u(auth) },
    };
  }

  test("POST /api/push/subscribe validates input", async () => {
    const bad = await fetch(`${GW}/api/push/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "x" }),
    });
    expect(bad.status).toBe(400);

    const unauth = await fetch(`${GW}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "x", keys: { p256dh: "y", auth: "z" } }),
    });
    expect(unauth.status).toBe(401);
  });

  test("turn end with NO tab open -> push delivered; with tab open -> silent", async () => {
    const sub = await fakeBrowserSubscription("/push/sub-1");
    const res = await fetch(`${GW}/api/push/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...sub, label: "Test Browser" }),
    });
    expect(res.status).toBe(200);

    const list = (await (
      await fetch(`${GW}/api/push/subscriptions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    ).json()) as any;
    expect(list.subscriptions.length).toBe(1);
    expect(list.subscriptions[0].pushService).toBe(`127.0.0.1:${PUSH_PORT}`);

    // Fake daemon: connect and emit a finished turn (no browser tab connected).
    const daemonWs = new WebSocket(`${GW_WS}/api/indirect-code/daemon/ws?token=${daemonToken}`);
    await new Promise<void>((resolve, reject) => {
      daemonWs.onopen = () => resolve();
      daemonWs.onerror = (e) => reject(e);
    });
    deliveries.length = 0;
    daemonWs.send(JSON.stringify({ type: "session_data", hostId, session: { id: "sess_1", title: "Fix bug" } }));
    await Bun.sleep(50);
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_1", status: "running" }));
    await Bun.sleep(50);
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_1", status: "idle" }));

    // Push fan-out is async: poll the fake push service.
    const started = Date.now();
    while (deliveries.length === 0 && Date.now() - started < 5000) await Bun.sleep(50);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.url).toBe("/push/sub-1");
    expect(deliveries[0]!.body.byteLength).toBeGreaterThan(50); // encrypted payload

    // Now open a tab: the same turn end must NOT push (Camada A owns it).
    const clientWs = new WebSocket(`${GW_WS}/api/indirect-code/client/ws?token=${userToken}`);
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = (e) => reject(e);
    });
    await Bun.sleep(100);
    deliveries.length = 0;
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_1", status: "running" }));
    await Bun.sleep(50);
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_1", status: "idle" }));
    await Bun.sleep(500);
    expect(deliveries.length).toBe(0);

    await new Promise<void>((res) => {
      clientWs.onclose = () => res();
      clientWs.close();
      setTimeout(() => res(), 2000);
    });
    await new Promise<void>((res) => {
      daemonWs.onclose = () => res();
      daemonWs.close();
      setTimeout(() => res(), 2000);
    });
    // Let the relay process both close frames (client set must be empty
    // or the next turn end is (correctly) treated as tab-open).
    await Bun.sleep(300);
  });

  test("dead endpoint (410) is pruned on next send", async () => {

    const sub = await fakeBrowserSubscription("/push/dead");
    await fetch(`${GW}/api/push/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    pushStatus = 410;

    const daemonWs = new WebSocket(`${GW_WS}/api/indirect-code/daemon/ws?token=${daemonToken}`);
    await new Promise<void>((resolve, reject) => {
      daemonWs.onopen = () => resolve();
      daemonWs.onerror = (e) => reject(e);
    });
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_2", status: "running" }));
    await Bun.sleep(50);
    daemonWs.send(JSON.stringify({ type: "session_status", hostId, sessionId: "sess_2", status: "idle" }));
    // Both subscriptions see 410 (global test status), so both are pruned.
    // Both subscriptions see 410 (global test status), so both are pruned.
    await Bun.sleep(1500);
    const l = (await (
      await fetch(`${GW}/api/push/subscriptions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    ).json()) as any;
    const count = l.subscriptions.length;
    pushStatus = 200;
    await new Promise<void>((res) => {
      daemonWs.onclose = () => res();
      daemonWs.close();
      setTimeout(() => res(), 2000);
    });
    expect(count).toBe(0); // 410 prunes dead endpoints
  });

  test("POST /api/push/unsubscribe removes the device", async () => {
    const sub = await fakeBrowserSubscription("/push/unsub-me");
    const res = await fetch(`${GW}/api/push/subscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    expect(res.status).toBe(200);
    const un = await fetch(`${GW}/api/push/unsubscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(((await un.json()) as any).removed).toBe(true);
    // Unsubscribing again reports removed=false (idempotent).
    const un2 = await fetch(`${GW}/api/push/unsubscribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(((await un2.json()) as any).removed).toBe(false);
    const after = (await (
      await fetch(`${GW}/api/push/subscriptions`, {
        headers: { Authorization: `Bearer ${userToken}` },
      })
    ).json()) as any;
    expect(after.subscriptions.length).toBe(0);
  });
});
