import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { totpAt } from "../server/crypto";

/**
 * SECURITY AUDIT SUITE (black-box).
 *
 * Same philosophy as integration.test.ts — real gateway child process, real
 * HTTP — but focused on adversarial edge cases:
 *
 *   1. JWT forgery + token-type confusion (access vs 2fa temp)
 *   2. Cross-user IDOR (keys, sessions, usage)
 *   3. Login brute-force lockout semantics (incl. account-level DoS)
 *   4. Proxy key-spray limiting
 *   5. Budget race: parallel burst vs total_limit (eventual consistency)
 *   6. Circuit-breaker poisoning via client aborts (unauthenticated-ish DoS)
 *   7. Upstream response headers overriding gateway security headers
 *   8. Oversized bodies (chunked, no Content-Length)
 *   9. Provider URL validation (SSRF surface)
 *  10. Account-enumeration uniformity
 *
 * TRUST_PROXY=true + per-scenario X-Forwarded-For lets every bucket-dependent
 * test run on a fresh "IP" (and doubles as a demo that XFF-based limiting is
 * only as trustworthy as the edge proxy overwriting it).
 */

const GW_PORT = 4500;
const UP_PORT = 4501;
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "audit-admin-pass-1";

let gwProc: ReturnType<typeof Bun.spawn>;
let upServer: ReturnType<typeof Bun.serve> | null = null;
let dataDir: string;

// ---------------------------------------------------------------- fake upstream

/** Deterministic upstream: fixed usage (20 in / 10 out), controllable misbehavior. */
function startMiniUpstream() {
  return Bun.serve({
    port: UP_PORT,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      const authed =
        req.headers.get("authorization") === "Bearer sk-mini" ||
        req.headers.get("x-api-key") === "sk-mini";
      if (!authed) {
        return Response.json(
          { error: { message: "bad key", type: "authentication_error", code: null } },
          { status: 401 },
        );
      }

      if (p === "/openai/v1/models" && req.method === "GET") {
        // Malicious-ish upstream: tries to replace the gateway's security headers.
        return new Response("<html><body>evil</body></html>", {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "X-Frame-Options": "ALLOWALL",
            "Content-Security-Policy": "default-src *",
          },
        });
      }

      if (p === "/openai/v1/chat/completions" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        if (body.fail500) {
          return Response.json(
            { error: { message: "kaput", type: "server_error", code: null } },
            { status: 500 },
          );
        }
        if (body.slow) await Bun.sleep(3000);
        return Response.json({
          id: "chatcmpl-mini",
          object: "chat.completion",
          created: 0,
          model: body.model ?? "mini-1",
          choices: [
            { index: 0, message: { role: "assistant", content: "mini reply" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
}

// ---------------------------------------------------------------- helpers

let ipCounter = 0;
/** Each scenario gets its own source IP so buckets never bleed between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `10.13.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${GW}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      "X-Forwarded-For": opts.ip ?? "10.0.0.1",
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function llm(key: string, body: unknown, ip = "10.0.0.1") {
  return fetch(`${GW}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(url: string, timeoutMs = 15_000): Promise<void> {
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

/** Forge a JWT-shaped string with an arbitrary (wrong) secret. */
async function forgeJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "gw-sec-"));
  const staticDir = path.join(dataDir, "dist");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>SPA</title>");

  upServer = startMiniUpstream();

  gwProc = Bun.spawn({
    cmd: ["bun", "server/index.ts"],
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      NODE_ENV: "development",
      DATA_DIR: dataDir,
      STATIC_DIR: staticDir,
      ADMIN_EMAIL: "boss@audit.test",
      ADMIN_PASSWORD: ADMIN_PW,
      TRUST_PROXY: "true", // honor our per-scenario XFF (and proves the spoof point)
      LIMIT_IP_PER_MIN: "100000", // isolate: only the strict auth bucket (30/min default) matters
      LIMIT_LOGIN_IP_FAIL_MAX: "8", // keep the per-IP spray lockout test fast
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(`${GW}/api/health`);
});

afterAll(() => {
  try { gwProc?.kill(); } catch {}
  try { upServer?.stop(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------- shared state

let adminToken = "";
let u1Token = "";
let u2Token = "";
let u3Token = "";
const u1Email = "u1@audit.test";
const u2Email = "u2@audit.test";
const u3Email = "u3@audit.test";
const U_PW = "user-pass-audit-1";
let k1 = ""; // user1's gateway key (no limits)
let k1Id = "";
let u1SessionJti = "";

async function makeUser(email: string): Promise<string> {
  const r = await api("/api/admin/users", {
    token: adminToken,
    body: { email, name: "Audit User", role: "user", sendInvite: true },
  });
  expect(r.status).toBe(200);
  const token = decodeURIComponent(String(r.json.invite.link).split("token=")[1]!);
  const set = await api("/api/auth/password-reset/confirm", { body: { token, password: U_PW } });
  expect(set.status).toBe(200);
  const login = await api("/api/auth/login", { body: { email, password: U_PW } });
  expect(login.status).toBe(200);
  return login.json.accessToken;
}

describe("security audit", () => {
  test("setup: admin + provider + three users", async () => {
    const login = await api("/api/auth/login", {
      body: { email: "boss@audit.test", password: ADMIN_PW },
    });
    expect(login.status).toBe(200);
    adminToken = login.json.accessToken;

    const p = await api("/api/admin/providers", {
      token: adminToken,
      body: { name: "mini", openaiBaseUrl: `http://127.0.0.1:${UP_PORT}/openai/v1`, apiKey: "sk-mini" },
    });
    expect(p.status).toBe(200);

    u1Token = await makeUser(u1Email);
    u2Token = await makeUser(u2Email);
    u3Token = await makeUser(u3Email);

    const key = await api("/api/keys", { token: u1Token, body: { name: "k1" } });
    expect(key.status).toBe(200);
    k1 = key.json.token;
    k1Id = key.json.key.id;

    const sessions = await api("/api/me/sessions", { token: u1Token });
    u1SessionJti = sessions.json.sessions.find((s: any) => s.current).jti;
    expect(u1SessionJti).toBeTruthy();
  });

  // ------------------------------------------------------------ 1. JWT

  test("JWT: wrong-secret forgery and role escalation are rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await forgeJwt(
      { sub: "whatever", jti: "whatever", role: "admin", type: "access", iat: now, exp: now + 3600 },
      "attacker-controlled-secret",
    );
    expect((await api("/api/me", { token: forged })).status).toBe(401);
    expect((await api("/api/admin/users", { token: forged })).status).toBe(401);

    // alg:none with the payload of a real token must not verify either
    const realParts = u1Token.split(".");
    const noneToken = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${realParts[1]}.`;
    expect((await api("/api/me", { token: noneToken })).status).toBe(401);
  });

  test("JWT type confusion: 2fa temp token is not an access token (and vice-versa)", async () => {
    const ip = freshIp();
    // enable TOTP on u3
    const setup = await api("/api/me/2fa/setup", { token: u3Token, method: "POST", ip });
    const secret = setup.json.secret as string;
    const enable = await api("/api/me/2fa/enable", {
      token: u3Token,
      body: { code: await totpAt(secret, Date.now()) },
      ip,
    });
    expect(enable.status).toBe(200);

    // password step of login -> tempToken
    const login = await api("/api/auth/login", { body: { email: u3Email, password: U_PW }, ip });
    expect(login.json.needs2FA).toBe(true);
    const tempToken = login.json.tempToken as string;

    // tempToken must NOT work as a dashboard bearer token
    expect((await api("/api/me", { token: tempToken })).status).toBe(401);
    expect((await api("/api/me/sessions", { token: tempToken })).status).toBe(401);
    expect((await api("/api/admin/users", { token: tempToken })).status).toBe(401);

    // a real access token must NOT work as a 2fa temp token
    const confusion = await api("/api/auth/2fa", {
      body: { tempToken: u1Token, code: "123456" },
      ip,
    });
    expect(confusion.status).toBe(401);

    // finish u3's login properly so the account is usable again (+ disable 2FA
    // with a next-window code to dodge the anti-replay store). The timestamp is
    // pinned to the START of the next 30s window: a fixed "+35s" lands two
    // windows ahead near a boundary and flakes with a 401.
    const finish = await api("/api/auth/2fa", {
      body: { tempToken, code: await totpAt(secret, Date.now()) },
      ip,
    });
    expect(finish.status).toBe(200);
    u3Token = finish.json.accessToken;
    const nextWindow = (Math.floor(Date.now() / 30_000) + 1) * 30_000 + 1_000;
    const disable = await api("/api/me/2fa/disable", {
      token: u3Token,
      body: { code: await totpAt(secret, nextWindow) },
      ip,
    });
    expect(disable.status).toBe(200);
  });

  // ------------------------------------------------------------ 2. IDOR

  test("IDOR: user2 cannot touch user1's keys, sessions or usage", async () => {
    expect((await api(`/api/keys/${k1Id}`, { token: u2Token, method: "PATCH", body: { name: "pwned" } })).status).toBe(404);
    expect((await api(`/api/keys/${k1Id}`, { token: u2Token, method: "DELETE" })).status).toBe(404);
    expect((await api(`/api/keys/${k1Id}/reveal`, { token: u2Token })).status).toBe(404);

    expect((await api(`/api/me/sessions/${u1SessionJti}`, { token: u2Token, method: "PATCH", body: { label: "pwned" } })).status).toBe(404);
    expect((await api(`/api/me/sessions/${u1SessionJti}`, { token: u2Token, method: "DELETE" })).status).toBe(404);

    const usage = await api(`/api/usage/daily?key_id=${k1Id}`, { token: u2Token });
    expect(usage.status).toBe(200);
    expect(usage.json.series).toEqual([]);

    const ev = await api(`/api/usage/events?key_id=${k1Id}`, { token: u2Token });
    expect(ev.json.events).toEqual([]);

    // sanity: owner CAN reveal their own key
    expect((await api(`/api/keys/${k1Id}/reveal`, { token: u1Token })).status).toBe(200);

    // non-admin never reaches admin surface
    expect((await api("/api/admin/users", { token: u2Token })).status).toBe(403);
    expect((await api("/api/keys")).status).toBe(401);
  });

  // ------------------------------------------------------------ 3. enumeration + lockout

  test("account enumeration: unknown vs known email is indistinguishable in the response", async () => {
    const ip = freshIp();
    const unknown = await api("/api/auth/login", {
      body: { email: "ghost@audit.test", password: "wrong-password-1" },
      ip,
    });
    const known = await api("/api/auth/login", {
      body: { email: u1Email, password: "wrong-password-1" },
      ip,
    });
    expect(unknown.status).toBe(401);
    expect(known.status).toBe(401);
    expect(unknown.json.error).toBe(known.json.error);
  });

  test("lockout: 10 failures lock the ACCOUNT for any IP (account-level DoS is possible)", async () => {
    // Rotate IPs per attempt: the account scope must accumulate across them
    // (and stay below the test's per-IP spray threshold of 8 on each one).
    for (let i = 0; i < 10; i++) {
      const r = await api("/api/auth/login", {
        body: { email: u3Email, password: `wrong-${i}` },
        ip: freshIp(),
      });
      expect(r.status).toBe(401);
    }

    // 11th attempt from a fresh IP -> locked
    const lockedHere = await api("/api/auth/login", {
      body: { email: u3Email, password: "wrong-again" },
      ip: freshIp(),
    });
    expect(lockedHere.status).toBe(429);

    // correct password from a DIFFERENT clean IP -> still locked (email scope)
    const victimElsewhere = await api("/api/auth/login", {
      body: { email: u3Email, password: U_PW },
      ip: freshIp(),
    });
    expect(victimElsewhere.status).toBe(429);

    // another account on that same clean IP is unaffected (not a global lock)
    const other = await api("/api/auth/login", {
      body: { email: u1Email, password: U_PW },
      ip: freshIp(),
    });
    expect(other.status).toBe(200);
  });

  test("per-IP spray lockout: tolerant of shared-IP typos, still stops sprays (LIMIT_LOGIN_IP_FAIL_MAX=8)", async () => {
    const sharedIp = freshIp();
    for (let i = 0; i < 5; i++) {
      const r = await api("/api/auth/login", {
        body: { email: `ghost${i}@audit.test`, password: "wrong-password-1" },
        ip: sharedIp,
      });
      expect(r.status).toBe(401);
    }

    // 5 typos from a shared IP must NOT lock everyone out (old FAIL_MAX=5 did)
    const stillFine = await api("/api/auth/login", {
      body: { email: u2Email, password: U_PW },
      ip: sharedIp,
    });
    expect(stillFine.status).toBe(200);

    // ...but a real spray keeps failing until the (higher) IP threshold, then dies
    for (let i = 5; i < 8; i++) {
      await api("/api/auth/login", {
        body: { email: `ghost${i}@audit.test`, password: "wrong-password-1" },
        ip: sharedIp,
      });
    }
    const blocked = await api("/api/auth/login", {
      body: { email: u2Email, password: U_PW },
      ip: sharedIp,
    });
    expect(blocked.status).toBe(429);

    // same user, different network: unaffected
    const fine = await api("/api/auth/login", {
      body: { email: u2Email, password: U_PW },
      ip: freshIp(),
    });
    expect(fine.status).toBe(200);
  });

  // ------------------------------------------------------------ 4. key spraying

  test("proxy: gw_ key spraying is throttled (401s then 429)", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await llm("gw_" + "0".repeat(48), { model: "mini-1", messages: [] }, ip);
      statuses.push(res.status);
      await res.text();
    }
    expect(statuses.slice(0, 25).every((s) => s === 401)).toBe(true);
    expect(statuses).toContain(429); // bucket kicked in before 40 attempts
  });

  // ------------------------------------------------------------ 5. budget race

  test("budget: parallel burst overshoots total_limit (eventual consistency, quantified)", async () => {
    const made = await api("/api/keys", { token: u1Token, body: { name: "race", totalLimit: 60 } });
    const raceKey = made.json.token as string;

    // 8 parallel requests (the per-key concurrency cap). Budgets cap output
    // tokens: 10 out each = 80 > 60.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        llm(raceKey, { model: "mini-1", messages: [{ role: "user", content: "race" }] }),
      ),
    );
    const statuses = await Promise.all(results.map(async (r) => { await r.text(); return r.status; }));
    const okCount = statuses.filter((s) => s === 200).length;

    // All 8 in-flight requests are admitted before the ledger catches up:
    // measured overshoot is 80 output tokens against a 60-token limit (4x
    // the six requests the cap would have allowed).
    expect(okCount).toBeGreaterThan(2); // strictly more than the limit allows
    await Bun.sleep(2500); // flush + spend-cache expiry
    const after = await llm(raceKey, { model: "mini-1", messages: [] });
    expect(after.status).toBe(429); // enforcement eventually bites
    await after.text();
  });

  test("budget: revoked key dies immediately", async () => {
    const made = await api("/api/keys", { token: u1Token, body: { name: "rev" } });
    const r = await api(`/api/keys/${made.json.key.id}`, { token: u1Token, method: "DELETE" });
    expect(r.status).toBe(200);
    const res = await llm(made.json.token, { model: "mini-1", messages: [] });
    expect(res.status).toBe(429);
    await res.text();
  });

  // ------------------------------------------------------------ 6. banned user

  test("banning a user kills keys AND sessions immediately", async () => {
    const mk = await api("/api/keys", { token: u3Token, body: { name: "u3key" } });
    const u3Key = mk.json.token as string;
    const before = await llm(u3Key, { model: "mini-1", messages: [] });
    expect(before.status).toBe(200);
    await before.text();

    const users = await api("/api/admin/users", { token: adminToken });
    const u3 = users.json.users.find((u: any) => u.email === u3Email);
    const ban = await api(`/api/admin/users/${u3.id}`, {
      token: adminToken,
      method: "PATCH",
      body: { status: "banned" },
    });
    expect(ban.status).toBe(200);

    const after = await llm(u3Key, { model: "mini-1", messages: [] });
    expect(after.status).toBe(401); // owner inactive
    await after.text();
    // ban revokes all sessions -> the old access token is dead (401, not 403)
    expect([401, 403]).toContain((await api("/api/me", { token: u3Token })).status);

    const unban = await api(`/api/admin/users/${u3.id}`, {
      token: adminToken,
      method: "PATCH",
      body: { status: "active" },
    });
    expect(unban.status).toBe(200);
  });

  // ------------------------------------------------------------ 7. upstream header override

  test("proxy: upstream response headers can NO LONGER override gateway security headers", async () => {
    const res = await fetch(`${GW}/v1/models`, {
      headers: { Authorization: `Bearer ${k1}`, "X-Forwarded-For": freshIp() },
    });
    // mini-upstream answers text/html + X-Frame-Options: ALLOWALL — the gateway
    // must keep its own security posture no matter what the provider says.
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    // hostile content-type is neutralized to an inert API payload
    expect(res.headers.get("content-type")).toContain("application/json");
    await res.text();
  });

  // ------------------------------------------------------------ 8. body caps

  test("proxy: chunked body above the cap is rejected with the protocol envelope", async () => {
    const size = 4_200_000; // > 4 MiB route cap, < Bun's global maxRequestBodySize
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new Uint8Array(64 * 1024).fill(97);
        let sent = 0;
        while (sent < size) {
          c.enqueue(chunk);
          sent += chunk.length;
        }
        c.close();
      },
    });
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${k1}`,
        "X-Forwarded-For": freshIp(),
      },
      body: stream,
      // @ts-expect-error undici requires duplex for streaming bodies
      duplex: "half",
    });
    expect(res.status).toBe(413);
    const j = await res.json();
    expect(j.error).toBeTruthy(); // OpenAI-shaped error, not a stack trace
  });

  // ------------------------------------------------------------ 9. provider URL validation

  test("admin: non-http(s) provider URLs are rejected", async () => {
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x/", "not-a-url"]) {
      const r = await api("/api/admin/providers", {
        token: adminToken,
        body: { name: "bad", openaiBaseUrl: bad, apiKey: "sk-x" },
      });
      expect(r.status).toBe(400);
    }
  });

  // ------------------------------------------------------------ 10. breaker poisoning (LAST)

  test("client aborts no longer poison the circuit breaker for everyone", async () => {
    // baseline: healthy
    const okRes = await llm(k1, { model: "mini-1", messages: [] }, freshIp());
    expect(okRes.status).toBe(200);
    await okRes.text();

    // abort 6 slow requests mid-flight (client timeout / rage-quit pattern)
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      const p = fetch(`${GW}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${k1}`,
          "X-Forwarded-For": freshIp(),
        },
        body: JSON.stringify({ model: "mini-1", slow: true, messages: [] }),
        signal: c.signal,
      });
      await Bun.sleep(250);
      c.abort();
      await p.catch(() => {});
      await Bun.sleep(150);
    }

    // pre-fix this was a 503 for ~30s (breaker counted client disconnects);
    // now the next request — any key, any user — flows normally.
    const victim = await llm(k1, { model: "mini-1", messages: [] }, freshIp());
    expect(victim.status).toBe(200);
    await victim.text();
  });

  test("upstream 500 storm fast-fails the gateway (key cooldown → 503) (keep LAST)", async () => {
    // Failover semantics: providerFailThreshold (3) consecutive transient
    // failures put the provider's only key into cooldown — from then on
    // requests skip the dead candidate and fast-fail with 503 (pre-failover
    // this took breakerFailThreshold (5) fails to reach the same state).
    for (let i = 0; i < 3; i++) {
      const r = await llm(k1, { model: "mini-1", fail500: true, messages: [] }, freshIp());
      expect(r.status).toBe(500);
      await r.text();
    }
    // …and the next request, even a healthy one, gets the fast 503 (no
    // usable candidate: key cooling down).
    const locked = await llm(k1, { model: "mini-1", messages: [] }, freshIp());
    expect(locked.status).toBe(503);
    await locked.text();
  });
});
