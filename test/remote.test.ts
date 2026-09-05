import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
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

describe("Remote Code Relay and Pairing", () => {
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

  let pairingToken: string;
  let connectUrl: string;

  test("POST /api/remote/pair generates pairing token", async () => {
    const res = await fetch(`${GW}/api/remote/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.token).toBeDefined();
    expect(json.connectUrl).toContain(`/api/remote/connect/${json.token}`);
    pairingToken = json.token;
    connectUrl = json.connectUrl;
  });

  let hostId: string;
  let daemonToken: string;
  let daemonApiKey: string;

  test("POST /api/remote/connect/:token completes handshake", async () => {
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
    daemonApiKey = json.apiKey;

    // Second call with same token must fail (single-use)
    const replayRes = await fetch(connectUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(replayRes.status).toBe(401);
  });

  test("GET /api/remote/hosts lists registered host as offline", async () => {
    const res = await fetch(`${GW}/api/remote/hosts`, {
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

  test("WebSocket relay: Daemon connects and Web Client exchanges messages", async () => {
    // 1. Connect Daemon WebSocket
    const daemonWs = new WebSocket(`${GW_WS}/api/remote/daemon/ws?token=${daemonToken}`);
    await new Promise<void>((resolve, reject) => {
      daemonWs.onopen = () => resolve();
      daemonWs.onerror = (e) => reject(e);
    });

    // 2. Connect Client WebSocket
    const clientWs = new WebSocket(`${GW_WS}/api/remote/client/ws?token=${userToken}`);
    await new Promise<void>((resolve, reject) => {
      clientWs.onopen = () => resolve();
      clientWs.onerror = (e) => reject(e);
    });

    // Check host status via REST or wait for status notification
    await Bun.sleep(50);
    const hostListRes = await fetch(`${GW}/api/remote/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const hostsJson = (await hostListRes.json()) as any;
    expect(hostsJson.hosts[0].status).toBe("online");

    // 3. Client sends a command for Daemon: list_sessions
    const daemonReceivedPromise = new Promise<any>((resolve) => {
      daemonWs.onmessage = (ev) => {
        resolve(JSON.parse(String(ev.data)));
      };
    });

    clientWs.send(
      JSON.stringify({
        type: "list_sessions",
        hostId,
      }),
    );

    const daemonReceived = await daemonReceivedPromise;
    expect(daemonReceived.type).toBe("list_sessions");
    expect(daemonReceived.hostId).toBe(hostId);

    // 4. Daemon replies with session_list
    const clientReceivedPromise = new Promise<any>((resolve) => {
      clientWs.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "session_list") resolve(msg);
      };
    });

    daemonWs.send(
      JSON.stringify({
        type: "session_list",
        hostId,
        sessions: [
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
    expect(clientReceived.type).toBe("session_list");
    expect(clientReceived.sessions.length).toBe(1);
    expect(clientReceived.sessions[0].id).toBe("sess_test_1");

    daemonWs.close();
    clientWs.close();
    await Bun.sleep(50);
  });

  test("Real Go Daemon binary: pairs via CLI --connect and serves session lifecycle", async () => {
    // 1. Generate pairing token
    const pairRes = await fetch(`${GW}/api/remote/pair`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const pairJson = (await pairRes.json()) as any;
    expect(pairJson.success).toBe(true);

    // 2. Temp directories for daemon data and work dir
    const daemonData = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-test-"));
    const workDir = mkdtempSync(path.join(tmpdir(), "llmgw-daemon-work-"));

    const daemonBin = path.join(import.meta.dir, "../remote-code-daemon/bin/llmgw-daemon");

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
        const hRes = await fetch(`${GW}/api/remote/hosts`, {
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
      const clientWs = new WebSocket(`${GW_WS}/api/remote/client/ws?token=${userToken}`);
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

      // List sessions via WebSocket
      const listPromise = new Promise<any>((resolve) => {
        clientWs.onmessage = (ev) => {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "sessions_list") resolve(msg);
        };
      });

      clientWs.send(
        JSON.stringify({
          hostId: realHostId,
          type: "list_sessions",
        }),
      );

      const listMsg = await listPromise;
      expect(listMsg.type).toBe("sessions_list");
      expect(listMsg.sessions.length).toBeGreaterThanOrEqual(1);
      expect(listMsg.sessions.some((s: any) => s.id === createdMsg.session.id)).toBe(true);

      // Clean up host
      clientWs.close();
      const delRes = await fetch(`${GW}/api/remote/hosts/${realHostId}`, {
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

  test("DELETE /api/remote/hosts/:id removes host", async () => {
    const res = await fetch(`${GW}/api/remote/hosts/${hostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(200);

    const listRes = await fetch(`${GW}/api/remote/hosts`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const json = (await listRes.json()) as any;
    expect(json.hosts.length).toBe(0);
  });
});

