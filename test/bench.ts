/**
 * Load test: measures the overhead the gateway adds on top of the upstream.
 *
 *  1. baseline:  N requests directly against the fake upstream
 *  2. via proxy: N requests through the gateway (all guards active)
 *
 * Reports RPS + p50/p95/p99 latency for both, plus the computed overhead.
 *
 * Run: bun run bench
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const GW_PORT = 5450;
const UP_PORT = 5451;
const GW = `http://127.0.0.1:${GW_PORT}`;
const UP = `http://127.0.0.1:${UP_PORT}`;
const UPSTREAM_KEY = "sk-fake-secret";
const ADMIN_PW = "bench-password-123";
const REQUESTS = Number(process.env.BENCH_REQUESTS || 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY || 50);

function spawn(cmd: string, env: Record<string, string>) {
  return Bun.spawn({
    cmd: ["bun", cmd],
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function waitFor(url: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await Bun.sleep(100);
  }
}

async function api(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${GW}${path}`, {
    method: body !== undefined ? "POST" : "GET",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

interface Stats {
  wallMs: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  errors: number;   // 5xx + network errors (real failures)
  non2xx: number;   // includes 4xx (rate limiting, auth, etc)
}

async function hammer(url: string, init: RequestInit, count: number, concurrency: number): Promise<Stats> {
  const lat: number[] = [];
  let errors = 0;
  let non2xx = 0;
  const statusCount = new Map<number, number>();
  let idx = 0;
  const started = performance.now();

  async function worker() {
    while (idx < count) {
      const my = idx++;
      void my;
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        await res.text();
        statusCount.set(res.status, (statusCount.get(res.status) ?? 0) + 1);
        if (res.status >= 500) errors++;
        else if (res.status >= 300) non2xx++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - started;

  lat.sort((a, b) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!;
  const dist = [...statusCount.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(" ");
  console.log(`  statuses: ${dist}`);
  return {
    wallMs,
    rps: (lat.length / wallMs) * 1000,
    p50: q(50),
    p95: q(95),
    p99: q(99),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    errors,
    non2xx,
  };
}

function fmt(s: Stats): string {
  return `${s.rps.toFixed(0).padStart(7)} rps | p50 ${s.p50.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}ms  p99 ${s.p99.toFixed(2)}ms  max ${s.max.toFixed(1)}ms | non2xx ${s.non2xx}  err ${s.errors}`;
}

// ===== main =====

const upProc = spawn("test/fake-upstream.ts", {
  FAKE_UPSTREAM_PORT: String(UP_PORT),
  FAKE_UPSTREAM_KEY: UPSTREAM_KEY,
  FAKE_UPSTREAM_LATENCY: "5", // realistic upstream latency so both paths include it
});
const dataDir = mkdtempSync(path.join(tmpdir(), "gw-bench-"));
const gwProc = spawn("server/index.ts", {
  PORT: String(GW_PORT),
  NODE_ENV: "development",
  DATA_DIR: dataDir,
  ADMIN_EMAIL: "bench@example.com",
  ADMIN_PASSWORD: ADMIN_PW,
  LIMIT_IP_PER_MIN: "100000000",
  LIMIT_AUTH_PER_MIN: "100000000",
  DEFAULT_KEY_RPM: "100000000",
  DEFAULT_KEY_CONCURRENCY: "100000",
  STATIC_DIR: path.join(dataDir, "dist"),
});

try {
  await Promise.all([
    waitFor(`${GW}/api/health`),
    waitFor(`${UP}/openai/v1/models`, 20_000).catch(() =>
      fetch(`${UP}/openai/v1/models`, { headers: { Authorization: `Bearer ${UPSTREAM_KEY}` } }).then((r) => {
        if (!r.ok) throw new Error("upstream not ready");
      }),
    ),
  ]);

  // provision: admin -> provider -> user -> key
  const must = (cond: boolean, label: string, extra?: unknown) => {
    if (!cond) throw new Error(`provisioning failed at ${label}: ${JSON.stringify(extra)}`);
  };

  const login = await api("/api/auth/login", { email: "bench@example.com", password: ADMIN_PW });
  must(login.status === 200, "admin login", login.json);
  const adminToken = login.json.accessToken;

  const p = await api("/api/admin/providers", {
    name: "bench",
    openaiBaseUrl: `${UP}/openai/v1`,
    apiKey: UPSTREAM_KEY,
  }, adminToken);
  must(p.status === 200, "create provider", p.json);

  const userResp = await api("/api/admin/users", {
    email: "u@example.com", name: "U", role: "user", sendInvite: true,
  }, adminToken);
  const inviteToken = decodeURIComponent(String(userResp.json.invite.link).split("token=")[1]);
  await api("/api/auth/password-reset/confirm", { token: inviteToken, password: "bench-password-123" });
  const userLogin = await api("/api/auth/login", { email: "u@example.com", password: "bench-password-123" });
  const keyResp = await api("/api/keys", { name: "bench" }, userLogin.json.accessToken);
  const gwKey: string = keyResp.json.token;

  const body = JSON.stringify({
    model: "fake-llm-1",
    messages: [{ role: "user", content: "say hello" }],
  });

  console.log(`\n=== warm-up (200 reqs) ===`);
  await hammer(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gwKey}` },
    body,
  }, 200, 20);

  console.log(`\n=== DIRECT -> upstream (baseline)  N=${REQUESTS}, C=${CONCURRENCY} ===`);
  const direct = await hammer(`${UP}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${UPSTREAM_KEY}` },
    body,
  }, REQUESTS, CONCURRENCY);
  console.log(fmt(direct));

  console.log(`\n=== THROUGH gateway (auth+budgets+accounting)  N=${REQUESTS}, C=${CONCURRENCY} ===`);
  const proxied = await hammer(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gwKey}` },
    body,
  }, REQUESTS, CONCURRENCY);
  console.log(fmt(proxied));

  console.log(`\n=== THROUGH gateway, streaming  N=${Math.floor(REQUESTS / 4)}, C=${Math.min(20, CONCURRENCY)} ===`);
  const streamed = await hammer(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${gwKey}` },
    body: JSON.stringify({ model: "fake-llm-1", stream: true, messages: [{ role: "user", content: "say hello" }] }),
  }, Math.floor(REQUESTS / 4), Math.min(20, CONCURRENCY));
  console.log(fmt(streamed));

  const overhead = proxied.p50 - direct.p50;
  console.log(`\nGateway overhead vs direct upstream:`);
  console.log(`  p50 overhead: ${overhead.toFixed(2)}ms/req`);
  console.log(`  throughput:   ${((proxied.rps / direct.rps) * 100).toFixed(1)}% of baseline`);

  await Bun.sleep(1500); // flush usage before reading the counter
  const summary = await api("/api/usage/summary", undefined, userLogin.json.accessToken);
  console.log(`  usage rows recorded (user total reqs): ${summary.json.summary.total.reqs}`);

  if (proxied.errors > 0 || direct.errors > 0 || proxied.non2xx > 0 || streamed.non2xx > 0) {
    console.error("\nERRORS or unexpected non-2xx occurred during the bench — investigate.");
    process.exitCode = 1;
  }
} finally {
  try { gwProc.kill(); } catch {}
  try { upProc.kill(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
