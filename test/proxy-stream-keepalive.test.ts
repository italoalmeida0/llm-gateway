import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Regression: Bun.serve stops pulling a response ReadableStream whose pulls
 * enqueue nothing. A translated stream whose head events produce zero client
 * pieces (e.g. Responses `created` + `in_progress`) used to park after two
 * pulls and never read the rest of the upstream — the client stalled until
 * idle timeout. The proxy now emits an SSE comment keepalive on empty pulls.
 *
 * Unlike proxy-responses.test.ts this goes through a REAL Bun.serve: the
 * parking only happens under serve pull-demand, never on direct body reads.
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-keepalive-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");

const RUN = randomToken(6);
const UID = `u-keep-${RUN}`;
const PR = `p-keep-${RUN}`;
const KR = `k-keep-${RUN}`;
const KEYID = `key-keep-${RUN}`;
const GW_KEY = `gw_${RUN}${"k".repeat(48 - RUN.length)}`;
const UP_KEY = "[REDACTED]";

const STUB_REPLY = "Hello after a silent head.";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith("http://resp.test/")) return realFetch(input, init);
  const full = {
    id: "resp_stub",
    object: "response",
    created_at: 1,
    model: "m",
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
    usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
  };
  const ev = (event: string, o: unknown) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;
  // One event per pull: the proxy's first two reads get translator-silent
  // head events (created/in_progress -> zero pieces), exactly the shape that
  // used to park the serve stream pump.
  const events = [
    ev("response.created", { type: "response.created", sequence_number: 0, response: full }),
    ev("response.in_progress", { type: "response.in_progress", sequence_number: 1, response: full }),
    ev("response.output_text.delta", {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: "msg_stub",
      output_index: 0,
      content_index: 0,
      delta: STUB_REPLY,
    }),
    ev("response.completed", { type: "response.completed", sequence_number: 3, response: full }),
  ];
  let i = 0;
  const s = new ReadableStream<string>({ pull(c) { c.enqueue(events[i++] ?? ""); if (i >= events.length) { try { c.close(); } catch {} } } });
  return new Response(s.pipeThrough(new TextEncoderStream()), {
    headers: { "Content-Type": "text/event-stream" },
  });
}) as typeof fetch;

const now = Date.now();
beforeAll(async () => {
  const encKey = await encryptSecret(UP_KEY, GATEWAY_SECRET);
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'keep@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, responses_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'resp-only', NULL, NULL, 'http://resp.test/v1', ?, 1, 10, ?)",
  ).run(PR, encKey, now);
  db.prepare(
    "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
  ).run(KR, PR, encKey, now, now);
  db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 't', ?, ?, 'active', ?)",
  ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
  invalidateModelCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  flushUsage();
  db.transaction(() => {
    db.prepare("DELETE FROM usage_daily WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM usage_events WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM providers WHERE id = ?").run(PR);
    db.prepare("DELETE FROM users WHERE id = ?").run(UID);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
  })();
  invalidateModelCache();
});

describe("translated stream survives translator-silent head (serve pump)", () => {
  test("anthropic <- responses completes past created/in_progress", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 5,
      fetch: (req) => handleProxy(req, new URL(req.url), undefined),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": GW_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "m", max_tokens: 50, messages: [{ role: "user", content: "hi" }], stream: true }),
        signal: AbortSignal.timeout(15000),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("event: message_stop");
      expect(text).toContain(STUB_REPLY);
      expect(text.match(/^: ping$/m) !== null).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
