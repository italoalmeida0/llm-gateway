import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * DSML tool-call recovery suite.
 *
 * Part 1-2: pure unit — the buffered extractor (every documented malformed
 * wrapper variant) and the stream extractor (split-boundary property test).
 * Part 3: IRStreamTranslator end-to-end on synthetic upstream SSE.
 * Part 4: in-process `handleProxy` with a stubbed upstream — raw
 * same-protocol buffered/stream bodies and a translated (Anthropic ingress)
 * buffered body.
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-dsml-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");
const { extractDsmlToolCalls, toolHintsFromRequest, DsmlStreamExtractor, patchRawResponseDsml } = await import(
  "../server/proxy/dsml"
);
const { IRStreamTranslator } = await import("../server/proxy/gateway-ir");

// --- fixtures --------------------------------------------------------------

const B = "｜"; // full-width bar the model emits natively

const HINTS = toolHintsFromRequest({
  tools: [
    {
      type: "function",
      function: {
        name: "exec_bash",
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" }, timeout: { type: "number" }, retries: { type: "number" } },
          required: ["cmd"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, offset: { type: "number" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "store_items",
        parameters: { type: "object", properties: { items: { type: "array" }, flag: { type: "boolean" }, note: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "toggle",
        parameters: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
      },
    },
  ],
});

const CANONICAL =
  `<${B}DSML${B}tool_calls>\n` +
  `  <${B}DSML${B}invoke name="exec_bash">\n` +
  `    <${B}DSML${B}parameter name="cmd" string="true">ls -la && npm run dev</${B}DSML${B}parameter>\n` +
  `    <${B}DSML${B}parameter name="timeout" string="false">30</${B}DSML${B}parameter>\n` +
  `  </${B}DSML${B}invoke>\n` +
  `</${B}DSML${B}tool_calls>`;

// --- part 1: buffered extraction ------------------------------------------

describe("DSML buffered extraction", () => {
  test("canonical block becomes a tool call with typed args", () => {
    const r = extractDsmlToolCalls(CANONICAL, HINTS);
    expect(r.changed).toBe(true);
    expect(r.text.trim()).toBe("");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la && npm run dev", timeout: 30 });
    expect(r.calls[0].id.startsWith("call_")).toBe(true);
  });

  test("text around the block survives", () => {
    const r = extractDsmlToolCalls(`Let me check.\n${CANONICAL}\n`, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.text).toBe("Let me check.\n\n");
    expect(r.text).not.toContain("DSML");
  });

  test("multiple invokes in one block produce parallel calls", () => {
    const two =
      `<${B}DSML${B}tool_calls>` +
      `<${B}DSML${B}invoke name="exec_bash"><${B}DSML${B}parameter name="cmd" string="true">ls</${B}DSML${B}parameter></${B}DSML${B}invoke>` +
      `<${B}DSML${B}invoke name="read_file"><${B}DSML${B}parameter name="path" string="true">a.ts</${B}DSML${B}parameter></${B}DSML${B}invoke>` +
      `</${B}DSML${B}tool_calls>`;
    const r = extractDsmlToolCalls(two, HINTS);
    expect(r.text).toBe("");
    expect(r.calls.map((c: any) => c.name)).toEqual(["exec_bash", "read_file"]);
  });

  test("misspelled wrapper (toolcalls, missing underscore) recovers", () => {
    const r = extractDsmlToolCalls(
      `<${B}DSML${B}toolcalls><${B}DSML${B}invoke name="read_file"><${B}DSML${B}parameter name="path" string="true">src/lib/gateway.ts</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`,
      HINTS,
    );
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("read_file");
    expect(r.text).toBe("");
  });

  test("mismatched wrapper names (tool open / tool_calls close) recover", () => {
    const r = extractDsmlToolCalls(
      `<${B}DSML${B}tool><${B}DSML${B}invoke name="read_file"><${B}DSML${B}parameter name="path" string="true">Seoul</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`,
      HINTS,
    );
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].input).toEqual({ path: "Seoul" });
    expect(r.text).toBe("");
  });

  test("missing start wrapper entirely still recovers", () => {
    const r = extractDsmlToolCalls(
      `<${B}DSML${B}invoke name="exec_bash"><${B}DSML${B}parameter name="cmd" string="true">ls</${B}DSML${B}parameter></${B}DSML${B}invoke>`,
      HINTS,
    );
    expect(r.calls.length).toBe(1);
    expect(r.text).toBe("");
  });

  test("missing invoke open (params + closing invoke) infers the unique tool", () => {
    const r = extractDsmlToolCalls(
      `<${B}DSML${B}tool_calls><${B}DSML${B}parameter name="path" string="true">src/lib/gateway.ts</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`,
      HINTS,
    );
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("read_file");
    expect(r.calls[0].input).toEqual({ path: "src/lib/gateway.ts" });
    expect(r.text).toBe("");
  });

  test("ambiguous name inference is refused (restored verbatim)", () => {
    const src = `<${B}DSML${B}tool_calls><${B}DSML${B}parameter name="flag" string="false">true</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.text).toBe(src);
    expect(r.changed).toBe(false);
  });

  test("name inference without the required argument is refused", () => {
    const src = `<${B}DSML${B}tool_calls><${B}DSML${B}parameter name="offset" string="false">3</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.text).toBe(src);
  });

  test("orphan closing tail is absorbed, never leaked as content", () => {
    const r = extractDsmlToolCalls(`All done.\n</${B}DSML${B}parameter>\n</${B}DSML${B}invoke>\n</${B}DSML${B}tool_calls>`, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.changed).toBe(true);
    expect(r.text).toBe("All done.\n");
    expect(r.text).not.toContain("DSML");
  });

  test("undeclared tool name is restored byte-verbatim", () => {
    const src = `Hmm <${B}DSML${B}tool_calls><${B}DSML${B}invoke name="bogus"><${B}DSML${B}parameter name="x" string="true">y</${B}DSML${B}parameter></${B}DSML${B}invoke></${B}DSML${B}tool_calls>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  });

  test("prose that merely mentions markers cannot become a call", () => {
    const src = `The wrapper looks like <${B}DSML${B}invoke name="exec_bash"> and never closes here.`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  });

  test("an incomplete candidate (no closing invoke) never commits", () => {
    const src = `<${B}DSML${B}tool_calls><${B}DSML${B}invoke name="exec_bash"><${B}DSML${B}parameter name="cmd" string="true">ls`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(0);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  });

  test("no declared tools: markup is content and survives byte-for-byte", () => {
    const r = extractDsmlToolCalls(CANONICAL, []);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(CANONICAL);
    expect(r.calls.length).toBe(0);
    expect(toolHintsFromRequest({ tools: [{ type: "function", function: { name: "x", parameters: {} } }], tool_choice: "none" })).toEqual([]);
  });

  test("ASCII pipes, spaces and single-quoted attrs are tolerated", () => {
    const src = `< | DSML | tool_calls><|DSML| invoke name='read_file'>< |DSML| parameter name='path' string='true'>a.ts</ | DSML | parameter></|DSML|invoke></ | DSML | tool_calls>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].input).toEqual({ path: "a.ts" });
    expect(r.text).toBe("");
  });

  test("recovered args drop optional nulls and unwrap JSON-in-a-string", () => {
    const src =
      `<${B}DSML${B}invoke name="store_items">` +
      `<${B}DSML${B}parameter name="items" string="false">"[1,2]"</${B}DSML${B}parameter>` +
      `<${B}DSML${B}parameter name="flag" string="false">"true"</${B}DSML${B}parameter>` +
      `<${B}DSML${B}parameter name="note" string="false">null</${B}DSML${B}parameter>` +
      `</${B}DSML${B}invoke>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].input).toEqual({ items: [1, 2], flag: true });
  });

  test("unquoted attribute values are accepted", () => {
    const src =
      `<${B}DSML${B}invoke name=exec_bash>` +
      `<${B}DSML${B}parameter name=cmd string=true>ls</${B}DSML${B}parameter>` +
      `</${B}DSML${B}invoke>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls" });
  });

  test("the name=\"X\" typo (`=\"X\"`) still resolves the tool", () => {
    const src =
      `<${B}DSML${B}invoke ="exec_bash">` +
      `<${B}DSML${B}parameter ="cmd" string="true">ls</${B}DSML${B}parameter>` +
      `</${B}DSML${B}invoke>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls" });
  });

  test("tool and parameter names are matched case-insensitively", () => {
    const src =
      `<${B}DSML${B}invoke name="Exec_Bash">` +
      `<${B}DSML${B}parameter name="CMD" string="true">ls</${B}DSML${B}parameter>` +
      `</${B}DSML${B}invoke>`;
    const r = extractDsmlToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls" });
  });
});

// --- part 2: stream extractor (split boundaries) ---------------------------

describe("DSML stream extractor", () => {
  function drainAll(chunks: string[], hints = HINTS) {
    const ex = new DsmlStreamExtractor(hints);
    const out: Array<{ text?: string; call?: { name: string; argsJson: string; index: number } }> = [];
    for (const c of chunks) for (const e of ex.feed(c)) out.push(e);
    for (const e of ex.flush()) out.push(e);
    return out;
  }

  test("every split point yields the same recovery as one-shot", () => {
    const content = `Checking now.\n${CANONICAL}\n`;
    const oneShot = extractDsmlToolCalls(content, HINTS);
    // split at every position (2- and 1-char pieces at the seams)
    for (let cut = 0; cut <= content.length; cut++) {
      const got = drainAll([content.slice(0, cut), content.slice(cut)]);
      const text = got.filter((e: any) => e.text !== undefined).map((e: any) => e.text).join("");
      const calls = got.filter((e: any) => e.call !== undefined);
      expect(text).toBe(oneShot.text);
      expect(calls.length).toBe(oneShot.calls.length);
      if (calls.length) {
        expect((calls[0] as any).call.name).toBe("exec_bash");
        expect(JSON.parse((calls[0] as any).call.argsJson)).toEqual({ cmd: "ls -la && npm run dev", timeout: 30 });
      }
    }
    // char-by-char as the extreme case
    const got = drainAll([...content]);
    expect(got.filter((e: any) => e.text !== undefined).map((e: any) => e.text).join("")).toBe(oneShot.text);
    expect(got.filter((e: any) => e.call !== undefined).length).toBe(1);
  });

  test("trailing orphan closers after a committed call emit nothing extra", () => {
    const content = `${CANONICAL}\n</${B}DSML${B}parameter>\n</${B}DSML${B}invoke>\n</${B}DSML${B}tool_calls>`;
    const got = drainAll([content]);
    const text = got.filter((e: any) => e.text !== undefined).map((e: any) => e.text).join("");
    expect(text).not.toContain("DSML");
    expect(got.filter((e: any) => e.call !== undefined).length).toBe(1);
  });

  test("text before the marker streams through immediately", () => {
    const ex = new DsmlStreamExtractor(HINTS);
    const first = ex.feed("Visible progress ");
    expect(first).toEqual([{ text: "Visible progress " }]);
  });

  test("no hints: text passes through untouched", () => {
    const ex = new DsmlStreamExtractor([]);
    expect(ex.feed(CANONICAL)).toEqual([{ text: CANONICAL }]);
    expect(ex.flush()).toEqual([]);
  });
});

// --- part 3: IR stream translator ------------------------------------------

describe("DSML in the IR stream translator", () => {
  test("openai stream: recovered call arrives as tool_calls, no markup leaks", () => {
    const tr = new IRStreamTranslator("openai", "openai", "deepseek-v4", HINTS);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const mid = Math.floor(CANONICAL.length / 2);
    const pieces: Uint8Array[] = [
      enc.encode(frame({ id: "c1", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "On it. " } }] })),
      enc.encode(frame({ id: "c1", model: "m", choices: [{ index: 0, delta: { content: CANONICAL.slice(0, mid) } }] })),
      enc.encode(frame({ id: "c1", model: "m", choices: [{ index: 0, delta: { content: CANONICAL.slice(mid) } }] })),
      enc.encode(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } })),
      enc.encode("data: [DONE]\n\n"),
    ];
    let out = "";
    for (const p of pieces) out += tr.feed(p).map((b: Uint8Array) => dec.decode(b)).join("");
    out += tr.flush().map((b: Uint8Array) => dec.decode(b)).join("");
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).toContain('"name":"exec_bash"');
    expect(out).toContain("ls -la && npm run dev");
    expect(out).not.toContain("DSML");
    expect(out).toContain("On it. ");
  });

  test("anthropic client stream gets a tool_use block with the args JSON", () => {
    const tr = new IRStreamTranslator("openai", "anthropic", "deepseek-v4", HINTS);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    let out = "";
    for (const p of [
      enc.encode(frame({ choices: [{ index: 0, delta: { content: CANONICAL } }] })),
      enc.encode(frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })),
      enc.encode("data: [DONE]\n\n"),
    ]) {
      out += tr.feed(p).map((b: Uint8Array) => dec.decode(b)).join("");
    }
    out += tr.flush().map((b: Uint8Array) => dec.decode(b)).join("");
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"exec_bash"');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).not.toContain("DSML");
  });
});

// --- part 4: raw-body patcher ----------------------------------------------

describe("DSML raw-body patching", () => {
  test("chat body is patched minimally, foreign fields survive", () => {
    const body = JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      system_fingerprint: "fp-keepme",
      choices: [{ index: 0, message: { role: "assistant", content: `Sure.\n${CANONICAL}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    const out = patchRawResponseDsml("openai", body, HINTS);
    expect(out).not.toBeNull();
    const j = JSON.parse(out!);
    expect(j.system_fingerprint).toBe("fp-keepme");
    expect(j.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(j.choices[0].message.content).toBe("Sure.\n");
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("exec_bash");
    expect(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      cmd: "ls -la && npm run dev",
      timeout: 30,
    });
  });

  test("anthropic and responses bodies gain native tool-use items", () => {
    const anth = patchRawResponseDsml(
      "anthropic",
      JSON.stringify({
        id: "msg_1",
        type: "message",
        content: [{ type: "text", text: `Ok\n${CANONICAL}` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      HINTS,
    );
    const aj = JSON.parse(anth!);
    expect(aj.stop_reason).toBe("tool_use");
    expect(aj.content.filter((b: any) => b.type === "tool_use")[0].name).toBe("exec_bash");
    expect(aj.content.find((b: any) => b.type === "text").text).toBe("Ok\n");

    const resp = patchRawResponseDsml(
      "responses",
      JSON.stringify({
        id: "resp_1",
        object: "response",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: CANONICAL, annotations: [] }] }],
      }),
      HINTS,
    );
    const rj = JSON.parse(resp!);
    const fn = rj.output.find((i: any) => i.type === "function_call");
    expect(fn.name).toBe("exec_bash");
  });

  test("bodies without markup are returned untouched (null)", () => {
    expect(patchRawResponseDsml("openai", JSON.stringify({ choices: [{ message: { content: "plain" } }] }), HINTS)).toBeNull();
    expect(patchRawResponseDsml("openai", "not json at all", HINTS)).toBeNull();
    expect(patchRawResponseDsml("openai", JSON.stringify({ choices: [{ message: { content: CANONICAL } }] }), [])).toBeNull();
  });
});

// --- part 5: in-process proxy ------------------------------------------------

const RUN = randomToken(6);
const UID = `u-dsml-${RUN}`;
const PID = `p-dsml-${RUN}`;
const KID = `k-dsml-${RUN}`;
const KEYID = `key-dsml-${RUN}`;
const GW_KEY = `gw_${RUN}${"a".repeat(48 - RUN.length)}`;
const UP_KEY = "sk-upstream-dsml";
const ORPHAN_TAIL = `\n</${B}DSML${B}parameter>\n</${B}DSML${B}invoke>\n</${B}DSML${B}tool_calls>`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const raw = typeof init?.body === "string" ? init.body : "";
  const reqBody = raw ? JSON.parse(raw) : {};
  if (reqBody.stream) {
    const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const mid = Math.floor(CANONICAL.length / 2);
    const s = new ReadableStream<string>({
      start(c) {
        c.enqueue(enc({ id: "chatcmpl-dsml", model: reqBody.model, choices: [{ index: 0, delta: { role: "assistant", content: "Checking. " + CANONICAL.slice(0, mid) } }] }));
        c.enqueue(enc({ id: "chatcmpl-dsml", model: reqBody.model, choices: [{ index: 0, delta: { content: CANONICAL.slice(mid) } }] }));
        c.enqueue(enc({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
        c.enqueue("data: [DONE]\n\n");
        c.close();
      },
    });
    return new Response(s.pipeThrough(new TextEncoderStream()), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  return Response.json({
    id: "chatcmpl-dsml",
    model: reqBody.model,
    choices: [{ index: 0, message: { role: "assistant", content: `Checking.\n${CANONICAL}${ORPHAN_TAIL}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 10 },
  });
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  flushUsage();
  db.transaction(() => {
    db.prepare("DELETE FROM usage_daily WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM usage_events WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM providers WHERE id = ?").run(PID);
    db.prepare("DELETE FROM users WHERE id = ?").run(UID);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
  })();
  invalidateModelCache();
});

const now = Date.now();
beforeAll(async () => {
  const enc = await encryptSecret(UP_KEY, GATEWAY_SECRET);
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'dsml@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'dsml-openai', 'http://dsml.test/openai/v1', NULL, ?, 1, 100, ?)",
  ).run(PID, enc, now);
  db.prepare(
    "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
  ).run(KID, PID, enc, now, now);
  db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 't', ?, ?, 'active', ?)",
  ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
  db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
  invalidateModelCache();
});

const TOOLS = [
  {
    type: "function",
    function: {
      name: "exec_bash",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, timeout: { type: "number" } },
        required: ["cmd"],
      },
    },
  },
];

function chatReq(body: unknown): { req: Request; url: URL } {
  const req = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GW_KEY}` },
    body: JSON.stringify(body),
  });
  return { req, url: new URL("http://gw/v1/chat/completions") };
}

describe("DSML recovery through handleProxy", () => {
  test("same-protocol buffered body: tool call recovered, orphan tail absorbed", async () => {
    const { req, url } = chatReq({
      model: "deepseek-v4",
      tools: TOOLS,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    const msg = j.choices[0].message;
    expect(msg.tool_calls?.length).toBe(1);
    expect(msg.tool_calls[0].function.name).toBe("exec_bash");
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ cmd: "ls -la && npm run dev", timeout: 30 });
    expect(msg.content).not.toContain("DSML");
    expect(msg.content).toBe("Checking.\n");
  });

  test("same-protocol buffered body without tools: markup survives byte-for-byte", async () => {
    const { req, url } = chatReq({
      model: "deepseek-v4",
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    const j = await res.json();
    expect(j.choices[0].finish_reason).toBe("stop");
    expect(j.choices[0].message.content).toContain("<｜DSML｜tool_calls>");
  });

  test("same-protocol stream: recovered call arrives as tool_calls chunks", async () => {
    const { req, url } = chatReq({
      model: "deepseek-v4",
      tools: TOOLS,
      stream: true,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).not.toContain("DSML");
    const frames = sse
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const toolFrames = frames.flatMap((f: any) => f.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolFrames.length).toBeGreaterThan(0);
    expect(toolFrames[0].function.name).toBe("exec_bash");
    expect(toolFrames[0].index).toBe(0);
    const joined = toolFrames.map((t: any) => t.function.arguments ?? "").join("");
    expect(JSON.parse(joined)).toEqual({ cmd: "ls -la && npm run dev", timeout: 30 });
    const finishes = frames.map((f: any) => f.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toContain("tool_calls");
    expect(frames.map((f: any) => f.choices?.[0]?.delta?.content ?? "").join("")).toBe("Checking. ");
  });

  test("translated buffered body (Anthropic ingress): tool_use block recovered", async () => {
    const req = new Request("http://gw/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "deepseek-v4",
        max_tokens: 50,
        tools: TOOLS.map((t) => ({ name: t.function.name, input_schema: t.function.parameters })),
        messages: [{ role: "user", content: "run ls" }],
      }),
    });
    const res = await handleProxy(req, new URL("http://gw/v1/messages"), undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.stop_reason).toBe("tool_use");
    const toolUse = j.content.find((b: any) => b.type === "tool_use");
    expect(toolUse.name).toBe("exec_bash");
    expect(toolUse.input).toEqual({ cmd: "ls -la && npm run dev", timeout: 30 });
    expect(JSON.stringify(j.content)).not.toContain("DSML");
  });

  test("router mode 'native' disables DSML recovery too", async () => {
    const mid = `deepseek-native-${RUN}`;
    db.prepare(
      `INSERT INTO models (id, provider_id, upstream_model, name, description, enabled,
         input_modalities, output_modalities, sampling_params, features,
         tool_call_mode, source, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 1, '["text"]', '["text"]', '[]', '[]', 'native', 'manual', ?, ?)`,
    ).run(mid, PID, mid, now, now);
    db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, 0, 1, ?)",
    ).run(mid, PID, mid, now);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'router') ON CONFLICT(key) DO UPDATE SET value='router'").run();
    invalidateModelCache();
    try {
      const { req, url } = chatReq({ model: mid, tools: TOOLS, messages: [{ role: "user", content: "run ls" }] });
      const res = await handleProxy(req, url, undefined);
      expect(res.status).toBe(200);
      const j = await res.json();
      // native = fully off: the DSML markup survives as content.
      expect(j.choices[0].finish_reason).toBe("stop");
      expect(j.choices[0].message.content).toContain("DSML");
      expect(j.choices[0].message.tool_calls).toBeUndefined();
    } finally {
      db.prepare("DELETE FROM models WHERE id = ?").run(mid);
      db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
      invalidateModelCache();
    }
  });
});
