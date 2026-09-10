import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const GW_PORT = 4510;
const GW = `http://127.0.0.1:${GW_PORT}`;
const GW_WS = `ws://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "remote-admin-pass-1";

let gwProc: ReturnType<typeof Bun.spawn>;
let dataDir: string;

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
  dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-remote-test-"));
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
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

describe("Indirect Code Relay and Pairing", () => {
  let userToken: string;

  test("login to obtain access token", async () => {
    const res = await fetch(`${GW}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    userToken = json.accessToken;
  });

  let connectUrl: string;

  test("POST /api/indirect-code/pair generates pairing token", async () => {
    const res = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.token).toBeDefined();
    expect(json.connectUrl).toContain(`/api/indirect-code/connect/${json.token}`);
    connectUrl = json.connectUrl;
  });

  let hostId: string;
  let daemonToken: string;

  test("POST /api/indirect-code/connect/:token completes handshake", async () => {
    const res = await fetch(connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My MacBook",
        hostname: "macbook.local",
        os: "darwin",
        arch: "arm64",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.hostId).toStartWith("host_");
    expect(json.daemonToken).toStartWith("dmt_");
    expect(json.apiKey).toStartWith("gw_");
    expect(json.gatewayUrl).toBe(GW);

    hostId = json.hostId;
    daemonToken = json.daemonToken;

    // Second call with same token must fail (single-use)
    const replayRes = await fetch(connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(replayRes.status).toBe(401);
  });

  test("re-pair with hostId+daemonToken reuses the same host row (no duplicate)", async () => {
    const pairRes = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    expect(pairJson.success).toBe(true);

    const res = await fetch(pairJson.connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "My MacBook",
        hostname: "macbook.local",
        os: "darwin",
        arch: "arm64",
        hostId,
        daemonToken,
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.reused).toBe(true);
    expect(json.hostId).toBe(hostId);
    expect(json.daemonToken).not.toBe(daemonToken);

    // Old token is dead (rotated); new token still resolves to the same host.
    const oldModels = await fetch(`${GW}/api/indirect-code/models`, {
      headers: { Authorization: `Bearer ${daemonToken}` },
    });
    expect(oldModels.status).toBe(401);
    const newModels = await fetch(`${GW}/api/indirect-code/models`, {
      headers: { Authorization: `Bearer ${json.daemonToken}` },
    });
    expect(newModels.status).toBe(200);
    daemonToken = json.daemonToken;

    const listRes = await fetch(`${GW}/api/indirect-code/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const listJson = (await listRes.json()) as any;
    expect(listJson.hosts.length).toBe(1);
    expect(listJson.hosts[0].id).toBe(hostId);
  });

  test("re-pair with wrong token falls back to a fresh host row", async () => {
    const pairRes = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    const res = await fetch(pairJson.connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Intruder", hostId, daemonToken: "dmt_wrong" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.reused ?? false).toBe(false);
    expect(json.hostId).not.toBe(hostId);
    // Cleanup: remove the decoy so later tests see a single host again.
    const delRes = await fetch(`${GW}/api/indirect-code/hosts/${json.hostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(delRes.status).toBe(200);
  });

  test("GET /api/indirect-code/hosts lists registered host as offline", async () => {
    const res = await fetch(`${GW}/api/indirect-code/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.hosts.length).toBe(1);
    expect(json.hosts[0].id).toBe(hostId);
    expect(json.hosts[0].name).toBe("My MacBook");
    expect(json.hosts[0].status).toBe("offline");
  });

  test("offline relay errors retain request correlation for inline recovery", async () => {
    const ws = new WebSocket(`${GW_WS}/api/indirect-code/ws?token=${encodeURIComponent(userToken)}`);
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("offline reply timed out")), 3000);
        ws.onopen = () => ws.send(JSON.stringify({ type: "browse_folders", hostId, id: 456, requestId: "folder-request", sessionId: "session-reference", path: "~" }));
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.type !== "error") return;
          clearTimeout(timer);
          resolve(message);
        };
      });
      expect(response.replyTo).toBe("browse_folders");
      expect(response.requestId).toBe("folder-request");
      expect(response.sessionId).toBe("session-reference");
      expect(response.id).toBe(456);
    } finally { ws.close(); }
  });

  test("daemon model metadata uses the gateway registry with auth and configured limits", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ data: [] }) });
    const headers = { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
    let providerId = "";
    const id = "remote/custom-alias";
    try {
      const providerRes = await fetch(`${GW}/api/admin/providers`, {
        method: "POST", headers,
        body: JSON.stringify({ name: "remote-metadata", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "test-upstream-key" }),
      });
      expect(providerRes.status).toBe(200);
      providerId = ((await providerRes.json()) as any).provider.id;
      const created = await fetch(`${GW}/api/admin/models`, {
        method: "POST", headers,
        body: JSON.stringify({ id, providerId, contextLength: 1024000, maxOutputLength: 16384, reasoningEfforts: ["low", "high"] }),
      });
      expect(created.status).toBe(200);
      expect((await fetch(`${GW}/api/indirect-code/models`)).status).toBe(401);
      expect((await fetch(`${GW}/api/indirect-code/models`, { headers })).status).toBe(401);
      const daemonHeaders = { Authorization: `Bearer ${daemonToken}` };
      const read = async () => (await (await fetch(`${GW}/api/indirect-code/models`, { headers: daemonHeaders })).json()) as any;
      const catalog = await read();
      expect(catalog.models.find((m: any) => m.id === id).limit).toEqual({ context: 1024000, output: 16384 });
      const dashboard = (await (await fetch(`${GW}/api/me/models`, { headers })).json()) as any;
      const entry = dashboard.models.find((m: any) => m.id === id);
      expect(entry.context).toBe(1024000);
      // provider/upstreamModel mirror the first routing target
      expect(entry.provider).toBe("remote-metadata");
      expect(entry.upstreamModel).toBe(id);
      const patched = await fetch(`${GW}/api/admin/models/${encodeURIComponent(id)}`, {
        method: "PATCH", headers, body: JSON.stringify({ contextLength: null, maxOutputLength: null }),
      });
      expect(patched.status).toBe(200);
      // unknown limits fall back to the API defaults (256Ki context, 64k output)
      expect((await read()).models.find((m: any) => m.id === id).limit).toEqual({ context: 262144, output: 65536 });
      const dashboard2 = (await (await fetch(`${GW}/api/me/models`, { headers })).json()) as any;
      expect(dashboard2.models.find((m: any) => m.id === id).context).toBe(262144);
      await fetch(`${GW}/api/admin/models/${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify({ enabled: false }) });
      expect((await read()).models).toEqual([]);
    } finally {
      await fetch(`${GW}/api/admin/models/${encodeURIComponent(id)}`, { method: "DELETE", headers });
      if (providerId) await fetch(`${GW}/api/admin/providers/${providerId}`, { method: "DELETE", headers });
      upstream.stop();
    }
  });

  test("WebSocket relay: Daemon connects and Web Client exchanges messages", async () => {
    // 1. Connect Daemon WebSocket
    const daemonWs = new WebSocket(`${GW_WS}/api/indirect-code/daemon/ws?token=${daemonToken}`);
    await new Promise<void>((resolve, reject) => {
      daemonWs.onopen = () => resolve();
      daemonWs.onerror = (e) => reject(e);
    });

    // 2. Connect Client WebSocket
    const clientWs = new WebSocket(`${GW_WS}/api/indirect-code/client/ws?token=${userToken}`);
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = (e) => reject(e);
    });

    // Check host status via REST or wait for status notification
    await Bun.sleep(50);
    const hostListRes = await fetch(`${GW}/api/indirect-code/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const hostsJson = (await hostListRes.json()) as any;
    expect(hostsJson.hosts[0].status).toBe("online");

    // 3. Client sends a command for Daemon: pull (SignalDB sync)
    const daemonReceivedPromise = new Promise<any>((resolve) => {
      daemonWs.onmessage = (ev) => {
        resolve(JSON.parse(String(ev.data)));
      };
    });

    clientWs.send(
      JSON.stringify({
        type: "pull",
        id: 7,
        collection: "sessions",
        hostId,
      }),
    );

    const daemonReceived = await daemonReceivedPromise;
    expect(daemonReceived.type).toBe("pull");
    expect(daemonReceived.hostId).toBe(hostId);

    // 4. Daemon replies with a pull-response correlated by id
    const clientReceivedPromise = new Promise<any>((resolve) => {
      clientWs.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 7) resolve(msg);
      };
    });

    daemonWs.send(
      JSON.stringify({
        id: 7,
        hostId,
        collection: "sessions",
        items: [
          {
            id: "sess_test_1",
            cwd: "/home/user/project",
            title: "Test Session",
            model: "claude-3-5-sonnet",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );

    const clientReceived = await clientReceivedPromise;
    expect(clientReceived.id).toBe(7);
    expect(clientReceived.items.length).toBe(1);
    expect(clientReceived.items[0].id).toBe("sess_test_1");

    daemonWs.close();
    clientWs.close();
    await Bun.sleep(50);
  });

  test("Real Go Daemon binary: pairs via CLI --connect and serves session lifecycle", async () => {
    // 1. Generate pairing token
    const pairRes = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    expect(pairJson.success).toBe(true);

    // 2. Temp directories for daemon data and work dir
    const daemonData = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-test-"));
    const workDir = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-work-"));

    const daemonBin = path.join(import.meta.dir, "../indirect-code-daemon/bin/indirect-code");

    // Spawn Go daemon
    const daemonSubproc = Bun.spawn(
      [daemonBin, "--connect", pairJson.connectUrl, "--data-dir", daemonData, "--name", "Real Go Daemon"],
      {
        stdout: "inherit",
        stderr: "inherit",
      },
    );

    try {
      // Wait for daemon to register and come online
      let realHostId = "";
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        const hRes = await fetch(`${GW}/api/indirect-code/hosts`, {
          headers: { Authorization: `Bearer ${userToken}` },
        });
        const hJson = (await hRes.json()) as any;
        const found = hJson.hosts.find((h: any) => h.name === "Real Go Daemon" && h.status === "online");
        if (found) {
          realHostId = found.id;
          break;
        }
        await Bun.sleep(100);
      }

      expect(realHostId).not.toBeEmpty();

      // Connect client WebSocket
      const clientWs = new WebSocket(`${GW_WS}/api/indirect-code/client/ws?token=${userToken}`);
      await new Promise<void>((resolve, reject) => {
        clientWs.onopen = () => resolve();
        clientWs.onerror = (e) => reject(e);
      });

      // Create a session via WebSocket
      const createdPromise = new Promise<any>((resolve) => {
        clientWs.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "session_created") resolve(msg);
        };
      });

      clientWs.send(
        JSON.stringify({
          hostId: realHostId,
          type: "create_session",
          cwd: workDir,
          title: "Real Go Session",
          model: "gpt-4o",
        }),
      );

      const createdMsg = await createdPromise;
      expect(createdMsg.type).toBe("session_created");
      expect(createdMsg.session.title).toBe("Real Go Session");
      expect(createdMsg.session.cwd).toBe(workDir);

      // List sessions via WebSocket (SignalDB pull)
      const listPromise = new Promise<any>((resolve) => {
        clientWs.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "pull-response" && msg.id === 11) resolve(msg);
        };
      });

      clientWs.send(
        JSON.stringify({
          hostId: realHostId,
          type: "pull",
          id: 11,
          collection: "sessions",
        }),
      );

      const listMsg = await listPromise;
      expect(listMsg.type).toBe("pull-response");
      expect(listMsg.items.length).toBeGreaterThanOrEqual(1);
      expect(listMsg.items.some((s: any) => s.id === createdMsg.session.id)).toBe(true);

      // Clean up host
      clientWs.close();
      const delRes = await fetch(`${GW}/api/indirect-code/hosts/${realHostId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(delRes.status).toBe(200);
    } finally {
      try {
        daemonSubproc.kill();
      } catch {}
      try {
        rmSync(daemonData, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }, 15000);

  test("Real Go Daemon: pins, message edit/delete, projects, search, attachments", async () => {
    const pairRes = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    expect(pairJson.success).toBe(true);

    const daemonData = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-test2-"));
    const workDir = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-work2-"));
    const daemonBin = path.join(import.meta.dir, "../indirect-code-daemon/bin/indirect-code");
    const daemonSubproc = Bun.spawn(
      [daemonBin, "--connect", pairJson.connectUrl, "--data-dir", daemonData, "--name", "Feature Daemon"],
      { stdout: "inherit", stderr: "inherit" },
    );

    try {
      let featHostId = "";
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        const hRes = await fetch(`${GW}/api/indirect-code/hosts`, {
          headers: { Authorization: `Bearer ${userToken}` },
        });
        const hJson = (await hRes.json()) as any;
        const found = hJson.hosts.find((h: any) => h.name === "Feature Daemon" && h.status === "online");
        if (found) {
          featHostId = found.id;
          break;
        }
        await Bun.sleep(100);
      }
      expect(featHostId).not.toBeEmpty();

      const clientWs = new WebSocket(`${GW_WS}/api/indirect-code/client/ws?token=${userToken}`);
      // Single permanent handler + buffer: reassigning/nulling `onchange`
      // mid-test races Bun's ws internals and silently drops frames.
      const recv: any[] = [];
      clientWs.onmessage = (ev) => {
        try {
          recv.push(JSON.parse(String(ev.data)));
        } catch {}
      };
      await new Promise<void>((resolve, reject) => {
        clientWs.onopen = () => resolve();
        clientWs.onerror = (e) => reject(e);
      });

      const waitFor = (pred: (m: any) => boolean, timeout = 5000): Promise<any> =>
        new Promise((resolve, reject) => {
          // Only messages arriving after this call (buffer holds history).
          const startIdx = recv.length;
          const poll = setInterval(() => {
            for (let i = startIdx; i < recv.length; i++) {
              if (pred(recv[i])) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(recv[i]);
                return;
              }
            }
          }, 25);
          const timer = setTimeout(() => {
            clearInterval(poll);
            reject(new Error("timed out waiting for daemon message"));
          }, timeout);
        });
      const send = (obj: any) => clientWs.send(JSON.stringify({ hostId: featHostId, ...obj }));

      // Session with blank title -> placeholder until auto-title
      send({ type: "create_session", cwd: workDir, title: "", model: "gpt-4o" });
      const created = await waitFor((m) => m.type === "session_created");
      const sid = created.session.id;
      expect(created.session.title).toBe("New conversation");

      send({ type: "browse_folders", path: workDir, requestId: "browse-root" });
      const folders = await waitFor((m) => m.type === "folders" && m.requestId === "browse-root");
      expect(folders.path).toBe(workDir);
      expect(folders.parent).toBe(path.dirname(workDir));
      expect(Array.isArray(folders.folders)).toBe(true);

      send({ type: "configure_session", sessionId: sid, model: "gpt-4o", options: { effort: "low", mode: "build", skills: [], access: "ask" } });
      const configured = await waitFor((m) => m.type === "session_data" && m.session?.id === sid && m.session.options?.effort === "low");
      expect(configured.session.options.access).toBe("ask");
      send({ type: "pull", id: 1234, collection: "config" });
      const preferences = await waitFor((m) => m.type === "pull-response" && m.id === 1234);
      expect(preferences.items[0].lastSelection).toEqual({ model: "gpt-4o", effort: "low", mode: "build", skills: [], access: "ask" });

      // Rename + pin round-trip
      send({ type: "rename_session", sessionId: sid, title: "Renamed Session" });
      const renamed = await waitFor((m) => m.type === "session_renamed");
      expect(renamed.title).toBe("Renamed Session");
      send({ type: "toggle_pin", sessionId: sid });
      const pinned = await waitFor((m) => m.type === "session_pinned");
      expect(pinned.pinned).toBe(true);

      // Seed a transcript via slash-free edit path: use /help to create messages
      send({ type: "prompt", sessionId: sid, text: "/help", model: "gpt-4o" });
      await waitFor((m) => m.type === "session_content" && m.sessionId === sid);
      send({ type: "pull", id: 5555, collection: "sessions" });
      const listed = await waitFor((m) => m.type === "pull-response" && m.id === 5555);
      expect(listed.items.some((s: any) => s.id === sid && s.pinned === true)).toBe(true);

      // Forks are daemon-owned independent prefixes, with an action ack and a
      // normal mirrored listing; both user and assistant boundaries are valid.
      for (const index of [0, 1]) {
        send({ type: "fork_session", sessionId: sid, index, requestId: `fork-${index}` });
        const forked = await waitFor((m) => m.type === "session_forked" && m.requestId === `fork-${index}`);
        expect(forked.session.id).not.toBe(sid);
        expect(forked.session.cwd).toBe(workDir);
        expect(forked.session.status).toBe("idle");
        expect(forked.session.messages.length).toBe(index + 1);
        expect(forked.session.options).toEqual(configured.session.options);
      }

      // Search finds seeded transcript terms (before we edit/delete them)
      send({ type: "search", query: "Slash Commands" });
      const hits = await waitFor((m) => m.type === "search_results");
      expect(hits.results.some((r: any) => r.sessionId === sid)).toBe(true);

      // Edit first message without regen, then delete it
      send({ type: "edit_message", sessionId: sid, index: 0, text: "edited hello", regenerate: false });
      const edited = await waitFor(
        (m) => m.type === "session_content" && m.sessionId === sid && JSON.stringify(m.messages).includes("edited hello"),
      );
      expect(edited.messages.length).toBeGreaterThanOrEqual(1);
      send({ type: "delete_message", sessionId: sid, index: 0 });
      const afterDel = await waitFor(
        (m) => m.type === "session_content" && m.sessionId === sid && !JSON.stringify(m.messages).includes("edited hello"),
      );
      expect(afterDel).toBeDefined();

      // Attachment upload + fetch round-trip (before the cascade tests wipe sessions)
      const helloB64 = Buffer.from("hello attachment").toString("base64");
      send({ type: "upload_attachment", sessionId: sid, name: "note.txt", mime: "text/plain", data: helloB64, requestId: "ua_test_1" });
      const uploaded = await waitFor((m) => m.type === "attachment_uploaded");
      expect(uploaded.attachment.name).toBe("note.txt");
      send({ type: "get_attachment", sessionId: sid, attachmentId: uploaded.attachment.id });
      const fetched = await waitFor((m) => m.type === "attachment_data");
      expect(Buffer.from(fetched.attachment.data, "base64").toString()).toBe("hello attachment");

      // SignalDB sync protocol: pull returns full snapshots with the echoed id
      send({ type: "pull", id: 4242, collection: "sessions" });
      const pullSessions = await waitFor((m) => m.type === "pull-response" && m.collection === "sessions");
      expect(pullSessions.id).toBe(4242);
      expect(pullSessions.items.some((s: any) => s.id === sid)).toBe(true);
      send({ type: "pull", id: 4343, collection: "config" });
      const pullConfig = await waitFor((m) => m.type === "pull-response" && m.collection === "config");
      expect(pullConfig.id).toBe(4343);
      expect(pullConfig.items[0].id).toBe("daemon");
      send({ type: "pull", id: 4545, collection: "projects" });
      const pullProjectsEmpty = await waitFor((m) => m.type === "pull-response" && m.collection === "projects");
      expect(pullProjectsEmpty.items.length).toBe(1);
      expect(pullProjectsEmpty.items[0].name).toBe("Home");
      expect(pullProjectsEmpty.items[0].protected).toBe(true);

      // Change pings: a mutation must broadcast a debounced change notice
      send({ type: "rename_session", sessionId: sid, title: "Ping Source" });
      await waitFor((m) => m.type === "session_renamed" && m.title === "Ping Source");
      const ping = await waitFor((m) => m.type === "change" && m.collection === "sessions");
      expect(ping.hostId).toBe(featHostId);

      // Projects CRUD (daemon-owned)
      send({ type: "create_project", path: workDir });
      const projCreated = await waitFor((m) => m.type === "project_created");
      expect(projCreated.project.path).toBe(workDir);
      expect(projCreated.project.protected).toBe(false);
      send({ type: "pull", id: 4646, collection: "projects" });
      const pullProjects = await waitFor((m) => m.type === "pull-response" && m.collection === "projects" && m.id === 4646);
      expect(pullProjects.items.some((p: any) => p.id === projCreated.project.id)).toBe(true);

      // Reasoning effort levels are canonicalized on write (via configure_session)
      send({ type: "configure_session", sessionId: sid, model: "gpt-4o", options: { effort: "xhigh", mode: "build", skills: [], access: "ask" } });
      send({ type: "pull", id: 4747, collection: "config" });
      const pullReason = await waitFor((m) => m.type === "pull-response" && m.collection === "config" && m.id === 4747);
      expect(pullReason.items[0].lastSelection.effort).toBe("xhigh");
      send({ type: "configure_session", sessionId: sid, model: "gpt-4o", options: { effort: "off", mode: "build", skills: [], access: "ask" } });
      send({ type: "pull", id: 4848, collection: "config" });
      const pullReasonOff = await waitFor((m) => m.type === "pull-response" && m.collection === "config" && m.id === 4848);
      expect(pullReasonOff.items[0].lastSelection.effort).toBe("none");

      // Protected Home project: cannot be deleted, neither directly nor by
      // path-cycling (create with "~" re-acks the same entry)
      send({ type: "create_project", path: "~" });
      const homeCreated = await waitFor((m) => m.type === "project_created" && m.project.path !== workDir);
      expect(homeCreated.project.protected).toBe(true);
      send({ type: "delete_project", projectId: homeCreated.project.id });
      const homeDelErr = await waitFor((m) => m.type === "error" && String(m.message).toLowerCase().includes("cannot be deleted"));
      expect(homeDelErr).toBeDefined();
      send({ type: "pull", id: 4949, collection: "projects" });
      const afterHomeDel = await waitFor((m) => m.type === "pull-response" && m.collection === "projects" && m.id === 4949);
      expect(afterHomeDel.items.some((p: any) => p.id === homeCreated.project.id)).toBe(true);

      // Nested session inside the project tree (cwd = <workDir>/sub)
      send({ type: "create_session", cwd: `${workDir}/sub`, title: "Nested", model: "gpt-4o" });
      const nestedCreated = await waitFor((m) => m.type === "session_created" && m.session.cwd === `${workDir}/sub`);
      const nestedSid = nestedCreated.session.id;
      send({ type: "upload_attachment", sessionId: nestedSid, name: "nested.txt", mime: "text/plain", data: helloB64, requestId: "ua_test_2" });
      await waitFor((m) => m.type === "attachment_uploaded" && m.sessionId === nestedSid);

      // Deleting the project cascades: BOTH sessions wiped 100% (json + dirs)
      const mark = recv.length;
      send({ type: "delete_project", projectId: projCreated.project.id });
      const hasCascade = () => {
        const later = recv.slice(mark);
        return (
          later.some((m) => m.type === "session_deleted" && m.sessionId === sid) &&
          later.some((m) => m.type === "session_deleted" && m.sessionId === nestedSid) &&
          later.some((m) => m.type === "project_deleted")
        );
      };
      const cascadeDeadline = Date.now() + 5000;
      while (Date.now() < cascadeDeadline && !hasCascade()) {
        await Bun.sleep(50);
      }
      expect(hasCascade()).toBe(true);

      send({ type: "pull", id: 5959, collection: "sessions" });
      const afterCascade = await waitFor((m) => m.type === "pull-response" && m.id === 5959);
      expect(afterCascade.items.length).toBe(0);
      // No trace left on the daemon's disk: record file AND attachment folders
      const sessDir = path.join(daemonData, "sessions");
      expect(existsSync(path.join(sessDir, `${sid}.json`))).toBe(false);
      expect(existsSync(path.join(sessDir, sid))).toBe(false);
      expect(existsSync(path.join(sessDir, `${nestedSid}.json`))).toBe(false);
      expect(existsSync(path.join(sessDir, nestedSid))).toBe(false);

      clientWs.close();
      const delRes = await fetch(`${GW}/api/indirect-code/hosts/${featHostId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      expect(delRes.status).toBe(200);
    } finally {
      try {
        daemonSubproc.kill();
      } catch {}
      try {
        rmSync(daemonData, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }, 30000);

  test("Real Go Daemon: edit+resend and regenerate do not duplicate the user message", async () => {
    const pairRes = await fetch(`${GW}/api/indirect-code/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    expect(pairJson.success).toBe(true);

    const daemonData = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-dedup-"));
    const workDir = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-dedup-work-"));
    const daemonBin = path.join(import.meta.dir, "../indirect-code-daemon/bin/indirect-code");
    const daemonSubproc = Bun.spawn(
      [daemonBin, "--connect", pairJson.connectUrl, "--data-dir", daemonData, "--name", "Dedup Daemon"],
      { stdout: "inherit", stderr: "inherit" },
    );

    let dupHostId = "";
    try {
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        const hRes = await fetch(`${GW}/api/indirect-code/hosts`, {
          headers: { Authorization: `Bearer ${userToken}` },
        });
        const hJson = (await hRes.json()) as any;
        const found = hJson.hosts.find((h: any) => h.name === "Dedup Daemon" && h.status === "online");
        if (found) {
          dupHostId = found.id;
          break;
        }
        await Bun.sleep(100);
      }
      expect(dupHostId).not.toBeEmpty();

      const clientWs = new WebSocket(`${GW_WS}/api/indirect-code/client/ws?token=${userToken}`);
      const recv: any[] = [];
      clientWs.onmessage = (ev) => {
        try {
          recv.push(JSON.parse(String(ev.data)));
        } catch {}
      };
      await new Promise<void>((resolve, reject) => {
        clientWs.onopen = () => resolve();
        clientWs.onerror = (e) => reject(e);
      });

      const waitFor = (pred: (m: any) => boolean, timeout = 5000): Promise<any> =>
        new Promise((resolve, reject) => {
          const startIdx = recv.length;
          const poll = setInterval(() => {
            for (let i = startIdx; i < recv.length; i++) {
              if (pred(recv[i])) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(recv[i]);
                return;
              }
            }
          }, 25);
          const timer = setTimeout(() => {
            clearInterval(poll);
            reject(new Error("timed out waiting for daemon message"));
          }, timeout);
        });
      const send = (obj: any) => clientWs.send(JSON.stringify({ hostId: dupHostId, ...obj }));

      const userTexts = async (sid: string): Promise<string[]> => {
        send({ type: "get_session", sessionId: sid, requestId: `gs-${Date.now()}` });
        const data = await waitFor((m) => m.type === "session_data" && m.session?.id === sid);
        // Raw Go structs ({text}) and Anthropic-style blocks ({type:"text",text}).
        return ((data.session.messages || []) as any[])
          .filter((m: any) => m.role === "user")
          .map((m: any) => ((m.content || []) as any[]).filter((b: any) => typeof b?.text === "string").map((b: any) => b.text).join(""));
      };
      // The resent turn retries its model call forever (no provider here);
      // observe the worst case over a few seconds instead of waiting for idle.
      const maxUserTextCount = async (sid: string, text: string): Promise<number> => {
        let max = 0;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const texts = await userTexts(sid);
          max = Math.max(max, texts.filter((t) => t === text).length);
          if (max >= 2) break;
          await Bun.sleep(150);
        }
        return max;
      };

      // Part 1: editing the first message and resending keeps it exactly once.
      send({ type: "create_session", cwd: workDir, title: "Dedup", model: "gpt-4o" });
      const created = await waitFor((m) => m.type === "session_created");
      const sid = created.session.id;
      // /help seeds [user, assistant] with no model call.
      send({ type: "prompt", sessionId: sid, text: "/help", model: "gpt-4o" });
      await waitFor((m) => m.type === "session_content" && m.sessionId === sid);
      send({ type: "edit_message", sessionId: sid, index: 0, text: "edited hello", regenerate: true });
      expect(await maxUserTextCount(sid, "edited hello")).toBe(1);

      // Part 2: regenerating from the assistant message resends the same user text once.
      send({ type: "create_session", cwd: workDir, title: "Dedup2", model: "gpt-4o" });
      const created2 = await waitFor((m) => m.type === "session_created" && m.session.id !== sid);
      const sid2 = created2.session.id;
      send({ type: "prompt", sessionId: sid2, text: "/help", model: "gpt-4o" });
      await waitFor((m) => m.type === "session_content" && m.sessionId === sid2);
      send({ type: "regenerate", sessionId: sid2, index: 1, model: "gpt-4o" });
      expect(await maxUserTextCount(sid2, "/help")).toBe(1);

      clientWs.close();
    } finally {
      // Always remove the host row so later tests see a clean slate.
      try {
        if (dupHostId) {
          await fetch(`${GW}/api/indirect-code/hosts/${dupHostId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${userToken}` },
          });
        }
      } catch {}
      try {
        daemonSubproc.kill();
      } catch {}
      try {
        rmSync(daemonData, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }, 60000);

  test("DELETE /api/indirect-code/hosts/:id removes host", async () => {
    const res = await fetch(`${GW}/api/indirect-code/hosts/${hostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);

    const listRes = await fetch(`${GW}/api/indirect-code/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const json = (await listRes.json()) as any;
    expect(json.hosts.length).toBe(0);
  });
});
