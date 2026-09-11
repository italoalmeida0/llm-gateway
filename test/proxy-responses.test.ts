import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * In-process Responses suite: the real `handleProxy` with the upstream
 * fetch stubbed as either a Responses-only or a chat-only provider. No
 * sockets — runs anywhere. Covers all six translation directions
 * (buffered + streaming) plus native Responses passthrough.
 *
 * Hermeticity: same shared-registry rules as proxy-translation.test.ts —
 * unique ids per run, rows removed in afterAll, routing mode restored.
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-resp-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");

const RUN = randomToken(6);
const UID = `u-rsp-${RUN}`;
const PR = `p-rsp-${RUN}`;
const PC = `p-chat-${RUN}`;
const KR = `k-rsp-${RUN}`;
const KC = `k-chat-${RUN}`;
const KEYID = `key-rsp-${RUN}`;
const GW_KEY = `gw_${RUN}${"b".repeat(48 - RUN.length)}`;
const UP_KEY = "[REDACTED]";

const STUB_REPLY = "Hello from the stub upstream.";

interface Seen {
  url: string;
  body: any;
}
let seen: Seen[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  const raw = typeof init?.body === "string" ? init.body : "";
  const reqBody = raw ? JSON.parse(raw) : {};
  seen.push({ url, body: reqBody });

  if (url.endsWith("/responses")) {
    const full = {
      id: "resp_stub",
      object: "response",
      created_at: 1,
      model: reqBody.model,
      status: "completed",
      error: null,
      output: [
        {
          type: "message",
          id: "msg_stub",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: STUB_REPLY, annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 10,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 50,
      },
    };
    if (reqBody.stream) {
      const ev = (event: string, o: unknown) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;
      const s = new ReadableStream<string>({
        start(c) {
          c.enqueue(ev("response.created", { type: "response.created", sequence_number: 0, response: full }));
          c.enqueue(
            ev("response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: 1,
              item_id: "msg_stub",
              output_index: 0,
              content_index: 0,
              delta: STUB_REPLY,
            }),
          );
          c.enqueue(ev("response.completed", { type: "response.completed", sequence_number: 2, response: full }));
          c.close();
        },
      });
      return new Response(s.pipeThrough(new TextEncoderStream()), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    return Response.json(full);
  }

  // chat-completions stub
  if (reqBody.stream) {
    const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const s = new ReadableStream<string>({
      start(c) {
        c.enqueue(
          enc({ id: "chatcmpl-stub", model: reqBody.model, choices: [{ index: 0, delta: { content: STUB_REPLY } }] }),
        );
        c.enqueue(
          enc({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 10 },
          }),
        );
        c.enqueue("data: [DONE]\n\n");
        c.close();
      },
    });
    return new Response(s.pipeThrough(new TextEncoderStream()), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return Response.json({
    id: "chatcmpl-stub",
    model: reqBody.model,
    choices: [{ index: 0, message: { role: "assistant", content: STUB_REPLY }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 10 },
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  flushUsage();
  db.transaction(() => {
    db.prepare("DELETE FROM usage_daily WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM usage_events WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM providers WHERE id IN (?, ?)").run(PR, PC);
    db.prepare("DELETE FROM users WHERE id = ?").run(UID);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
  })();
  invalidateModelCache();
});

const now = Date.now();
let encKey: string;
beforeAll(async () => {
  encKey = await encryptSecret(UP_KEY, GATEWAY_SECRET);
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'r@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, responses_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'resp-only', NULL, NULL, 'http://resp.test/v1', ?, 1, 10, ?)",
  ).run(PR, encKey, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, responses_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'chat-only', 'http://chat.test/openai/v1', NULL, NULL, ?, 1, 20, ?)",
  ).run(PC, encKey, now);
  for (const [kid, pid] of [[KR, PR], [KC, PC]] as const) {
    db.prepare(
      "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
    ).run(kid, pid, encKey, now, now);
  }
  db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 't', ?, ?, 'active', ?)",
  ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
});

/** Enable exactly one upstream provider (snapshot invalidated). */
function onlyProvider(id: string): void {
  db.prepare("UPDATE providers SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE id IN (?, ?)").run(id, PR, PC);
  invalidateModelCache();
}

function gwReq(pathname: string, body: unknown, anthropic = false): { req: Request; url: URL } {
  const req = new Request(`http://gw${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(anthropic
        ? { "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${GW_KEY}` }),
    },
    body: JSON.stringify(body),
  });
  return { req, url: new URL(`http://gw${pathname}`) };
}

async function readSse(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return out;
}

describe("proxy Responses matrix (in-process)", () => {
  test("responses → responses native passthrough", async () => {
    onlyProvider(PR);
    seen = [];
    const { req, url } = gwReq("/v1/responses", { model: "m", input: "hi" });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.object).toBe("response");
    expect(j.output[0].content[0]).toMatchObject({ type: "output_text", text: STUB_REPLY });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://resp.test/v1/responses");
    expect(seen[0]!.body).toMatchObject({ model: "m", input: "hi" });
    flushUsage();
    const row = db.query("SELECT proto, in_tok, cache_tok, out_tok FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 1").get(KEYID) as any;
    expect(row).toMatchObject({ proto: "responses", in_tok: 35, cache_tok: 5, out_tok: 10 });
  });

  test("responses → chat translation", async () => {
    onlyProvider(PC);
    seen = [];
    const { req, url } = gwReq("/v1/responses", {
      model: "m",
      instructions: "sys",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.object).toBe("response");
    expect(j.output[0].content[0].text).toBe(STUB_REPLY);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://chat.test/openai/v1/chat/completions");
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(seen[0]!.body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("chat → responses translation", async () => {
    onlyProvider(PR);
    seen = [];
    const { req, url } = gwReq("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.object).toBe("chat.completion");
    expect(j.choices[0].message.content).toBe(STUB_REPLY);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://resp.test/v1/responses");
    expect(seen[0]!.body.input[0]).toMatchObject({ type: "message", role: "user" });
  });

  test("anthropic → responses translation", async () => {
    onlyProvider(PR);
    seen = [];
    const { req, url } = gwReq(
      "/v1/messages",
      { model: "m", max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
      true,
    );
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.type).toBe("message");
    expect(j.content[0]).toMatchObject({ type: "text", text: STUB_REPLY });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://resp.test/v1/responses");
  });

  test("responses → chat streaming ends with response.completed", async () => {
    onlyProvider(PC);
    seen = [];
    const { req, url } = gwReq("/v1/responses", { model: "m", input: "hi", stream: true });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSse(res);
    expect(text).toContain("event: response.completed");
    expect(text).toContain(STUB_REPLY);
    // The chat upstream got the usage-request flag despite translation.
    expect(seen[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  test("chat → responses streaming ends with [DONE]", async () => {
    onlyProvider(PR);
    const { req, url } = gwReq("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const text = await readSse(res);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).toContain(STUB_REPLY);
  });
});

describe("provider strip_params (in-process)", () => {
  function setStrip(id: string, params: string[]): void {
    db.prepare("UPDATE providers SET strip_params = ? WHERE id = ?").run(JSON.stringify(params), id);
    invalidateModelCache();
  }

  test("native attempt drops blocked top-level keys", async () => {
    onlyProvider(PC);
    setStrip(PC, ["temperature", "max_tokens"]);
    seen = [];
    const { req, url } = gwReq("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      max_tokens: 50,
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).not.toHaveProperty("temperature");
    expect(seen[0]!.body).not.toHaveProperty("max_tokens");
    expect(seen[0]!.body.messages).toHaveLength(1);
    setStrip(PC, []);
  });

  test("translated attempt drops blocked keys after conversion", async () => {
    onlyProvider(PR);
    setStrip(PR, ["temperature"]);
    seen = [];
    const { req, url } = gwReq("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://resp.test/v1/responses");
    expect(seen[0]!.body).not.toHaveProperty("temperature");
    setStrip(PR, []);
  });

  test("empty blocklist forwards everything untouched", async () => {
    onlyProvider(PC);
    seen = [];
    const { req, url } = gwReq("/v1/chat/completions", {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect(seen[0]!.body.temperature).toBe(0.7);
  });
});
