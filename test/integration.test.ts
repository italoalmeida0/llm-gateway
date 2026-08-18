import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { totpAt } from "../server/crypto";

/**
 * Black-box integration suite (farm-game "audit" style): the gateway and the
 * fake upstream are spawned as real child processes and everything is driven
 * over HTTP — the same way an attacker or a real client would talk to it.
 */

const GW_PORT = 4400;
const UP_PORT = 4401;
const GW = `http://127.0.0.1:${GW_PORT}`;
const UP = `http://127.0.0.1:${UP_PORT}`;
const UPSTREAM_KEY = "sk-fake-secret";
const ADMIN_PW = "admin-password-123";

let gwProc: ReturnType<typeof Bun.spawn>;
let upProc: ReturnType<typeof Bun.spawn>;
let dataDir: string;

function spawn(cmd: string, env: Record<string, string>) {
  return Bun.spawn({
    cmd: ["bun", cmd],
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
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

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`${GW}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function llm(pathname: string, key: string, body: unknown, anthropicStyle = false) {
  const res = await fetch(`${GW}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anthropicStyle
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });
  return res;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "gw-it-"));
  const staticDir = path.join(dataDir, "dist");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>SPA</title><h1>dash</h1>");
  writeFileSync(path.join(staticDir, "terms.html"), "<!doctype html><title>terms</title>");
  writeFileSync(path.join(staticDir, ".secret-file"), "should never be served");

  upProc = spawn("test/fake-upstream.ts", { FAKE_UPSTREAM_PORT: String(UP_PORT), FAKE_UPSTREAM_KEY: UPSTREAM_KEY });
  gwProc = spawn("server/index.ts", {
    PORT: String(GW_PORT),
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    ADMIN_EMAIL: "boss@example.com",
    ADMIN_PASSWORD: ADMIN_PW,
    LIMIT_IP_PER_MIN: "100000",
    LIMIT_AUTH_PER_MIN: "100000",
    STATIC_DIR: staticDir,
  });
  await waitFor(`${GW}/api/health`);
});

afterAll(() => {
  try { gwProc?.kill(); } catch {}
  try { upProc?.kill(); } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// Shared state across the ordered steps.
let adminToken = "";
let userToken = "";
let userEmail = "friend@example.com";
const userPw = "user-password-xyz";
let gatewayKey = "";
let totpSecret = "";
let userRefresh = "";

describe("gateway end-to-end", () => {

  test("health is public", async () => {
    const r = await api("/api/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  test("admin bootstrap + login with wrong/right password", async () => {
    const bad = await api("/api/auth/login", { body: { email: "boss@example.com", password: "wrong-password-1" } });
    expect(bad.status).toBe(401);

    const good = await api("/api/auth/login", { body: { email: "boss@example.com", password: ADMIN_PW } });
    expect(good.status).toBe(200);
    expect(good.json.accessToken).toBeTruthy();
    expect(good.json.user.role).toBe("admin");
    adminToken = good.json.accessToken;
  });

  test("dashboard API rejects missing/invalid bearer", async () => {
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/me", { token: "not.a.token" })).status).toBe(401);
  });

  test("user cannot reach admin routes", async () => {
    // create non-admin first (invite flow) happens below; here use a forged admin check with user token once we have it
    const r = await api("/api/admin/users", { token: adminToken });
    expect(r.status).toBe(200); // sanity for later contrast
  });

  test("admin configures provider (openai + anthropic) and tests connection", async () => {
    const r = await api("/api/admin/providers", {
      token: adminToken,
      body: {
        name: "provider",
        openaiBaseUrl: `${UP}/openai/v1`,
        anthropicBaseUrl: `${UP}/anthropic/v1`,
        apiKey: UPSTREAM_KEY,
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.provider.openaiBaseUrl).toContain("/openai/v1");
    const providerId0 = r.json.provider.id as string;

    // dual-surface creation does NOT import: it previews both /models lists
    // and the admin picks the import mode afterwards
    expect(r.json.sync).toBeUndefined();
    expect(r.json.preview.openai.count).toBe(1);
    expect(r.json.preview.anthropic.count).toBe(1);
    expect(r.json.preview.common).toBe(1);

    // an invalid import mode is rejected
    expect(
      (
        await api(`/api/admin/providers/${providerId0}/sync-models`, {
          token: adminToken, method: "POST", body: { mode: "junk" },
        })
      ).status,
    ).toBe(400);

    // mode "both": every listed model serves both protocol surfaces
    const imp = await api(`/api/admin/providers/${providerId0}/sync-models`, {
      token: adminToken, method: "POST", body: { mode: "both" },
    });
    expect(imp.status).toBe(200);
    expect(imp.json.sync.openai).toEqual({ added: 1, skipped: 0, merged: 0 });
    expect(imp.json.sync.anthropic).toEqual({ added: 0, skipped: 1, merged: 0 });

    const t = await api(`/api/admin/providers/${r.json.provider.id}/test`, { token: adminToken, method: "POST" });
    expect(t.status).toBe(200);
    expect(t.json.results.openai.reachable).toBe(true);
    expect(t.json.results.anthropic.reachable).toBe(true);
    // smoke now also returns the upstream model list
    expect(t.json.results.openai.models).toContain("fake-llm-1");

    // chat probe: sends a real "Hello" through the openai capability
    const probe = await api(`/api/admin/providers/${r.json.provider.id}/test`, {
      token: adminToken,
      method: "POST",
      body: { cap: "openai", model: "fake-llm-1" },
    });
    expect(probe.status).toBe(200);
    expect(probe.json.results.openai.status).toBe(200);
    expect(String(probe.json.results.openai.reply)).toContain("fake upstream");

    // probe via anthropic capability works too
    const probe2 = await api(`/api/admin/providers/${r.json.provider.id}/test`, {
      token: adminToken,
      method: "POST",
      body: { cap: "anthropic", model: "fake-llm-1" },
    });
    expect(probe2.status).toBe(200);
    expect(probe2.json.results.anthropic.status).toBe(200);
  });

  test("provider secret is never exposed in admin API", async () => {
    const r = await api("/api/admin/providers", { token: adminToken });
    const raw = JSON.stringify(r.json);
    expect(raw).not.toContain(UPSTREAM_KEY);
    expect(r.json.providers[0].hasApiKey).toBe(true);
  });

  test("invite flow: admin creates user, user sets password via token link", async () => {
    const r = await api("/api/admin/users", {
      token: adminToken,
      body: { email: userEmail, name: "Friend", role: "user", sendInvite: true },
    });
    expect(r.status).toBe(200);
    expect(r.json.invite.sent).toBe(false); // SMTP not configured in test
    expect(String(r.json.invite.link)).toContain("token=");
    const token = decodeURIComponent(String(r.json.invite.link).split("token=")[1]);

    const bad = await api("/api/auth/password-reset/confirm", { body: { token, password: "short" } });
    expect(bad.status).toBe(400);

    const set = await api("/api/auth/password-reset/confirm", { body: { token, password: userPw } });
    expect(set.status).toBe(200);

    // token is single-use
    const again = await api("/api/auth/password-reset/confirm", { body: { token, password: userPw } });
    expect(again.status).toBe(400);

    const login = await api("/api/auth/login", { body: { email: userEmail, password: userPw } });
    expect(login.status).toBe(200);
    expect(login.json.user.role).toBe("user");
    userToken = login.json.accessToken;

    // admin routes off-limits for the user
    expect((await api("/api/admin/users", { token: userToken })).status).toBe(403);
  });

  test("sessions can be named (label survives listing)", async () => {
    const list = await api("/api/me/sessions", { token: userToken });
    expect(list.status).toBe(200);
    const cur = list.json.sessions.find((s: any) => s.current);
    expect(cur).toBeTruthy();
    expect(cur.ip).not.toBe("unknown"); // real client IP is recorded

    const p = await api(`/api/me/sessions/${cur.jti}`, {
      token: userToken,
      method: "PATCH",
      body: { label: "test laptop" },
    });
    expect(p.status).toBe(200);

    const again = await api("/api/me/sessions", { token: userToken });
    expect(again.json.sessions.find((s: any) => s.jti === cur.jti)?.label).toBe("test laptop");
  });

  test("user creates API key and gets plaintext once", async () => {
    const r = await api("/api/keys", {
      token: userToken,
      body: { name: "my-first", totalLimit: 1_000_000 },
    });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^gw_[a-f0-9]{48}$/);
    gatewayKey = r.json.token;

    const list = await api("/api/keys", { token: userToken });
    expect(list.json.keys).toHaveLength(1);
    expect(JSON.stringify(list.json)).not.toContain(gatewayKey); // never re-exposed
  });

  test("keys can be hard-deleted (gone from list, stops authenticating)", async () => {
    const c = await api("/api/keys", { token: userToken, body: { name: "ephemeral" } });
    expect(c.status).toBe(200);

    const d = await api(`/api/keys/${c.json.key.id}?hard=true`, { token: userToken, method: "DELETE" });
    expect(d.status).toBe(200);
    expect(d.json.deleted).toBe(true);

    const list = await api("/api/keys", { token: userToken });
    expect(list.json.keys.find((k: any) => k.id === c.json.key.id)).toBeUndefined();

    const res = await llm("/v1/chat/completions", c.json.token, { model: "fake-llm-1", messages: [] });
    expect(res.status).toBe(401);
  });

  test("key token can be revealed/сopied later by owner and admin", async () => {
    const c = await api("/api/keys", { token: userToken, body: { name: "revealable" } });
    expect(c.status).toBe(200);

    const r = await api(`/api/keys/${c.json.key.id}/reveal`, { token: userToken });
    expect(r.status).toBe(200);
    expect(r.json.token).toBe(c.json.token);

    const ra = await api(`/api/admin/keys/${c.json.key.id}/reveal`, { token: adminToken });
    expect(ra.status).toBe(200);
    expect(ra.json.token).toBe(c.json.token);

    // admin can hard-delete too
    const d = await api(`/api/admin/keys/${c.json.key.id}?hard=true`, { token: adminToken, method: "DELETE" });
    expect(d.status).toBe(200);
    expect(d.json.deleted).toBe(true);
  });

  test("proxy: OpenAI non-stream works and reports usage", async () => {
    const res = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "hello gateway" }],
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.choices[0].message.content).toContain("fake upstream");
    expect(j.usage.prompt_tokens).toBeGreaterThan(0);
  });

  test("proxy: OpenAI streaming is relayed as SSE", async () => {
    const res = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("chat.completion.chunk");
    expect(body).toContain('"usage"'); // injected include_usage
    expect(body).toContain("[DONE]");
  });

  test("proxy: Anthropic non-stream + stream", async () => {
    const res = await llm(
      "/v1/messages",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, messages: [{ role: "user", content: "hi anthropic" }] },
      true,
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.type).toBe("message");
    expect(j.usage.input_tokens).toBeGreaterThan(0);

    const rs = await llm(
      "/v1/messages",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi again" }] },
      true,
    );
    expect(rs.status).toBe(200);
    const body = await rs.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("text_delta");
  });

  test("proxy: both header styles authenticate on both protocols", async () => {
    // x-api-key on the OpenAI endpoint (native style is Bearer)
    const r1 = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": gatewayKey },
      body: JSON.stringify({ model: "fake-llm-1", messages: [{ role: "user", content: "x-api-key auth" }] }),
    });
    expect(r1.status).toBe(200);

    // Authorization: Bearer on the Anthropic endpoint (native style is x-api-key)
    const r2 = await fetch(`${GW}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${gatewayKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "fake-llm-1",
        max_tokens: 100,
        messages: [{ role: "user", content: "bearer auth" }],
      }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.type).toBe("message");
  });

  test("prefixed routes route directionally: /openai/v1 and /anthropic/v1", async () => {
    // openai prefix: non-stream chat completion
    const r1 = await llm("/openai/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "prefixed openai" }],
    });
    expect(r1.status).toBe(200);
    expect((await r1.json()).choices[0].message.content).toContain("fake upstream");

    // openai prefix: stream still gets the injected usage chunk
    const r2 = await llm("/openai/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "prefixed stream" }],
      stream: true,
    });
    expect(r2.status).toBe(200);
    expect(r2.headers.get("content-type")).toContain("text/event-stream");
    const body2 = await r2.text();
    expect(body2).toContain('"usage"');
    expect(body2.trimEnd().endsWith("data: [DONE]")).toBe(true);

    // anthropic prefix: non-stream + stream + count_tokens
    const r3 = await llm(
      "/anthropic/v1/messages",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, messages: [{ role: "user", content: "prefixed anthropic" }] },
      true,
    );
    expect(r3.status).toBe(200);
    expect((await r3.json()).type).toBe("message");

    const r4 = await llm(
      "/anthropic/v1/messages",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, stream: true, messages: [{ role: "user", content: "prefixed stream" }] },
      true,
    );
    expect(r4.status).toBe(200);
    const body4 = await r4.text();
    expect(body4).toContain("event: message_start");
    expect(body4.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);

    const r5 = await llm(
      "/anthropic/v1/messages/count_tokens",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, messages: [{ role: "user", content: "count me" }] },
      true,
    );
    expect(r5.status).toBe(200);
    expect((await r5.json()).input_tokens).toBeGreaterThan(0);

    // wrong-protocol paths under a prefix do NOT route (directional means strict)
    const cross1 = await llm("/openai/v1/messages", gatewayKey, { model: "fake-llm-1", max_tokens: 1, messages: [] }, true);
    expect(cross1.status).toBe(404);
    expect((await cross1.json()).error.type).toBe("invalid_request_error"); // openai envelope

    const cross2 = await llm("/anthropic/v1/chat/completions", gatewayKey, { model: "fake-llm-1", messages: [] });
    expect(cross2.status).toBe(404);
    expect((await cross2.json()).type).toBe("error"); // anthropic envelope

    // models listing: prefix forces the protocol, no auth-header guessing needed
    const m1 = await fetch(`${GW}/anthropic/v1/models`, { headers: { Authorization: `Bearer ${gatewayKey}` } });
    expect(m1.status).toBe(200);
    expect((await m1.json()).data[0].type).toBe("model"); // anthropic shape

    const m2 = await fetch(`${GW}/openai/v1/models`, { headers: { "x-api-key": gatewayKey } });
    expect(m2.status).toBe(200);
    expect((await m2.json()).object).toBe("list"); // openai shape
  });

  test("request body passes through byte-identical when usable as-is", async () => {
    // Ugly-but-valid JSON with whitespace; the client already opted into
    // usage reporting, so the gateway must not re-serialize a single byte.
    const raw = `{\n  "model": "fake-llm-1",\n  "stream": true,\n  "stream_options": { "include_usage": true },\n  "messages": [ { "role": "user", "content": "byte fidelity" } ]\n}`;
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayKey}` },
      body: raw,
    });
    expect(res.status).toBe(200);
    await res.text();
    const last = await fetch(`${UP}/__last-body`).then((r) => r.json());
    expect(last.body).toBe(raw);
  });

  test("the only mutation is stream_options.include_usage on openai streams", async () => {
    const res = await llm("/openai/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "mutation check" }],
      stream: true,
    });
    expect(res.status).toBe(200);
    await res.text();
    const last = await fetch(`${UP}/__last-body`).then((r) => r.json());
    const forwarded = JSON.parse(last.body);
    expect(forwarded.stream_options).toEqual({ include_usage: true });
    expect(forwarded.messages[0].content).toBe("mutation check");

    // non-stream bodies are never touched
    const raw = `{"model":"fake-llm-1","messages":[{ "role":"user","content":"leave me alone" }]}`;
    const res2 = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayKey}` },
      body: raw,
    });
    expect(res2.status).toBe(200);
    await res2.text();
    const last2 = await fetch(`${UP}/__last-body`).then((r) => r.json());
    expect(last2.body).toBe(raw);
  });

  test("non-stream response body is the upstream's exact payload", async () => {
    const payload = { model: "fake-llm-1", messages: [{ role: "user", content: "fidelity" }] };
    const res = await llm("/openai/v1/chat/completions", gatewayKey, payload);
    expect(res.status).toBe(200);
    const direct = await fetch(`${UP}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${UPSTREAM_KEY}` },
      body: JSON.stringify(payload),
    });
    const viaGw = (await res.json()) as any;
    const upstream = (await direct.json()) as any;
    delete viaGw.created;
    delete upstream.created; // wall-clock seconds can differ between the two calls
    expect(viaGw).toEqual(upstream);
  });

  test("cached input tokens get their own bucket, separate from uncached input", async () => {
    const made = await api("/api/keys", { token: userToken, body: { name: "cache-audit" } });
    const key = made.json.token;
    const keyId = made.json.key.id;

    // openai non-stream: provider reports the cached share inside prompt_tokens
    const r1 = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      __cached_tokens: 9,
      messages: [{ role: "user", content: "cached non-stream prompt, reasonably long" }],
    });
    expect(r1.status).toBe(200);
    const j1 = await r1.json();
    expect(j1.usage.prompt_tokens_details.cached_tokens).toBe(9);

    // openai stream: same via the terminal usage chunk
    const r2 = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      stream: true,
      __cached_tokens: 11,
      messages: [{ role: "user", content: "cached stream prompt, also reasonably long" }],
    });
    expect(r2.status).toBe(200);
    const sse2 = await r2.text();
    const usageLine = sse2.split("\n").find((l) => l.startsWith("data:") && l.includes("prompt_tokens_details"));
    expect(usageLine).toBeTruthy();
    const streamedUsage = JSON.parse(usageLine!.slice(5)).usage;
    expect(streamedUsage.prompt_tokens_details.cached_tokens).toBe(11);

    // anthropic stream: input_tokens is already cache-free upstream; cache
    // read + creation go into the cache bucket on the side.
    const r3 = await llm(
      "/v1/messages",
      key,
      {
        model: "fake-llm-1",
        max_tokens: 100,
        stream: true,
        __cached_tokens: 7,
        messages: [{ role: "user", content: "cached anthropic prompt, reasonably long" }],
      },
      true,
    );
    expect(r3.status).toBe(200);
    const sse3 = await r3.text();
    const startLine = sse3.split("\n").find((l) => l.startsWith("data:") && l.includes("cache_read_input_tokens"));
    expect(startLine).toBeTruthy();
    const msgStart = JSON.parse(startLine!.slice(5)).message;
    expect(msgStart.usage.cache_read_input_tokens).toBe(7);

    await Bun.sleep(1500); // let the usage buffer flush
    const ev = await api(`/api/usage/events?key_id=${keyId}&limit=10`, { token: userToken });
    expect(ev.status).toBe(200);
    expect(ev.json.events).toHaveLength(3);

    const nonStream = ev.json.events.find((e: any) => e.proto === "openai" && e.stream === 0);
    expect(nonStream.in_tok).toBe(j1.usage.prompt_tokens - 9);
    expect(nonStream.in_tok).toBeGreaterThan(0);
    expect(nonStream.cache_tok).toBe(9); // the cached share is its own bucket

    const stream = ev.json.events.find((e: any) => e.proto === "openai" && e.stream === 1);
    expect(stream.in_tok).toBe(streamedUsage.prompt_tokens - 11);
    expect(stream.in_tok).toBeGreaterThan(0);
    expect(stream.cache_tok).toBe(11);

    const anth = ev.json.events.find((e: any) => e.proto === "anthropic");
    expect(anth.in_tok).toBe(msgStart.usage.input_tokens); // uncached share
    expect(anth.cache_tok).toBe(7 + 3); // cache_read 7 + cache_creation 3
  });

  test("provider auth styles are honored per capability", async () => {
    const list = await api("/api/admin/providers", { token: adminToken });
    const pid = list.json.providers[0].id;

    // bad style value is rejected
    const bad = await api(`/api/admin/providers/${pid}`, {
      token: adminToken,
      method: "PATCH",
      body: { openaiAuthStyle: "token" },
    });
    expect(bad.status).toBe(400);

    // flip the openai capability to x-api-key
    const p1 = await api(`/api/admin/providers/${pid}`, {
      token: adminToken,
      method: "PATCH",
      body: { openaiAuthStyle: "x-api-key" },
    });
    expect(p1.status).toBe(200);
    expect(p1.json.provider.openaiAuthStyle).toBe("x-api-key");

    const r1 = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "auth style probe" }],
    });
    expect(r1.status).toBe(200);
    let last = await fetch(`${UP}/__last-auth`).then((r) => r.json());
    expect(last["x-api-key"]).toBe(UPSTREAM_KEY);
    expect(last.authorization).toBeNull();

    // flip the anthropic capability to bearer
    const p2 = await api(`/api/admin/providers/${pid}`, {
      token: adminToken,
      method: "PATCH",
      body: { anthropicAuthStyle: "bearer" },
    });
    expect(p2.status).toBe(200);
    expect(p2.json.provider.anthropicAuthStyle).toBe("bearer");

    const r2 = await llm(
      "/v1/messages",
      gatewayKey,
      { model: "fake-llm-1", max_tokens: 100, messages: [{ role: "user", content: "bearer probe" }] },
      true,
    );
    expect(r2.status).toBe(200);
    last = await fetch(`${UP}/__last-auth`).then((r) => r.json());
    expect(last.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(last["x-api-key"]).toBeNull();

    // restore defaults for the rest of the suite
    const back = await api(`/api/admin/providers/${pid}`, {
      token: adminToken,
      method: "PATCH",
      body: { openaiAuthStyle: "bearer", anthropicAuthStyle: "x-api-key" },
    });
    expect(back.status).toBe(200);
  });

  test("usage accounting shows up for the user", async () => {
    await Bun.sleep(1500); // let the usage buffer flush
    const r = await api("/api/usage/summary", { token: userToken });
    expect(r.status).toBe(200);
    expect(r.json.summary.total.reqs).toBeGreaterThanOrEqual(4);
    expect(r.json.summary.total.in_tok + r.json.summary.total.out_tok).toBeGreaterThan(0);
    // the three buckets are tracked separately (9 + 11 + 10 from the cache test)
    expect(r.json.summary.total.cache_tok).toBeGreaterThanOrEqual(30);

    const daily = await api("/api/usage/daily?days=7", { token: userToken });
    expect(daily.json.series.length).toBeGreaterThanOrEqual(1);

    // by-model aggregation
    const bm = await api("/api/usage/by-model?days=7", { token: userToken });
    expect(bm.status).toBe(200);
    const m = bm.json.models.find((x: any) => x.model === "fake-llm-1");
    expect(m).toBeTruthy();
    expect(m.reqs).toBeGreaterThan(0);
    expect(m.in_tok + m.cache_tok + m.out_tok).toBeGreaterThan(0);
  });

  test("usage carries the upstream provider dimension", async () => {
    // /api/usage/breakdown — fine-grained per model × provider × upstream key
    const bd = await api("/api/usage/breakdown?days=7", { token: userToken });
    expect(bd.status).toBe(200);
    const rows = bd.json.rows;
    expect(rows.length).toBeGreaterThan(0);
    const modelRow = rows.find((x: any) => x.model === "fake-llm-1");
    expect(modelRow).toBeTruthy();
    expect(modelRow.key_name).toBeTruthy();
    // the passthrough test provider routed the request → a real provider id
    expect(modelRow.provider_id).toBeTruthy();
    expect(modelRow.provider_name).toBeTruthy();
    expect(modelRow.in_tok + modelRow.cache_tok + modelRow.out_tok).toBeGreaterThan(0);

    // events resolve provider ids/names server-side
    const ev = await api("/api/usage/events?limit=20", { token: userToken });
    expect(ev.status).toBe(200);
    expect(ev.json.events.length).toBeGreaterThan(0);
    expect(ev.json.events[0].provider_id).toBeTruthy();
    expect(ev.json.events[0].provider_name).toBeTruthy();

    // admin global breakdown: per-user aggregate + detailed model rows
    const ab = await api("/api/admin/usage-breakdown?days=7", { token: adminToken });
    expect(ab.status).toBe(200);
    expect(ab.json.users.length).toBeGreaterThan(0);
    expect(ab.json.users[0].email).toBeTruthy();
    expect(ab.json.users[0].reqs).toBeGreaterThan(0);
    const am = ab.json.models.find((x: any) => x.model === "fake-llm-1");
    expect(am).toBeTruthy();
    expect(am.provider_id).toBeTruthy();
    expect(am.provider_name).toBeTruthy();
    expect(am.reqs).toBeGreaterThan(0);

    // provider filter narrows both admin views to that provider
    const pid = am.provider_id as string;
    const filtered = await api(`/api/admin/usage-breakdown?days=7&provider_id=${pid}`, {
      token: adminToken,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.json.models.length).toBeGreaterThan(0);
    for (const m of filtered.json.models) expect(m.provider_id).toBe(pid);
    for (const u of filtered.json.users) expect(u.reqs).toBeGreaterThan(0);

    // bogus key ids / user ids stay scoped (return empty, never leak)
    const badKey = await api("/api/usage/breakdown?days=7&key_id=not-a-key", { token: userToken });
    expect(badKey.json.rows).toEqual([]);
    const badUser = await api("/api/admin/usage-breakdown?days=7&user_id=ghost", {
      token: adminToken,
    });
    expect(badUser.json.users.length).toBe(0);
    expect(badUser.json.models.length).toBe(0);

    // days=all supports the full window
    const all = await api("/api/usage/breakdown?days=all", { token: userToken });
    expect(all.status).toBe(200);
    expect(all.json.rows.length).toBeGreaterThanOrEqual(bd.json.rows.length);
  });

  test("hour granularity endpoints feed the 1D views", async () => {
    const r = await api("/api/usage/daily?hours=24", { token: userToken });
    expect(r.status).toBe(200);
    expect(r.json.granularity).toBe("hour");
    expect(r.json.series).toHaveLength(24);
    for (const p of r.json.series) expect(p.label).toMatch(/^\d{2}:00$/);
    // zero-filled window, but today's real traffic must be inside it
    expect(r.json.series.some((p: any) => p.reqs > 0)).toBe(true);
    expect(
      r.json.series.reduce((s: number, p: any) => s + p.in_tok + p.out_tok, 0),
    ).toBeGreaterThan(0);

    // key-scoped hourly view returns a longer trailing window when asked
    const list = await api("/api/keys", { token: userToken });
    const r48 = await api(`/api/usage/daily?hours=48&key_id=${list.json.keys[0].id}`, {
      token: userToken,
    });
    expect(r48.status).toBe(200);
    expect(r48.json.series).toHaveLength(48);

    // garbage hours clamp to the max (168h), never explode
    const clamped = await api("/api/usage/daily?hours=99999", { token: userToken });
    expect(clamped.json.series).toHaveLength(168);

    // admin global stats: hourly series + windowed top lists
    const as = await api("/api/admin/stats?hours=24", { token: adminToken });
    expect(as.status).toBe(200);
    expect(as.json.granularity).toBe("hour");
    expect(as.json.series).toHaveLength(24);
    expect(as.json.series.some((p: any) => p.reqs > 0)).toBe(true);
    expect(as.json.perUser.length).toBeGreaterThan(0);
    expect(as.json.perUser[0].email).toBeTruthy();

    // day granularity stays the default and is untouched
    const dd = await api("/api/admin/stats?days=7", { token: adminToken });
    expect(dd.json.granularity).toBe("day");
    expect(dd.json.series[0].label).toBeUndefined();
  });

  test("the unbounded all-time window (days=all) serves the full history", async () => {
    // every byte of test traffic is from today, so "all" must cover at least
    // as much as the bounded windows — on both user and admin surfaces
    const list = await api("/api/keys", { token: userToken });
    const bounded = await api("/api/usage/daily?days=7", { token: userToken });
    const all = await api("/api/usage/daily?days=all", { token: userToken });
    expect(all.status).toBe(200);
    expect(all.json.granularity).toBe("day");
    expect(all.json.series.length).toBeGreaterThanOrEqual(bounded.json.series.length);

    const keyAll = await api(`/api/usage/daily?days=all&key_id=${list.json.keys[0].id}`, {
      token: userToken,
    });
    expect(keyAll.status).toBe(200);
    expect(keyAll.json.series.some((p: any) => p.reqs > 0)).toBe(true);

    const allModels = await api("/api/usage/by-model?days=all", { token: userToken });
    expect(allModels.status).toBe(200);
    expect(allModels.json.models.length).toBeGreaterThan(0);

    const as7 = await api("/api/admin/stats?days=7", { token: adminToken });
    const as = await api("/api/admin/stats?days=all", { token: adminToken });
    expect(as.status).toBe(200);
    expect(as.json.granularity).toBe("day");
    expect(as.json.series.length).toBeGreaterThanOrEqual(as7.json.series.length);
    const reqsOf = (rows: any[]) => rows.reduce((s: number, p: any) => s + p.reqs, 0);
    expect(reqsOf(as.json.series)).toBeGreaterThanOrEqual(reqsOf(as7.json.series));
    expect(as.json.perUser.length).toBeGreaterThan(0);
    expect(as.json.perModel.length).toBeGreaterThan(0);
  });

  test("bad keys get protocol-shaped errors", async () => {
    const bad1 = await llm("/v1/chat/completions", "gw_" + "0".repeat(48), {
      model: "x", messages: [],
    });
    expect(bad1.status).toBe(401);
    const j1 = await bad1.json();
    expect(j1.error).toBeTruthy();
    expect(typeof j1.error.message).toBe("string");

    const bad2 = await llm("/v1/messages", "garbage", { model: "x", messages: [] }, true);
    expect(bad2.status).toBe(401);
    expect((await bad2.json()).type).toBe("error");
  });

  test("malformed bodies rejected before touching upstream", async () => {
    const noModel = await llm("/v1/chat/completions", gatewayKey, { messages: [] });
    expect(noModel.status).toBe(400);

    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${gatewayKey}` },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });

  test("total budget: tiny limit flips key to exhausted", async () => {
    const made = await api("/api/keys", {
      token: userToken,
      body: { name: "tiny", totalLimit: 10 },
    });
    const key = made.json.token;

    const first = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "spend it" }],
    });
    expect(first.status).toBe(200);
    await first.text();

    const second = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "again" }],
    });
    expect(second.status).toBe(429);
    const e = await second.json();
    expect(e.error.message).toContain("exhausted");
  });

  test("daily budget resets semantics (blocked when spent)", async () => {
    const made = await api("/api/keys", {
      token: userToken,
      body: { name: "daily", dailyLimit: 5 },
    });
    const key = made.json.token;

    const first = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "daily spend" }],
    });
    expect(first.status).toBe(200);
    await first.text();

    await Bun.sleep(3500); // flush (1s) + spend-cache TTL (2s) + margin

    const second = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "blocked?" }],
    });
    expect(second.status).toBe(429);
    expect((await second.json()).error.message).toContain("daily");
  });

  test("per-key RPM limit", async () => {
    const made = await api("/api/keys", {
      token: userToken,
      body: { name: "slow", rpm: 1 },
    });
    const key = made.json.token;
    const first = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1", messages: [{ role: "user", content: "1" }],
    });
    expect(first.status).toBe(200);
    await first.text();
    const second = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1", messages: [{ role: "user", content: "2" }],
    });
    expect(second.status).toBe(429);
  });

  test("revoked key dies immediately", async () => {
    const made = await api("/api/keys", { token: userToken, body: { name: "bye" } });
    const key = made.json.token;
    const del = await api(`/api/keys/${made.json.key.id}`, { token: userToken, method: "DELETE" });
    expect(del.status).toBe(200);
    const res = await llm("/v1/chat/completions", key, {
      model: "fake-llm-1", messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toContain("revoked");
  });

  test("TOTP end-to-end: setup, enable, login requires code", async () => {
    const setup = await api("/api/me/2fa/setup", { token: userToken, method: "POST" });
    expect(setup.status).toBe(200);
    expect(setup.json.qrDataUrl).toMatch(/^data:image\/png/);
    const secret = setup.json.secret;
    const code = await totpAt(secret, Date.now());

    const enable = await api("/api/me/2fa/enable", { token: userToken, body: { code } });
    expect(enable.status).toBe(200);

    const login = await api("/api/auth/login", { body: { email: userEmail, password: userPw } });
    expect(login.status).toBe(200);
    expect(login.json.needs2FA).toBe(true);

    const wrong = await api("/api/auth/2fa", { body: { tempToken: login.json.tempToken, code: "000000" } });
    expect(wrong.status).toBe(401);

    const right = await api("/api/auth/2fa", {
      body: { tempToken: login.json.tempToken, code: await totpAt(secret, Date.now()) },
    });
    expect(right.status).toBe(200);
    expect(right.json.accessToken).toBeTruthy();
    userToken = right.json.accessToken;
    totpSecret = secret;
    userRefresh = right.json.refreshToken; // reused by the rotation test (TOTP anti-replay blocks a same-window relogin)
  });

  test("refresh token rotates and old one dies", async () => {
    expect(userRefresh).toBeTruthy();
    const rotated = await api("/api/auth/refresh", { body: { refreshToken: userRefresh } });
    expect(rotated.status).toBe(200);
    expect(rotated.json.refreshToken).toBeTruthy();

    const oldAgain = await api("/api/auth/refresh", { body: { refreshToken: userRefresh } });
    expect(oldAgain.status).toBe(401);
  });

  test("admin sees global stats, keys of everyone, and audit trail", async () => {
    const stats = await api("/api/admin/stats?days=7", { token: adminToken });
    expect(stats.status).toBe(200);
    expect(stats.json.counts.users).toBeGreaterThanOrEqual(2);
    expect(stats.json.counts.keys).toBeGreaterThanOrEqual(4);
    expect(stats.json.totals.reqs).toBeGreaterThanOrEqual(7);

    const keys = await api("/api/admin/keys", { token: adminToken });
    expect(keys.status).toBe(200);
    expect(keys.json.keys.length).toBeGreaterThanOrEqual(4);
    expect(keys.json.keys.find((k: any) => k.name === "tiny").status).toBe("exhausted");

    const audit = await api("/api/admin/audit?limit=200", { token: adminToken });
    expect(audit.status).toBe(200);
    expect(audit.json.entries.some((e: any) => e.action === "user.created")).toBe(true);
    expect(audit.json.entries.some((e: any) => e.action === "key.exhausted")).toBe(true);
  });

  test("static serving: SPA, legal pages, fallback and hard traversal blocks", async () => {
    const index = await fetch(`${GW}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("dash");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await fetch(`${GW}/terms.html`)).status).toBe(200);

    // SPA fallback for extension-less client routes
    const fallback = await fetch(`${GW}/settings`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("dash");

    // traversal attempts never escape (undici normalizes literal `..`; the
    // encoded variants must be hard-refused)
    for (const p of ["/%2e%2e/server/db.ts", "/..%2fserver%2fdb.ts", "/data/gateway.db", "/.secret-file", "/.env"]) {
      const res = await fetch(`${GW}${p}`);
      expect([400, 404]).toContain(res.status);
    }
    const dots = await fetch(`${GW}/../../etc/passwd`);
    expect(dots.status).toBe(200);
    expect(await dots.text()).toContain("dash"); // fell back to SPA, not the shadow file
  });

  test("unauthenticated proxy endpoints look normal to scanners", async () => {
    const res = await fetch(`${GW}/v1/models`);
    expect([401, 404]).toContain(res.status);
  });
});

describe("model registry & routing mode", () => {
  let providerId = "";

  test("provider creation previewed its /models lists, then imported as 'both'", async () => {
    const provs = await api("/api/admin/providers", { token: adminToken });
    providerId = provs.json.providers[0].id;
    // the earlier describe imported with mode "both" right after creation:
    // fake-llm-1 (listed by both surfaces) landed as a single proto "both" row.
    expect(provs.json.providers[0].modelCount).toBe(1);

    const r = await api("/api/admin/models", { token: adminToken });
    expect(r.status).toBe(200);
    const m = r.json.models.find((x: any) => x.id === "fake-llm-1");
    expect(m).toBeTruthy();
    expect(m.source).toBe("auto");
    expect(m.upstreamModel).toBe("fake-llm-1");
    expect(m.proto).toBe("both");
    expect(m.providerName).toBe("provider");
    expect(m.enabled).toBe(true);
  });

  test("default routing mode is passthrough", async () => {
    const r = await api("/api/admin/settings", { token: adminToken });
    expect(r.status).toBe(200);
    expect(r.json.settings.routingMode).toBe("passthrough");
  });

  test("manual model CRUD validates input", async () => {
    const c = await api("/api/admin/models", {
      token: adminToken,
      body: {
        id: "alias-fast",
        providerId,
        upstreamModel: "fake-llm-1",
        proto: "openai",
        name: "Alias Fast",
        description: "Public alias for the fake model",
        contextLength: 128000,
        maxOutputLength: 4096,
        pricing: { prompt: "0.000001", completion: "0.000002" },
        inputModalities: ["text"],
        outputModalities: ["text"],
        samplingParams: ["temperature", "top_p"],
        reasoningEfforts: ["low", "high"],
        datacenters: [{ country_code: "US" }],
      },
    });
    expect(c.status).toBe(200);
    expect(c.json.model.source).toBe("manual");
    expect(c.json.model.pricing.prompt).toBe("0.000001");
    expect(c.json.model.datacenters).toEqual([{ country_code: "US" }]);

    // duplicate id conflicts
    expect(
      (await api("/api/admin/models", { token: adminToken, body: { id: "alias-fast", providerId } })).status,
    ).toBe(409);
    // unknown provider / bad id / bad pricing
    expect(
      (await api("/api/admin/models", { token: adminToken, body: { id: "x1", providerId: "0".repeat(24) } })).status,
    ).toBe(400);
    expect(
      (await api("/api/admin/models", { token: adminToken, body: { id: "bad id", providerId } })).status,
    ).toBe(400);
    expect(
      (await api("/api/admin/models", { token: adminToken, body: { id: "x2", providerId, pricing: { prompt: { nested: 1 } } } })).status,
    ).toBe(400);
  });

  test("router mode: unknown model 404s, alias rewrites the upstream model", async () => {
    const sw = await api("/api/admin/settings", {
      token: adminToken, method: "PATCH", body: { routingMode: "router" },
    });
    expect(sw.status).toBe(200);
    expect(sw.json.settings.routingMode).toBe("router");

    const unknown = await llm("/v1/chat/completions", gatewayKey, { model: "nope-9000", messages: [] });
    expect(unknown.status).toBe(404);
    const uj = await unknown.json();
    expect(uj.error.message).toContain("unknown model");

    // The alias is accepted; the upstream receives the registered upstream id.
    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "alias-fast",
      messages: [{ role: "user", content: "alias route" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    const last = await fetch(`${UP}/__last-body`).then((r2) => r2.json());
    expect(JSON.parse(last.body).model).toBe("fake-llm-1");
  });

  test("models can be renamed (the id is the PK, updated in place)", async () => {
    // target id already taken → 409
    expect(
      (
        await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
          token: adminToken, method: "PATCH", body: { id: "fake-llm-1" },
        })
      ).status,
    ).toBe(409);
    // invalid id → 400
    expect(
      (
        await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
          token: adminToken, method: "PATCH", body: { id: "has space" },
        })
      ).status,
    ).toBe(400);

    // the rename itself: same row carried over to the new id
    const r = await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
      token: adminToken, method: "PATCH", body: { id: "renamed-alias" },
    });
    expect(r.status).toBe(200);
    expect(r.json.model.id).toBe("renamed-alias");
    expect(r.json.model.name).toBe("Alias Fast"); // fields survived
    expect(r.json.model.upstreamModel).toBe("fake-llm-1");

    // routing follows the new id; the old one 404s (router mode is on)
    const routed = await llm("/v1/chat/completions", gatewayKey, {
      model: "renamed-alias", messages: [{ role: "user", content: "renamed" }],
    });
    expect(routed.status).toBe(200);
    await routed.text();
    expect(
      (await llm("/v1/chat/completions", gatewayKey, { model: "alias-fast", messages: [] })).status,
    ).toBe(404);

    // the old id no longer addresses the row; rename back for the next tests
    expect(
      (
        await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
          token: adminToken, method: "PATCH", body: { enabled: true },
        })
      ).status,
    ).toBe(404);
    const back = await api(`/api/admin/models/${encodeURIComponent("renamed-alias")}`, {
      token: adminToken, method: "PATCH", body: { id: "alias-fast" },
    });
    expect(back.status).toBe(200);
    expect(back.json.model.id).toBe("alias-fast");
  });

  test("router mode: usage is attributed to the public model id", async () => {
    await Bun.sleep(1_300); // usage buffer flush (1s interval)
    // admin stats' perModel rollup (the user's own session was rotated away
    // by the refresh-rotation test above, so we read the admin view)
    const stats = await api("/api/admin/stats?days=7", { token: adminToken });
    expect(stats.status).toBe(200);
    const alias = (stats.json.perModel ?? []).find((x: any) => x.model === "alias-fast");
    expect(alias).toBeTruthy();
    expect(alias.reqs).toBeGreaterThan(0);
  });

  test("router mode: /v1/models is served from the registry (rich format)", async () => {
    const r = await fetch(`${GW}/v1/models`, { headers: { Authorization: `Bearer ${gatewayKey}` } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.object).toBeUndefined(); // no longer the upstream pass-through shape
    const ids = j.data.map((m: any) => m.id).sort();
    expect(ids).toEqual(["alias-fast", "fake-llm-1"]);
    const alias = j.data.find((m: any) => m.id === "alias-fast");
    expect(alias.provider).toBe("provider");
    expect(alias.always_on).toBe(true);
    expect(alias.context_length).toBe(128000);
    expect(alias.max_output_length).toBe(4096);
    expect(alias.pricing).toEqual({ prompt: "0.000001", completion: "0.000002" });
    expect(alias.reasoning_parameters).toEqual({ efforts: ["low", "high"] });
    expect(alias.datacenters).toEqual([{ country_code: "US" }]);
    expect(alias.supported_sampling_parameters).toEqual(["temperature", "top_p"]);
    expect(alias.input_modalities).toEqual(["text"]);

    // forced anthropic listing: only anthropic-serving models — fake-llm-1 is
    // proto "both" so it shows up; alias-fast (openai-only) does not
    const a = await fetch(`${GW}/anthropic/v1/models`, { headers: { "x-api-key": gatewayKey } });
    expect(a.status).toBe(200);
    expect((await a.json()).data.map((m: any) => m.id)).toEqual(["fake-llm-1"]);

    // single-model retrieval + 404
    const one = await fetch(`${GW}/v1/models/alias-fast`, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    expect(one.status).toBe(200);
    expect((await one.json()).id).toBe("alias-fast");
    const missing = await fetch(`${GW}/v1/models/nope`, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });
    expect(missing.status).toBe(404);

    // still gated: without ANY auth header the route doesn't even resolve
    // (scanner hygiene), with a bad one it's a 401
    expect([401, 404]).toContain((await fetch(`${GW}/v1/models`)).status);
    expect(
      (await fetch(`${GW}/v1/models`, { headers: { Authorization: "Bearer gw_nope" } })).status,
    ).toBe(401);
  });

  test("router mode: disabled model 404s; proto gates each surface", async () => {
    // fake-llm-1 is proto "both" → it answers on the anthropic surface too
    const both = await llm(
      "/anthropic/v1/messages", gatewayKey,
      { model: "fake-llm-1", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      true,
    );
    expect(both.status).toBe(200);
    await both.text();

    // alias-fast is openai-only → unknown on the anthropic surface
    const cross = await llm(
      "/anthropic/v1/messages", gatewayKey,
      { model: "alias-fast", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
      true,
    );
    expect(cross.status).toBe(404);

    const d = await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
      token: adminToken, method: "PATCH", body: { enabled: false },
    });
    expect(d.status).toBe(200);
    expect(d.json.model.enabled).toBe(false);

    const r = await llm("/v1/chat/completions", gatewayKey, { model: "alias-fast", messages: [] });
    expect(r.status).toBe(404);

    // re-enable for the next tests
    const e = await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
      token: adminToken, method: "PATCH", body: { enabled: true },
    });
    expect(e.json.model.enabled).toBe(true);
  });

  test("deleting a provider orphans its models (503) until re-linked", async () => {
    const del = await api(`/api/admin/providers/${providerId}`, { token: adminToken, method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.json.modelsOrphaned).toBe(2); // fake-llm-1 + alias-fast
    expect(del.json.modelsDeleted).toBe(0);

    const r = await llm("/v1/chat/completions", gatewayKey, { model: "alias-fast", messages: [] });
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toContain("no provider");

    // registry rows survive, now orphaned
    const list = await api("/api/admin/models", { token: adminToken });
    expect(list.json.models.find((x: any) => x.id === "alias-fast").providerName).toBeNull();

    // re-create the provider: dual-capability creation only previews (no
    // import yet), and the follow-up sync skips the orphaned duplicate (no
    // clobber, no 'both' merge — the orphan belongs to no provider anymore)
    const re = await api("/api/admin/providers", {
      token: adminToken,
      body: {
        name: "provider-b",
        openaiBaseUrl: `${UP}/openai/v1`,
        anthropicBaseUrl: `${UP}/anthropic/v1`,
        apiKey: UPSTREAM_KEY,
      },
    });
    expect(re.status).toBe(200);
    const newId = re.json.provider.id as string;
    expect(re.json.provider.modelCount).toBe(0);
    expect(re.json.sync).toBeUndefined();
    expect(re.json.preview.openai.count).toBe(1);
    const imp = await api(`/api/admin/providers/${newId}/sync-models`, {
      token: adminToken, method: "POST", body: { mode: "both" },
    });
    expect(imp.json.sync.openai).toEqual({ added: 0, skipped: 1, merged: 0 });
    expect(imp.json.sync.anthropic).toEqual({ added: 0, skipped: 1, merged: 0 });

    // re-link the alias to the new provider → routes again
    const relink = await api(`/api/admin/models/${encodeURIComponent("alias-fast")}`, {
      token: adminToken, method: "PATCH", body: { providerId: newId },
    });
    expect(relink.status).toBe(200);
    expect(relink.json.model.providerId).toBe(newId);
    const r2 = await llm("/v1/chat/completions", gatewayKey, {
      model: "alias-fast", messages: [{ role: "user", content: "relinked" }],
    });
    expect(r2.status).toBe(200);
    await r2.text();

    providerId = newId;
  });

  test("on-demand sync endpoint reports duplicates as skipped", async () => {
    const r = await api(`/api/admin/providers/${providerId}/sync-models`, {
      token: adminToken, method: "POST",
    });
    expect(r.status).toBe(200);
    // fake-llm-1 stays orphaned (INSERT OR IGNORE) — edits/links are never clobbered
    expect(r.json.sync.openai).toEqual({ added: 0, skipped: 1, merged: 0 });
  });

  test("sync never re-merges a proto the admin restricted manually", async () => {
    // re-link the orphan to provider-b and restrict it to openai on purpose
    await api(`/api/admin/models/${encodeURIComponent("fake-llm-1")}`, {
      token: adminToken, method: "PATCH", body: { providerId, proto: "openai" },
    });
    const r = await api(`/api/admin/providers/${providerId}/sync-models`, {
      token: adminToken, method: "POST",
    });
    expect(r.status).toBe(200);
    // the row was edited by hand → no 'both' upgrade, proto stays openai
    expect(r.json.sync.openai).toEqual({ added: 0, skipped: 1, merged: 0 });
    expect(r.json.sync.anthropic).toEqual({ added: 0, skipped: 1, merged: 0 });
    const list = await api("/api/admin/models", { token: adminToken });
    expect(list.json.models.find((x: any) => x.id === "fake-llm-1").proto).toBe("openai");

    // restore the orphaned state the following tests expect
    await api(`/api/admin/models/${encodeURIComponent("fake-llm-1")}`, {
      token: adminToken, method: "PATCH", body: { providerId: null, proto: "both" },
    });
  });

  test("import mode 'separate' keeps each model on its listing protocol", async () => {
    // the anthropic surface now also lists an anthropic-only model
    await fetch(`${UP}/__models`, {
      method: "POST",
      body: JSON.stringify({ anthropic: ["fake-llm-1", "fake-llm-anth"] }),
    });
    try {
      const c = await api("/api/admin/providers", {
        token: adminToken,
        body: {
          name: "provider-sep",
          openaiBaseUrl: `${UP}/openai/v1`,
          anthropicBaseUrl: `${UP}/anthropic/v1`,
          apiKey: UPSTREAM_KEY,
        },
      });
      expect(c.status).toBe(200);
      expect(c.json.preview.openai.count).toBe(1);
      expect(c.json.preview.anthropic.count).toBe(2);
      expect(c.json.preview.common).toBe(1);
      const sepId = c.json.provider.id as string;

      const s = await api(`/api/admin/providers/${sepId}/sync-models`, {
        token: adminToken, method: "POST", body: { mode: "separate" },
      });
      // fake-llm-1 already exists (orphaned) → skipped on both caps;
      // fake-llm-anth is new and listed only by anthropic → proto anthropic
      expect(s.json.sync.openai).toEqual({ added: 0, skipped: 1, merged: 0 });
      expect(s.json.sync.anthropic).toEqual({ added: 1, skipped: 1, merged: 0 });
      const list = await api("/api/admin/models", { token: adminToken });
      const anth = list.json.models.find((x: any) => x.id === "fake-llm-anth");
      expect(anth.proto).toBe("anthropic");
      expect(anth.providerId).toBe(sepId);

      // a later "both"-mode sync upgrades the pristine auto row
      const b = await api(`/api/admin/providers/${sepId}/sync-models`, {
        token: adminToken, method: "POST", body: { mode: "both" },
      });
      expect(b.json.sync.anthropic).toEqual({ added: 0, skipped: 1, merged: 1 });
      const list2 = await api("/api/admin/models", { token: adminToken });
      expect(list2.json.models.find((x: any) => x.id === "fake-llm-anth").proto).toBe("both");

      // cleanup: provider + its model go away, upstream lists back to default
      const del = await api(`/api/admin/providers/${sepId}?deleteModels=true`, {
        token: adminToken, method: "DELETE",
      });
      expect(del.json.modelsDeleted).toBe(1);
    } finally {
      await fetch(`${UP}/__models`, {
        method: "POST",
        body: JSON.stringify({ anthropic: ["fake-llm-1"] }),
      });
    }
  });

  test("bulk delete removes selected models; provider delete with deleteModels cascades", async () => {
    for (const id of ["tmp-m1", "tmp-m2"]) {
      expect((await api("/api/admin/models", { token: adminToken, body: { id, providerId } })).status).toBe(200);
    }
    expect(
      (await api("/api/admin/models/bulk-delete", { token: adminToken, body: { ids: [] } })).status,
    ).toBe(400);
    const bulk = await api("/api/admin/models/bulk-delete", {
      token: adminToken, body: { ids: ["tmp-m1", "tmp-m2", "ghost-id"] },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.json.deleted).toBe(2);
    const gone = await llm("/v1/chat/completions", gatewayKey, { model: "tmp-m1", messages: [] });
    expect(gone.status).toBe(404);

    // deleteModels=true removes the provider's remaining models with it
    const del = await api(`/api/admin/providers/${providerId}?deleteModels=true`, {
      token: adminToken, method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(del.json.modelsDeleted).toBe(1); // alias-fast (fake-llm-1 is orphaned)
    const list = await api("/api/admin/models", { token: adminToken });
    expect(list.json.models.find((x: any) => x.id === "alias-fast")).toBeUndefined();
    expect(list.json.models.find((x: any) => x.id === "fake-llm-1")).toBeTruthy(); // orphan survives

    // restore a working provider for any later suites
    const re = await api("/api/admin/providers", {
      token: adminToken,
      body: { name: "provider-c", openaiBaseUrl: `${UP}/openai/v1`, anthropicBaseUrl: `${UP}/anthropic/v1`, apiKey: UPSTREAM_KEY },
    });
    expect(re.status).toBe(200);
  });

  test("back to passthrough: registry is ignored, /v1/models forwards upstream", async () => {
    const sw = await api("/api/admin/settings", {
      token: adminToken, method: "PATCH", body: { routingMode: "passthrough" },
    });
    expect(sw.status).toBe(200);

    // an unregistered name would 404 in router mode; passthrough forwards it
    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "passthrough again" }],
    });
    expect(r.status).toBe(200);
    await r.text();

    const m = await fetch(`${GW}/v1/models`, { headers: { Authorization: `Bearer ${gatewayKey}` } });
    expect(m.status).toBe(200);
    expect((await m.json()).object).toBe("list"); // upstream shape again
  });
});

/**
 * Upstream failover: multiple provider keys (ordered) + ordered per-model
 * routing targets. The fake upstream is told per-secret how to misbehave
 * (__behavior) and counts requests per secret (/__hits).
 */
describe("upstream failover", () => {
  let provA = "";
  let provB = "";
  let keyA1 = ""; // provider A, priority 0
  let keyA2 = ""; // provider A, priority 10
  let keyB1 = ""; // provider B, priority 0
  let plainUserToken = ""; // fresh non-admin for the 403 assertions
  const SEC_A1 = "sk-fb-a1";
  const SEC_A2 = "sk-fb-a2";
  const SEC_B1 = "sk-fb-b1";

  const behavior = (secret: string, failWith: { status: number; message?: string } | null) =>
    fetch(`${UP}/__behavior`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, failWith }),
    });
  const hits = async (): Promise<Record<string, number>> =>
    (await fetch(`${UP}/__hits`).then((r) => r.json())) as Record<string, number>;
  const lastAuth = async (): Promise<Record<string, string | null>> =>
    (await fetch(`${UP}/__last-auth`).then((r) => r.json())) as Record<string, string | null>;

  test("setup: fresh provider pair, exclusively owned by this suite", async () => {
    // remove anything earlier describes left behind so candidate chains are exact
    const list = await api("/api/admin/providers", { token: adminToken });
    for (const p of list.json.providers as Array<{ id: string }>) {
      expect((await api(`/api/admin/providers/${p.id}`, { token: adminToken, method: "DELETE" })).status).toBe(200);
    }
    for (const s of [SEC_A1, SEC_A2, SEC_B1]) await behavior(s, null); // accept the secrets

    const a = await api("/api/admin/providers", {
      token: adminToken,
      body: { name: "fb-a", openaiBaseUrl: `${UP}/openai/v1`, apiKey: SEC_A1 },
    });
    expect(a.status).toBe(200);
    provA = a.json.provider.id;
    expect(a.json.provider.keys.length).toBe(1);
    expect(a.json.provider.keys[0].label).toBe("primary");
    expect(a.json.provider.keys[0].status).toBe("active");
    keyA1 = a.json.provider.keys[0].id;

    // no key material anywhere in the payload
    expect(JSON.stringify(a.json)).not.toContain(SEC_A1);

    const k2 = await api(`/api/admin/providers/${provA}/keys`, {
      token: adminToken,
      body: { label: "backup", apiKey: SEC_A2 },
    });
    expect(k2.status).toBe(200);
    keyA2 = k2.json.key.id;
    expect(k2.json.key.priority).toBeGreaterThan(0);

    const b = await api("/api/admin/providers", {
      token: adminToken,
      body: { name: "fb-b", openaiBaseUrl: `${UP}/openai/v1`, apiKey: SEC_B1, priority: 200 },
    });
    expect(b.status).toBe(200);
    provB = b.json.provider.id;
    keyB1 = b.json.provider.keys[0].id;

    // a fresh non-admin user whose token is guaranteed valid right now
    const u = await api("/api/admin/users", {
      token: adminToken,
      body: { email: "fca-user@example.com", name: "FCA", role: "user", sendInvite: true },
    });
    expect(u.status).toBe(200);
    const pwToken = decodeURIComponent(String(u.json.invite.link).split("token=")[1]);
    expect((await api("/api/auth/password-reset/confirm", { body: { token: pwToken, password: "fca-password-123" } })).status).toBe(200);
    const login = await api("/api/auth/login", { body: { email: "fca-user@example.com", password: "fca-password-123" } });
    expect(login.status).toBe(200);
    plainUserToken = login.json.accessToken;
  });

  test("key routes require admin", async () => {
    expect((await api(`/api/admin/providers/${provA}/keys`, { body: { apiKey: "x" } })).status).toBe(401);
    expect((await api(`/api/admin/providers/${provA}/keys`, { token: plainUserToken, body: { apiKey: "x" } })).status).toBe(403);
    expect(
      (await api(`/api/admin/providers/${provA}/keys/reorder`, { token: plainUserToken, body: { ids: [keyA1, keyA2] } })).status,
    ).toBe(403);
    expect(
      (await api(`/api/admin/providers/${provA}/keys/${keyA1}`, { token: plainUserToken, method: "PATCH", body: { status: "active" } })).status,
    ).toBe(403);
    expect(
      (await api("/api/admin/providers/reorder", { token: plainUserToken, body: { ids: [provB, provA] } })).status,
    ).toBe(403);
    expect(
      (await api(`/api/admin/models/x/targets`, { token: plainUserToken, method: "PUT", body: { targets: [{ providerId: provA }] } })).status,
    ).toBe(403);
  });

  test("out-of-credits key falls through to the next key in the SAME request", async () => {
    // primary key reports "insufficient credits" (billing)
    await behavior(SEC_A1, { status: 402, message: "Insufficient credits. Please top up your account." });

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "failover please" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    expect((await lastAuth()).authorization).toBe(`Bearer ${SEC_A2}`);

    let h = await hits();
    expect(h[SEC_A1]).toBe(1);
    expect(h[SEC_A2]).toBe(1);

    // the failed key is marked exhausted(billing) with an auto-retry timestamp
    const provs = await api("/api/admin/providers", { token: adminToken });
    const a1 = provs.json.providers.find((p: any) => p.id === provA).keys.find((k: any) => k.id === keyA1);
    expect(a1.status).toBe("exhausted");
    expect(a1.exhaustedReason).toBe("billing");
    expect(a1.cooldownUntil).toBeGreaterThan(Date.now());

    // second request: the exhausted key is not retried
    const r2 = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "again" }],
    });
    expect(r2.status).toBe(200);
    await r2.text();
    h = await hits();
    expect(h[SEC_A1]).toBe(1);
    expect(h[SEC_A2]).toBe(2);

    // an exhausted key transition is audited
    const log = await api(`/api/admin/audit?limit=20`, { token: adminToken });
    expect(log.json.entries.some((e: any) => e.action === "provider_key.exhausted" && e.target === keyA1)).toBe(true);
  });

  test("client-caused 4xx does NOT fail over to other keys/providers", async () => {
    // a2 (now the active one) rejects with a plain 400 — a client error
    await behavior(SEC_A2, { status: 400, message: "messages: field required" });
    const before = await hits();

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "this 400s" }],
    });
    expect(r.status).toBe(400);
    await r.text();

    const after = await hits();
    expect(after[SEC_A2]).toBe((before[SEC_A2] ?? 0) + 1);
    expect(after[SEC_B1] ?? 0).toBe(before[SEC_B1] ?? 0); // provider B untouched
    // a 400 is client-caused: the key is NOT penalized
    const provs = await api("/api/admin/providers", { token: adminToken });
    const a2 = provs.json.providers.find((p: any) => p.id === provA).keys.find((k: any) => k.id === keyA2);
    expect(a2.status).toBe("active");
    await behavior(SEC_A2, null);
  });

  test("manual re-enable returns an exhausted key to rotation", async () => {
    const re = await api(`/api/admin/providers/${provA}/keys/${keyA1}`, {
      token: adminToken, method: "PATCH", body: { status: "active" },
    });
    expect(re.status).toBe(200);
    expect(re.json.key.status).toBe("active");
    expect(re.json.key.cooldownUntil).toBeNull();
    expect(re.json.key.exhaustedReason).toBeNull();
    await behavior(SEC_A1, null);

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "primary again" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    expect((await lastAuth()).authorization).toBe(`Bearer ${SEC_A1}`);
  });

  test("reordering keys changes which one is preferred", async () => {
    const ro = await api(`/api/admin/providers/${provA}/keys/reorder`, {
      token: adminToken, body: { ids: [keyA2, keyA1] },
    });
    expect(ro.status).toBe(200);
    expect(ro.json.keys.map((k: any) => k.id)).toEqual([keyA2, keyA1]);
    // a partial/wrong set is rejected
    expect(
      (await api(`/api/admin/providers/${provA}/keys/reorder`, { token: adminToken, body: { ids: [keyA2] } })).status,
    ).toBe(400);

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "who is first" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    expect((await lastAuth()).authorization).toBe(`Bearer ${SEC_A2}`);

    // restore natural order for subsequent tests
    await api(`/api/admin/providers/${provA}/keys/reorder`, { token: adminToken, body: { ids: [keyA1, keyA2] } });
  });

  test("legacy PATCH apiKey rotates the top-1 key", async () => {
    const SEC_A1_NEW = "sk-fb-a1-rotated";
    await behavior(SEC_A1_NEW, null);
    const p = await api(`/api/admin/providers/${provA}`, {
      token: adminToken, method: "PATCH", body: { apiKey: SEC_A1_NEW },
    });
    expect(p.status).toBe(200);
    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "rotated" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    expect((await lastAuth()).authorization).toBe(`Bearer ${SEC_A1_NEW}`);
    // keep the canonical secret name for later behavior hooks
    await behavior(SEC_A1, null); // no-op safety
    const provs = await api("/api/admin/providers", { token: adminToken });
    const a1 = provs.json.providers.find((p: any) => p.id === provA).keys.find((k: any) => k.id === keyA1);
    expect(a1.status).toBe("active");
  });

  test("router mode falls across TARGETS: provider A out of credits → provider B serves with its own upstream id", async () => {
    // both of A's keys are out of credits
    await behavior("sk-fb-a1-rotated", { status: 429, message: "You exceeded your current quota, please check your plan and billing details" });
    await behavior(SEC_A2, { status: 429, message: "insufficient_quota: quota exceeded" });

    const sw = await api("/api/admin/settings", {
      token: adminToken, method: "PATCH", body: { routingMode: "router" },
    });
    expect(sw.status).toBe(200);

    const created = await api("/api/admin/models", {
      token: adminToken,
      body: {
        id: "fb-model",
        proto: "openai",
        targets: [
          { providerId: provA, upstreamModel: "fb-model-on-a" },
          { providerId: provB, upstreamModel: "fb-model-on-b" },
        ],
      },
    });
    expect(created.status).toBe(200);
    expect(created.json.model.targets.length).toBe(2);
    expect(created.json.model.providerId).toBe(provA); // mirror = top-1 target
    expect(created.json.model.upstreamModel).toBe("fb-model-on-a");

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fb-model", messages: [{ role: "user", content: "target failover" }],
    });
    expect(r.status).toBe(200);
    await r.text();
    // B received the request under ITS OWN upstream model id
    const body = await fetch(`${UP}/__last-body`).then((x) => x.json());
    expect(JSON.parse(body.body).model).toBe("fb-model-on-b");

    // /v1/models (router registry) still lists the public id
    const m = await fetch(`${GW}/v1/models`, { headers: { Authorization: `Bearer ${gatewayKey}` } });
    expect((await m.json()).data.some((x: any) => x.id === "fb-model")).toBe(true);

    // cleanup: the created model + both A keys exhausted; back to passthrough
    expect((await api(`/api/admin/models/${encodeURIComponent("fb-model")}`, { token: adminToken, method: "DELETE" })).status).toBe(200);
    const sw2 = await api("/api/admin/settings", {
      token: adminToken, method: "PATCH", body: { routingMode: "passthrough" },
    });
    expect(sw2.status).toBe(200);
  });

  test("PUT targets replaces the chain and re-prioritizes it", async () => {
    const created = await api("/api/admin/models", {
      token: adminToken,
      body: { id: "fb-model2", proto: "openai", targets: [{ providerId: provA }] },
    });
    expect(created.status).toBe(200);
    expect(created.json.model.providerId).toBe(provA);

    // invalid: unknown provider / empty chain / duplicated provider
    expect((await api(`/api/admin/models/fb-model2/targets`, { token: adminToken, method: "PUT", body: { targets: [{ providerId: "0".repeat(24) }] } })).status).toBe(400);
    expect((await api(`/api/admin/models/fb-model2/targets`, { token: adminToken, method: "PUT", body: { targets: [] } })).status).toBe(400);
    expect(
      (await api(`/api/admin/models/fb-model2/targets`, {
        token: adminToken, method: "PUT",
        body: { targets: [{ providerId: provA }, { providerId: provB }, { providerId: provA }] },
      })).status,
    ).toBe(400);

    const put = await api(`/api/admin/models/fb-model2/targets`, {
      token: adminToken, method: "PUT",
      body: { targets: [{ providerId: provB, upstreamModel: "m2-b" }, { providerId: provA, upstreamModel: "m2-a" }] },
    });
    expect(put.status).toBe(200);
    expect(put.json.model.targets.map((t: any) => t.providerId)).toEqual([provB, provA]);
    expect(put.json.model.providerId).toBe(provB); // mirror follows the new top-1
    expect(put.json.model.upstreamModel).toBe("m2-b");

    // A's keys are still exhausted from the previous test → B serves anyway
    await behavior(SEC_A2, null); // A2 healthy again, but B is top-1 now
    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fb-model2", messages: [{ role: "user", content: "chain order" }],
    });
    // router mode was switched back to passthrough above — re-enable for this check
    const sw = await api("/api/admin/settings", { token: adminToken, method: "PATCH", body: { routingMode: "router" } });
    expect(sw.status).toBe(200);
    const r2 = await llm("/v1/chat/completions", gatewayKey, {
      model: "fb-model2", messages: [{ role: "user", content: "chain order" }],
    });
    expect(r2.status).toBe(200);
    await r2.text();
    const body = await fetch(`${UP}/__last-body`).then((x) => x.json());
    expect(JSON.parse(body.body).model).toBe("m2-b");
    expect(r.status).toBe(200); // passthrough served it untouched before the switch
    await r.text();

    expect((await api(`/api/admin/models/${encodeURIComponent("fb-model2")}`, { token: adminToken, method: "DELETE" })).status).toBe(200);
    await api("/api/admin/settings", { token: adminToken, method: "PATCH", body: { routingMode: "passthrough" } });
  });

  test("providers reorder endpoint rewrites priorities", async () => {
    const ro = await api("/api/admin/providers/reorder", { token: adminToken, body: { ids: [provB, provA] } });
    expect(ro.status).toBe(200);
    expect(ro.json.providers.map((p: any) => p.id)).toEqual([provB, provA]);
    expect(ro.json.providers[0].priority).toBeLessThan(ro.json.providers[1].priority);
    // wrong set rejected
    expect((await api("/api/admin/providers/reorder", { token: adminToken, body: { ids: [provA] } })).status).toBe(400);
    // restore A-first
    await api("/api/admin/providers/reorder", { token: adminToken, body: { ids: [provA, provB] } });
  });

  test("every candidate failing billing → the last upstream error reaches the client", async () => {
    await behavior(SEC_A2, { status: 402, message: "Insufficient credits" });
    await behavior(SEC_B1, { status: 402, message: "Payment required: account is out of credits" });

    const r = await llm("/v1/chat/completions", gatewayKey, {
      model: "fake-llm-1", messages: [{ role: "user", content: "everyone broke" }],
    });
    expect(r.status).toBe(402); // the real upstream error, not a generic 503
    const j = await r.json();
    expect(JSON.stringify(j)).toContain("credits");

    // cleanup: accept the keys again for the last-key-delete test
    await behavior(SEC_A2, null);
    await behavior(SEC_B1, null);
  });

  test("a provider cannot lose its last remaining key", async () => {
    const d2 = await api(`/api/admin/providers/${provA}/keys/${keyA2}`, { token: adminToken, method: "DELETE" });
    expect(d2.status).toBe(200);
    const d1 = await api(`/api/admin/providers/${provA}/keys/${keyA1}`, { token: adminToken, method: "DELETE" });
    expect(d1.status).toBe(400);
    const provs = await api("/api/admin/providers", { token: adminToken });
    expect(provs.json.providers.find((p: any) => p.id === provA).keys.length).toBe(1);
  });
});

