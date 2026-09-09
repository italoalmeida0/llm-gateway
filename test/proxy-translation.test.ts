import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * In-process translation suite: the real `handleProxy` with the upstream
 * fetch stubbed as an OpenAI-only provider. No sockets — runs anywhere.
 * The stub records what the gateway sent upstream so the Anthropic→OpenAI
 * conversion is asserted on the wire.
 *
 * Hermeticity: test files share the server module registry, so the backing
 * DB depends on import order. Ids are unique per run and afterAll removes
 * every row created here (and restores the routing mode).
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-px-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");

const RUN = randomToken(6);
const UID = `u-px-${RUN}`;
const PID = `p-px-${RUN}`;
const KID = `k-px-${RUN}`;
const KEYID = `key-px-${RUN}`;
const ALIAS = `alias-px-${RUN}`;
const GW_KEY = `gw_${RUN}${"a".repeat(48 - RUN.length)}`;
const UP_KEY = "sk-upstream-test";

interface Seen {
  url: string;
  auth: string | null;
  xkey: string | null;
  version: string | null;
  body: any;
}
let seen: Seen[] = [];
let upstreamMode: "ok" | "error400" = "ok";
const STUB_REPLY = "Hello from the stub upstream.";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  const raw = typeof init?.body === "string" ? init.body : "";
  const h = new Headers(init?.headers);
  seen.push({
    url,
    auth: h.get("authorization"),
    xkey: h.get("x-api-key"),
    version: h.get("anthropic-version"),
    body: raw ? JSON.parse(raw) : null,
  });
  if (upstreamMode === "error400") {
    return new Response(
      JSON.stringify({ error: { message: "bad request demo", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const reqBody = raw ? JSON.parse(raw) : {};
  if (reqBody.stream) {
    const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const s = new ReadableStream<string>({
      start(c) {
        c.enqueue(enc({ id: "chatcmpl-stub", model: reqBody.model, choices: [{ index: 0, delta: { content: "Hello " } }] }));
        c.enqueue(enc({ id: "chatcmpl-stub", model: reqBody.model, choices: [{ index: 0, delta: { content: "from the stub upstream." } }] }));
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
    db.prepare("DELETE FROM models WHERE id = ?").run(ALIAS);
    db.prepare("DELETE FROM providers WHERE id = ?").run(PID);
    db.prepare("DELETE FROM users WHERE id = ?").run(UID);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
  })();
  invalidateModelCache();
});

const now = Date.now();
let enc: string;
beforeAll(async () => {
  enc = await encryptSecret(UP_KEY, GATEWAY_SECRET);
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'u@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'openai-only', 'http://up.test/openai/v1', NULL, ?, 1, 100, ?)",
  ).run(PID, enc, now);
  db.prepare(
    "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
  ).run(KID, PID, enc, now, now);
  db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 't', ?, ?, 'active', ?)",
  ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
});

function anthReq(pathname: string, body: unknown): { req: Request; url: URL } {
  const req = new Request(`http://gw${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": GW_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return { req, url: new URL(`http://gw${pathname}`) };
}

describe("proxy Anthropic→OpenAI translation (in-process)", () => {
  test("non-stream messages translate both ways", async () => {
    seen = [];
    const { req, url } = anthReq("/v1/messages", {
      model: "fake-llm-1",
      max_tokens: 100,
      system: "You are helpful",
      messages: [{ role: "user", content: "hi translated" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.content[0]).toEqual({ type: "text", text: STUB_REPLY });
    expect(j.stop_reason).toBe("end_turn");
    expect(j.usage).toEqual({ input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0 });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://up.test/openai/v1/chat/completions");
    expect(seen[0]!.auth).toBe(`Bearer ${UP_KEY}`);
    expect(seen[0]!.xkey).toBeNull();
    expect(seen[0]!.body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    expect(seen[0]!.body.messages[1]).toEqual({ role: "user", content: "hi translated" });
    expect(seen[0]!.body.stream_options).toBeUndefined();
    expect(seen[0]!.body.system).toBeUndefined();
    expect(seen[0]!.body.model).toBe("fake-llm-1");

    flushUsage();
    const row = db.query("SELECT proto, model, in_tok, out_tok, status FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 1").get(KEYID) as any;
    expect(row).toMatchObject({ proto: "anthropic", model: "fake-llm-1", in_tok: 40, out_tok: 10, status: 200 });
  });

  test("tool calls translate both ways", async () => {
    seen = [];
    const { req, url } = anthReq("/v1/messages", {
      model: "fake-llm-1",
      max_tokens: 100,
      messages: [{ role: "user", content: "list files" }],
      tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect(seen[0]!.body.tools).toEqual([
      { type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } },
    ]);
    expect(seen[0]!.body.tool_choice).toBe("auto");
  });

  test("streams arrive as Anthropic SSE", async () => {
    seen = [];
    const { req, url } = anthReq("/v1/messages", {
      model: "fake-llm-1",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi stream" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    // Incremental read (what Bun.serve does in production): Response.text()
    // hangs on pull-driven streams under bun:test, so pump manually.
    const rdr = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let closed = false;
    for (let i = 0; i < 200 && !closed; i++) {
      const r: any = await Promise.race([
        rdr.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`stuck at read ${i}, bytes=${text.length}`)), 1500)),
      ]);
      if (r.value) text += dec.decode(r.value);
      closed = r.done;
    }
    expect(closed).toBe(true);
    for (const needle of [
      "event: message_start",
      "event: content_block_start",
      "text_delta",
      "event: message_delta",
      "event: message_stop",
      "Hello",
      "from the stub upstream.",
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toContain("[DONE]");
    flushUsage();
    const row = db.query("SELECT proto, out_tok, stream FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 1").get(KEYID) as any;
    expect(row).toMatchObject({ proto: "anthropic", out_tok: 10, stream: 1 });
  });

  test("forced-prefix /anthropic/v1/messages translates too", async () => {
    const { req, url } = anthReq("/anthropic/v1/messages", {
      model: "fake-llm-1",
      max_tokens: 50,
      messages: [{ role: "user", content: "prefixed" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    expect((await res.json()).type).toBe("message");
  });

  test("count_tokens is answered without upstream", async () => {
    seen = [];
    const { req, url } = anthReq("/v1/messages/count_tokens", {
      model: "fake-llm-1",
      messages: [{ role: "user", content: "count me please" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.input_tokens).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);
  });

  test("upstream client errors keep their status in the Anthropic envelope", async () => {
    upstreamMode = "error400";
    try {
      const { req, url } = anthReq("/v1/messages", {
        model: "fake-llm-1",
        max_tokens: 10,
        messages: [{ role: "user", content: "boom" }],
      });
      const res = await handleProxy(req, url, undefined);
      expect(res.status).toBe(400);
      const j = await res.json();
      expect(j).toEqual({ type: "error", error: { type: "invalid_request_error", message: "bad request demo" } });
    } finally {
      upstreamMode = "ok";
    }
  });

  test("router mode serves a translated model under its public id", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'router') ON CONFLICT(key) DO UPDATE SET value='router'").run();
    db.prepare(
      "INSERT INTO models (id, provider_id, upstream_model, enabled, created_at, updated_at) VALUES (?, ?, 'fake-llm-1', 1, ?, ?)",
    ).run(ALIAS, PID, now, now);
    db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, 'fake-llm-1', 0, 1, ?)",
    ).run(ALIAS, PID, now);
    invalidateModelCache();

    const { req, url } = anthReq("/v1/messages", {
      model: ALIAS,
      max_tokens: 50,
      messages: [{ role: "user", content: "routed please" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.type).toBe("message");
    expect(j.content[0].text).toContain("stub upstream");

    flushUsage();
    const row = db.query("SELECT model FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 1").get(KEYID) as any;
    expect(row.model).toBe(ALIAS);

    const listReq = new Request("http://gw/v1/models", {
      headers: { "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
    });
    const list = await handleProxy(listReq, new URL("http://gw/v1/models"), undefined);
    const listed = await list.json();
    expect(listed.data.map((m: any) => m.id)).toContain(ALIAS);
  });
});
