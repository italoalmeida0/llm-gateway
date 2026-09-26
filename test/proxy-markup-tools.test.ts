import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Xiaomi MiMo tool-call adaptation suite.
 *
 * Part 1: pure unit — model detection, the XML extractor (canonical, multiple
 * blocks, unmatched names restored verbatim, unclosed wrappers), the stream
 * extractor (split-boundary property test) and the request adaptation for all
 * three egress protocols.
 * Part 2: in-process `handleProxy` with a stubbed upstream — chat buffered +
 * stream, translated Anthropic ingress, and the no-tools byte-fidelity rule.
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-xiaomi-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");
const { toolHintsFromRequest } = await import("../server/proxy/dsml");
const {
  extractMarkupToolCalls,
  isXiaomiModel,
  applyMarkupRequestAdaptation,
  buildWorkaroundToolInstruction,
  buildMarkupInstruction,
  MarkupStreamExtractor,
  markupRecoverer,
} = await import("../server/proxy/markup-tools");
const { resolveToolCallMode, defaultToolCallModeFor } = await import("../server/tool-call-mode");

// --- fixtures --------------------------------------------------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "exec_bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, timeout: { type: "number" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

const HINTS = toolHintsFromRequest({ tools: TOOLS });

const HINTS_WRITE = toolHintsFromRequest({
  tools: [
    {
      type: "function",
      function: {
        name: "write_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
  ],
});

const CANONICAL =
  "<tool_call>\n<function=exec_bash>\n<parameter=cmd>ls -la</parameter>\n<parameter=timeout>30</parameter>\n</function>\n</tool_call>";

// --- part 1: pure unit -------------------------------------------------------

describe("Xiaomi detection", () => {
  test("any model id containing xiaomi is a Xiaomi target", () => {
    expect(isXiaomiModel("xiaomi/mimo-v2.5-pro")).toBe(true);
    expect(isXiaomiModel("Xiaomi-MiMo")).toBe(true);
    expect(isXiaomiModel("mimo-v2.5-pro")).toBe(false);
    expect(isXiaomiModel("gpt-5")).toBe(false);
    expect(isXiaomiModel(undefined)).toBe(false);
  });
});

describe("tool-call mode resolution", () => {
  test("an explicit row mode wins over id auto-detection", () => {
    expect(resolveToolCallMode("native", "xiaomi/mimo")).toBe("native");
    expect(resolveToolCallMode("fallback", "gpt-5")).toBe("fallback");
    expect(resolveToolCallMode("workaround", "gpt-5")).toBe("workaround");
  });
  test("with no row, a xiaomi id auto-selects workaround; others default to fallback", () => {
    expect(resolveToolCallMode(undefined, "gpt-5", "xiaomi/mimo")).toBe("workaround");
    expect(resolveToolCallMode(null, "gpt-5")).toBe("fallback");
  });
  test("defaultToolCallModeFor: xiaomi -> workaround, others -> fallback", () => {
    expect(defaultToolCallModeFor("xiaomi/mimo")).toBe("workaround");
    expect(defaultToolCallModeFor("MiniMax-M2")).toBe("fallback");
  });
});

describe("markup modes accept every dialect", () => {
  const minimax =
    '<minimax:tool_call>\n<invoke name="exec_bash">\n<parameter name="cmd">ls -la</parameter>\n</invoke>\n</minimax:tool_call>';
  const hermes = '<tool_call>{"name":"exec_bash","arguments":{"cmd":"ls -la","timeout":30}}</tool_call>';

  test("xiaomi dialect", () => {
    const r = extractMarkupToolCalls(CANONICAL, HINTS, "fallback");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la", timeout: 30 });
  });
  test("minimax dialect (invoke name=)", () => {
    const r = extractMarkupToolCalls(minimax, HINTS, "fallback");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la" });
    expect(r.text).toBe("");
  });
  test("hermes dialect (JSON body)", () => {
    const r = extractMarkupToolCalls(hermes, HINTS, "fallback");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la", timeout: 30 });
  });
  test("hermes with arguments as a JSON string", () => {
    const r = extractMarkupToolCalls('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"/x\\"}"}</tool_call>', HINTS, "fallback");
    expect(r.calls[0].input).toEqual({ path: "/x" });
  });
  test("workaround accepts the other dialects too (only the instruction differs)", () => {
    expect(extractMarkupToolCalls(minimax, HINTS, "workaround").calls.length).toBe(1);
    expect(extractMarkupToolCalls(hermes, HINTS, "workaround").calls.length).toBe(1);
  });
  test("native mode is inert", () => {
    const r = extractMarkupToolCalls(CANONICAL, HINTS, "native");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(CANONICAL);
  });
  test("workaround instruction teaches only the xiaomi format", () => {
    const s = buildWorkaroundToolInstruction([{ name: "exec_bash", description: "Run", parameters: { type: "object" } }]);
    expect(s).toContain("<function=tool_name_here>");
    expect(s).toContain("exec_bash");
    expect(s).toContain("Native function calling is DISABLED");
    // Single format only — no minimax/hermes examples (they made models flail).
    expect(s).not.toContain("<minimax:tool_call>");
    expect(s).not.toContain('"name": "tool_name_here"');
  });
  test("fallback instruction is empty (passive)", () => {
    expect(buildMarkupInstruction("fallback", [{ name: "x" }])).toBe("");
    expect(buildMarkupInstruction("native", [{ name: "x" }])).toBe("");
  });
  test("streaming recovers a minimax call split at every boundary", () => {
    const src = `Checking. ${minimax} done`;
    for (let i = 0; i <= src.length; i++) {
      const ex = new MarkupStreamExtractor(HINTS, "fallback");
      const emits = [...ex.feed(src.slice(0, i)), ...ex.feed(src.slice(i)), ...ex.flush()];
      const calls = emits.filter((e) => "call" in e) as any[];
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].call.argsJson)).toEqual({ cmd: "ls -la" });
    }
  });

  test("disable() releases the held tail as text and stops recovery", () => {
    const ex = new MarkupStreamExtractor(HINTS, "fallback");
    // Feed a partial marker so the tail is held, then a native call arrives.
    const first = ex.feed("Checking. <tool_call><function=exec_bash>");
    expect(first.some((e) => "call" in e)).toBe(false);
    const released = ex.disable();
    expect(released.map((e) => ("text" in e ? e.text : "CALL")).join("")).toContain("<tool_call>");
    expect(ex.active).toBe(false);
    // Later markup passes through untouched (never recovered).
    const after = [...ex.feed(CANONICAL), ...ex.flush()];
    expect(after.some((e) => "call" in e)).toBe(false);
    expect(after.map((e) => ("text" in e ? e.text : "")).join("")).toContain("<tool_call>");
    expect(ex.committed).toBe(0);
  });
});

describe("Xiaomi XML extraction (buffered)", () => {
  test("canonical block becomes a native call with typed params", () => {
    const r = extractMarkupToolCalls(`Checking.\n${CANONICAL}\n`, HINTS, "workaround");
    expect(r.changed).toBe(true);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la", timeout: 30 });
    expect(r.text).not.toContain("tool_call");
    expect(r.text).toBe("Checking.");
  });

  test("multiple blocks become multiple calls", () => {
    const two = `${CANONICAL}\n<tool_call>\n<function=read_file>\n<parameter=path>/etc/hosts</parameter>\n</function>\n</tool_call>`;
    const r = extractMarkupToolCalls(two, HINTS, "workaround");
    expect(r.calls.map((c) => c.name)).toEqual(["exec_bash", "read_file"]);
    expect(r.calls[1].input).toEqual({ path: "/etc/hosts" });
  });

  test("non-JSON parameter values stay strings", () => {
    const r = extractMarkupToolCalls("<tool_call><function=exec_bash><parameter=cmd>echo hi</parameter></function></tool_call>", HINTS, "workaround");
    expect(r.calls[0].input).toEqual({ cmd: "echo hi" });
  });

  test("an undeclared function name restores the block verbatim", () => {
    const src = "<tool_call><function=rm_rf><parameter=path>/</parameter></function></tool_call>";
    const r = extractMarkupToolCalls(src, HINTS, "workaround");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
    expect(r.calls.length).toBe(0);
  });

  test("an unclosed wrapper is not recovered (conservative)", () => {
    const src = "<tool_call><function=exec_bash><parameter=cmd>ls</parameter></function>";
    const r = extractMarkupToolCalls(src, HINTS, "workaround");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  });

  test("no hints disables recovery entirely", () => {
    const r = extractMarkupToolCalls(CANONICAL, [], "workaround");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(CANONICAL);
  });

  test("a nested block is ignored, only the outer call commits", () => {
    const src =
      `<tool_call><function=exec_bash><parameter=cmd>ls</parameter>` +
      `<tool_call><function=read_file><parameter=path>/x</parameter></function></tool_call>` +
      `</function></tool_call>`;
    const r = extractMarkupToolCalls(src, HINTS, "workaround");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls" });
  });

  test("markup inside a parameter VALUE is preserved as literal text", () => {
    // The model is editing a file whose content literally contains the tag.
    const content = "const x = `<tool_call><function=foo><parameter=bar>baz</parameter></function></tool_call>`;";
    const src =
      `<tool_call><function=write_file>` +
      `<parameter=path>example.tsx</parameter>` +
      `<parameter=content>${content}</parameter>` +
      `</function></tool_call>`;
    const r = extractMarkupToolCalls(src, HINTS_WRITE, "workaround");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("write_file");
    expect(r.calls[0].input).toEqual({ path: "example.tsx", content });
  });

  test("a nested value survives a stream split at every boundary", () => {
    const content = "a `<tool_call><function=foo><parameter=bar>baz</parameter></function></tool_call>` b";
    const src =
      `<tool_call><function=write_file>` +
      `<parameter=path>x</parameter><parameter=content>${content}</parameter></function></tool_call>`;
    for (let i = 0; i <= src.length; i++) {
      const ex = new MarkupStreamExtractor(HINTS_WRITE, "workaround");
      const emits = [...ex.feed(src.slice(0, i)), ...ex.feed(src.slice(i)), ...ex.flush()];
      const calls = emits.filter((e) => "call" in e) as any[];
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].call.argsJson)).toEqual({ path: "x", content });
    }
  });

  test("function/parameter names are matched case-insensitively", () => {
    const src = "<TOOL_CALL><FUNCTION=Exec_Bash><PARAMETER=CMD>ls</PARAMETER></FUNCTION></TOOL_CALL>";
    const r = extractMarkupToolCalls(src, HINTS, "workaround");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls" });
  });

  test("quoted and unquoted attribute forms are both accepted", () => {
    expect(extractMarkupToolCalls('<tool_call><function="exec_bash"><parameter="cmd">ls</parameter></function></tool_call>', HINTS, "workaround").calls[0].input).toEqual({ cmd: "ls" });
    expect(extractMarkupToolCalls("<tool_call><function=exec_bash><parameter=cmd>ls</parameter></function></tool_call>", HINTS, "workaround").calls[0].input).toEqual({ cmd: "ls" });
  });

  test("a parameter name is canonicalized to the declared casing", () => {
    const src = "<tool_call><function=exec_bash><parameter=CMD>ls</parameter></function></tool_call>";
    expect(extractMarkupToolCalls(src, HINTS, "workaround").calls[0].input).toEqual({ cmd: "ls" });
  });
});

describe("Xiaomi XML extraction (streaming)", () => {
  test("split at every boundary yields the same result as one shot", () => {
    const src = `Checking. ${CANONICAL} done`;
    const oneShot = new MarkupStreamExtractor(HINTS, "workaround");
    const expectedText = oneShot
      .feed(src)
      .concat(oneShot.flush())
      .map((e) => ("text" in e ? e.text : ""))
      .join("");
    const expectedCalls = oneShot.committed;
    for (let i = 0; i <= src.length; i++) {
      const ex = new MarkupStreamExtractor(HINTS, "workaround");
      const emits = [...ex.feed(src.slice(0, i)), ...ex.feed(src.slice(i)), ...ex.flush()];
      const text = emits.map((e) => ("text" in e ? e.text : "")).join("");
      const calls = emits.filter((e) => "call" in e);
      expect(text).toBe(expectedText);
      expect(calls.length).toBe(expectedCalls);
      expect(ex.committed).toBeGreaterThan(0);
    }
  });

  test("an unclosed block at end of stream restores verbatim", () => {
    const ex = new MarkupStreamExtractor(HINTS, "workaround");
    const src = `<tool_call><function=exec_bash><parameter=cmd>ls`;
    const emits = [...ex.feed(src), ...ex.flush()];
    expect(emits.map((e) => ("text" in e ? e.text : "")).join("")).toBe(src);
    expect(ex.committed).toBe(0);
  });

  test("recovered calls carry their own index", () => {
    const ex = new MarkupStreamExtractor(HINTS, "workaround");
    const two = `${CANONICAL}<tool_call><function=read_file><parameter=path>/x</parameter></function></tool_call>`;
    const emits = [...ex.feed(two), ...ex.flush()].filter((e) => "call" in e);
    expect(emits.map((e: any) => e.call.index)).toEqual([0, 1]);
  });
});

describe("Xiaomi request adaptation", () => {
  test("chat: tools stripped, instruction appended as a new user message", () => {
    const body = {
      model: "xiaomi/mimo-v2.5-pro",
      tools: TOOLS,
      tool_choice: "auto",
      messages: [{ role: "user", content: "run ls" }],
    };
    const out = applyMarkupRequestAdaptation(body, "openai", "workaround");
    expect("tools" in out).toBe(false);
    expect("tool_choice" in out).toBe(false);
    const msgs = out.messages as any[];
    expect(msgs.length).toBe(2);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("<system_instruction>");
    expect(msgs[1].content).toContain("exec_bash");
    expect(msgs[1].content).toContain("read_file");
  });

  test("chat: a trailing tool message still gets its own user instruction turn", () => {
    const body = {
      model: "xiaomi/mimo-v2.5-pro",
      tools: TOOLS,
      messages: [
        { role: "user", content: "run ls" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "exec_bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    };
    const out = applyMarkupRequestAdaptation(body, "openai", "workaround");
    const msgs = out.messages as any[];
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: buildWorkaroundToolInstruction([{ name: "exec_bash", description: "Run a shell command", parameters: TOOLS[0].function.parameters }, { name: "read_file", description: "Read a file", parameters: TOOLS[1].function.parameters }]) });
  });

  test("chat: assistant tool-call turn without reasoning gets a placeholder", () => {
    const body = {
      model: "xiaomi/mimo-v2.5-pro",
      tools: TOOLS,
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "exec_bash", arguments: "{}" } }] },
      ],
    };
    const out = applyMarkupRequestAdaptation(body, "openai", "workaround");
    const asst = (out.messages as any[])[0];
    expect(typeof asst.reasoning_content).toBe("string");
    expect(asst.reasoning_content.length).toBeGreaterThan(0);
  });

  test("chat: a think block in history goes back to reasoning_content", () => {
    const body = {
      model: "xiaomi/mimo-v2.5-pro",
      tools: TOOLS,
      messages: [
        {
          role: "assistant",
          content: "---\n###### Think Start {\nI should list files.\n###### } Think End\n---\n\nHere goes.",
        },
      ],
    };
    const out = applyMarkupRequestAdaptation(body, "openai", "workaround");
    const asst = (out.messages as any[])[0];
    expect(asst.reasoning_content).toBe("I should list files.");
    expect(asst.content).toBe("Here goes.");
  });

  test("anthropic: instruction rides a text block in the trailing user turn", () => {
    const body = {
      model: "mimo",
      tools: [{ name: "exec_bash", description: "Run", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
    };
    const out = applyMarkupRequestAdaptation(body, "anthropic", "workaround");
    expect("tools" in out).toBe(false);
    const msgs = out.messages as any[];
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("user");
    const blocks = msgs[0].content;
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("<system_instruction>");
  });

  test("responses: instruction becomes an input_text user message", () => {
    const body = {
      model: "mimo",
      tools: [{ type: "function", name: "exec_bash", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const out = applyMarkupRequestAdaptation(body, "responses", "workaround");
    expect("tools" in out).toBe(false);
    const input = out.input as any[];
    expect(input[input.length - 1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: buildWorkaroundToolInstruction([{ name: "exec_bash", description: undefined, parameters: { type: "object" } }]) }],
    });
  });

  test("hosted (non-function) tools are not expressible and are ignored", () => {
    const body = { model: "mimo", tools: [{ type: "web_search" }], messages: [] };
    const out = applyMarkupRequestAdaptation(body, "openai", "workaround");
    expect(out).toBe(body);
  });

  test("no tools = same object (nothing to adapt)", () => {
    const body = { model: "mimo", messages: [{ role: "user", content: "hi" }] };
    expect(applyMarkupRequestAdaptation(body, "openai", "workaround")).toBe(body);
  });

  test("tool_choice:none forbids calls and leaves the body untouched", () => {
    const body = { model: "mimo", tools: TOOLS, tool_choice: "none", messages: [] };
    expect(applyMarkupRequestAdaptation(body, "openai", "workaround")).toBe(body);
  });
});

describe("Xiaomi recoverer (raw buffered body)", () => {
  test("chat body: XML recovered, native reasoning_content left untouched", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: `Checking.\n${CANONICAL}`, reasoning_content: "I will list files." },
          finish_reason: "stop",
        },
      ],
    });
    const patched = markupRecoverer("workaround", HINTS).patchRaw("openai", body);
    expect(patched).not.toBeNull();
    const j = JSON.parse(patched!);
    const msg = j.choices[0].message;
    expect(msg.tool_calls.length).toBe(1);
    expect(msg.tool_calls[0].function.name).toBe("exec_bash");
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    // No think block injected into content; the native field is preserved.
    expect(msg.reasoning_content).toBe("I will list files.");
    expect(msg.content).toBe("Checking.");
    expect(msg.content).not.toContain("Think Start");
  });

  test("a body with no marker is untouched (null)", () => {
    expect(markupRecoverer("workaround", HINTS).patchRaw("openai", JSON.stringify({ choices: [{ message: { content: "plain" } }] }))).toBeNull();
    expect(markupRecoverer("workaround", HINTS).patchRaw("openai", "not json")).toBeNull();
  });

  test("anti-duplicate: a native tool_call suppresses markup recovery (openai)", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: `Also here: ${CANONICAL}`,
            tool_calls: [{ id: "call_n", type: "function", function: { name: "exec_bash", arguments: "{\"cmd\":\"native\"}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const patched = markupRecoverer("workaround", HINTS).patchRaw("openai", body);
    expect(patched).toBeNull(); // nothing changed: markup left as content
  });

  test("anti-duplicate: a native tool_use suppresses markup recovery (anthropic)", () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: `Also here: ${CANONICAL}` },
        { type: "tool_use", id: "toolu_n", name: "exec_bash", input: { cmd: "native" } },
      ],
      stop_reason: "tool_use",
    });
    expect(markupRecoverer("workaround", HINTS).patchRaw("anthropic", body)).toBeNull();
  });

  test("anti-duplicate: a native function_call suppresses markup recovery (responses)", () => {
    const body = JSON.stringify({
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `Also here: ${CANONICAL}` }] },
        { type: "function_call", id: "fc_n", call_id: "fc_n", name: "exec_bash", arguments: "{\"cmd\":\"native\"}" },
      ],
    });
    expect(markupRecoverer("workaround", HINTS).patchRaw("responses", body)).toBeNull();
  });

  test("anthropic body: text block recovered into a tool_use block", () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: `Checking.\n${CANONICAL}` }],
      stop_reason: "end_turn",
    });
    const patched = markupRecoverer("workaround", HINTS).patchRaw("anthropic", body);
    expect(patched).not.toBeNull();
    const j = JSON.parse(patched!);
    expect(j.stop_reason).toBe("tool_use");
    const tu = j.content.find((b: any) => b.type === "tool_use");
    expect(tu.name).toBe("exec_bash");
    expect(tu.input).toEqual({ cmd: "ls -la", timeout: 30 });
    expect(JSON.stringify(j.content)).not.toContain("tool_call");
  });

  test("responses body: message text recovered into a function_call", () => {
    const body = JSON.stringify({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `Checking.\n${CANONICAL}` }] }],
    });
    const patched = markupRecoverer("workaround", HINTS).patchRaw("responses", body);
    expect(patched).not.toBeNull();
    const j = JSON.parse(patched!);
    const fc = j.output.find((b: any) => b.type === "function_call");
    expect(fc.name).toBe("exec_bash");
    expect(JSON.parse(fc.arguments)).toEqual({ cmd: "ls -la", timeout: 30 });
    expect(JSON.stringify(j.output)).not.toContain("tool_call");
  });
});

// --- part 2: in-process proxy ------------------------------------------------

const RUN = randomToken(6);
const UID = `u-xm-${RUN}`;
const PID = `p-xm-${RUN}`;
const KID = `k-xm-${RUN}`;
const KEYID = `key-xm-${RUN}`;
const GW_KEY = `gw_${RUN}${"a".repeat(48 - RUN.length)}`;
const UP_KEY = "sk-upstream-xiaomi";
const MODEL = "xiaomi/mimo-v2.5-pro";

let lastUpstreamBody: any = null;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const raw = typeof init?.body === "string" ? init.body : "";
  lastUpstreamBody = raw ? JSON.parse(raw) : null;
  const reqBody = lastUpstreamBody ?? {};
  // A model id containing "dup" simulates a model that emits BOTH a native
  // tool_calls delta AND markup content (the anti-duplicate guard case).
  const dup = typeof reqBody.model === "string" && reqBody.model.includes("dup");
  if (reqBody.stream) {
    const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const mid = Math.floor(CANONICAL.length / 2);
    const s = new ReadableStream<string>({
      start(c) {
        if (dup) {
          c.enqueue(enc({ id: "chatcmpl-xm", model: reqBody.model, choices: [{ index: 0, delta: { role: "assistant", content: "Checking. " + CANONICAL.slice(0, mid) } }] }));
          c.enqueue(enc({ id: "chatcmpl-xm", model: reqBody.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_native", type: "function", function: { name: "exec_bash", arguments: "{\"cmd\":\"native\"}" } }] } }] }));
          c.enqueue(enc({ id: "chatcmpl-xm", model: reqBody.model, choices: [{ index: 0, delta: { content: CANONICAL.slice(mid) } }] }));
          c.enqueue(enc({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
          c.enqueue("data: [DONE]\n\n");
          c.close();
          return;
        }
        c.enqueue(enc({ id: "chatcmpl-xm", model: reqBody.model, choices: [{ index: 0, delta: { role: "assistant", content: "Checking. " + CANONICAL.slice(0, mid) } }] }));
        c.enqueue(enc({ id: "chatcmpl-xm", model: reqBody.model, choices: [{ index: 0, delta: { content: CANONICAL.slice(mid) } }] }));
        c.enqueue(enc({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
        c.enqueue("data: [DONE]\n\n");
        c.close();
      },
    });
    return new Response(s.pipeThrough(new TextEncoderStream()), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  if (dup) {
    return Response.json({
      id: "chatcmpl-xm",
      model: reqBody.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `Also here: ${CANONICAL}`,
            tool_calls: [{ id: "call_native", type: "function", function: { name: "exec_bash", arguments: "{\"cmd\":\"native\"}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 10 },
    });
  }
  return Response.json({
    id: "chatcmpl-xm",
    model: reqBody.model,
    choices: [{ index: 0, message: { role: "assistant", content: `Checking.\n${CANONICAL}` }, finish_reason: "stop" }],
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
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'xm@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, 'xiaomi-openai', 'http://xiaomi.test/openai/v1', NULL, ?, 1, 100, ?)",
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

beforeEach(() => {
  lastUpstreamBody = null;
});

function chatReq(body: unknown): { req: Request; url: URL } {
  const req = new Request("http://gw/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GW_KEY}` },
    body: JSON.stringify(body),
  });
  return { req, url: new URL("http://gw/v1/chat/completions") };
}

describe("Xiaomi adaptation through handleProxy", () => {
  test("chat buffered: tools stripped upstream, XML recovered for the client", async () => {
    const { req, url } = chatReq({
      model: MODEL,
      tools: TOOLS,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    // Upstream saw the adapted body: no native tools, an XML instruction turn.
    expect(lastUpstreamBody.tools).toBeUndefined();
    expect(lastUpstreamBody.tool_choice).toBeUndefined();
    const upMsgs = lastUpstreamBody.messages;
    expect(upMsgs[upMsgs.length - 1].role).toBe("user");
    expect(upMsgs[upMsgs.length - 1].content).toContain("<system_instruction>");
    // Client got a native tool call, markup stripped.
    const j = await res.json();
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    const msg = j.choices[0].message;
    expect(msg.tool_calls?.length).toBe(1);
    expect(msg.tool_calls[0].function.name).toBe("exec_bash");
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ cmd: "ls -la", timeout: 30 });
    expect(msg.content).not.toContain("tool_call");
    expect(msg.content).toBe("Checking.");
  });

  test("chat stream: recovered call arrives as tool_calls chunks", async () => {
    const { req, url } = chatReq({
      model: MODEL,
      tools: TOOLS,
      stream: true,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).not.toContain("<tool_call>");
    const frames = sse
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const toolFrames = frames.flatMap((f: any) => f.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolFrames.length).toBeGreaterThan(0);
    expect(toolFrames[0].function.name).toBe("exec_bash");
    const joined = toolFrames.map((t: any) => t.function.arguments ?? "").join("");
    expect(JSON.parse(joined)).toEqual({ cmd: "ls -la", timeout: 30 });
    const finishes = frames.map((f: any) => f.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishes).toContain("tool_calls");
    expect(frames.map((f: any) => f.choices?.[0]?.delta?.content ?? "").join("")).toBe("Checking. ");
  });

  test("Anthropic stream ingress: recovered call arrives as a tool_use SSE block", async () => {
    // The daemon always streams; verify the Anthropic SSE writer emits a
    // proper tool_use block (not leaked XML) and a tool_use stop_reason.
    const req = new Request("http://gw/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 50,
        stream: true,
        tools: [{ name: "exec_bash", description: "Run", input_schema: TOOLS[0].function.parameters }],
        messages: [{ role: "user", content: "run ls" }],
      }),
    });
    const res = await handleProxy(req, new URL("http://gw/v1/messages"), undefined);
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).not.toContain("<tool_call>");
    const events = sse
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const start = events.find((e: any) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(start.content_block.name).toBe("exec_bash");
    const args = events
      .filter((e: any) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e: any) => e.delta.partial_json)
      .join("");
    expect(JSON.parse(args)).toEqual({ cmd: "ls -la", timeout: 30 });
    const stop = events.find((e: any) => e.type === "message_delta")?.delta?.stop_reason;
    expect(stop).toBe("tool_use");
  });

  test("translated Anthropic ingress: tool_use block recovered", async () => {
    const req = new Request("http://gw/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 50,
        tools: [{ name: "exec_bash", description: "Run", input_schema: TOOLS[0].function.parameters }],
        messages: [{ role: "user", content: "run ls" }],
      }),
    });
    const res = await handleProxy(req, new URL("http://gw/v1/messages"), undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.stop_reason).toBe("tool_use");
    const toolUse = j.content.find((b: any) => b.type === "tool_use");
    expect(toolUse.name).toBe("exec_bash");
    expect(toolUse.input).toEqual({ cmd: "ls -la", timeout: 30 });
    expect(JSON.stringify(j.content)).not.toContain("tool_call");
    // The chat egress body was adapted (instruction in a user text block).
    const upMsgs = lastUpstreamBody.messages;
    expect(lastUpstreamBody.tools).toBeUndefined();
    expect(JSON.stringify(upMsgs)).toContain("<system_instruction>");
  });

  test("Anthropic ingress, turn 2 (the daemon's exact shape): tool_result survives, instruction follows", async () => {
    // The daemon speaks Anthropic exclusively; on the follow-up turn it sends
    // assistant tool_use + user tool_result. The gateway translates to chat
    // and must not break the in-flight tool result.
    const req = new Request("http://gw/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 50,
        tools: [{ name: "exec_bash", description: "Run", input_schema: TOOLS[0].function.parameters }],
        messages: [
          { role: "user", content: [{ type: "text", text: "run ls" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "exec_bash", input: { cmd: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] },
        ],
      }),
    });
    const res = await handleProxy(req, new URL("http://gw/v1/messages"), undefined);
    expect(res.status).toBe(200);
    // Upstream chat body: the tool result is intact and the instruction is a
    // SEPARATE user turn after it (never merged into the tool message).
    expect(lastUpstreamBody.tools).toBeUndefined();
    const upMsgs = lastUpstreamBody.messages;
    const toolMsg = upMsgs.find((m: any) => m.role === "tool");
    expect(toolMsg.tool_call_id).toBe("toolu_1");
    expect(toolMsg.content).toBe("a.txt");
    const last = upMsgs[upMsgs.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("<system_instruction>");
    // The assistant tool-call turn carries reasoning (MiMo requires it).
    const asst = upMsgs.find((m: any) => m.role === "assistant");
    expect(typeof asst.reasoning_content).toBe("string");
    expect(asst.reasoning_content.length).toBeGreaterThan(0);
    // Client still gets a native Anthropic tool_use back.
    const j = await res.json();
    expect(j.content.find((b: any) => b.type === "tool_use").name).toBe("exec_bash");
  });

  test("no tools: markup survives byte-for-byte (recovery disabled)", async () => {
    const { req, url } = chatReq({
      model: MODEL,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    const j = await res.json();
    expect(j.choices[0].finish_reason).toBe("stop");
    expect(j.choices[0].message.content).toContain("<tool_call>");
    // No adaptation happened: the upstream body is the client's body.
    expect(lastUpstreamBody.tools).toBeUndefined();
    expect(lastUpstreamBody.messages.length).toBe(1);
  });

  test("a non-Xiaomi model defaults to fallback: native tools kept, markup still recovered", async () => {
    const { req, url } = chatReq({
      model: "deepseek-v4",
      tools: TOOLS,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    // Fallback is PASSIVE: native tools pass through untouched.
    expect(Array.isArray(lastUpstreamBody.tools)).toBe(true);
    // ...but the xiaomi-dialect markup in the response is still recovered.
    const j = await res.json();
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(j.choices[0].message.tool_calls?.[0]?.function.name).toBe("exec_bash");
    expect(j.choices[0].message.content).not.toContain("tool_call");
  });

  test("router mode: an explicit 'native' row disables markup recovery", async () => {
    const mid = `native-model-${RUN}`;
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
      // Native mode: tools forwarded, markup left as content.
      expect(Array.isArray(lastUpstreamBody.tools)).toBe(true);
      const j = await res.json();
      expect(j.choices[0].finish_reason).toBe("stop");
      expect(j.choices[0].message.content).toContain("<tool_call>");
    } finally {
      db.prepare("DELETE FROM models WHERE id = ?").run(mid);
      db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
      invalidateModelCache();
    }
  });

  test("router mode: an explicit 'workaround' row drives the adaptation (non-xiaomi id)", async () => {
    const mid = `workaround-model-${RUN}`;
    db.prepare(
      `INSERT INTO models (id, provider_id, upstream_model, name, description, enabled,
         input_modalities, output_modalities, sampling_params, features,
         tool_call_mode, source, created_at, updated_at)
       VALUES (?, ?, ?, '', '', 1, '["text"]', '["text"]', '[]', '[]', 'workaround', 'manual', ?, ?)`,
    ).run(mid, PID, mid, now, now);
    db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, 0, 1, ?)",
    ).run(mid, PID, mid, now);
    db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'router') ON CONFLICT(key) DO UPDATE SET value='router'").run();
    invalidateModelCache();
    try {
      const { req, url } = chatReq({
        model: mid,
        tools: TOOLS,
        messages: [{ role: "user", content: "run ls" }],
      });
      const res = await handleProxy(req, url, undefined);
      expect(res.status).toBe(200);
      // Workaround instruction strips tools and teaches every dialect.
      expect(lastUpstreamBody.tools).toBeUndefined();
      const instr = lastUpstreamBody.messages[lastUpstreamBody.messages.length - 1].content;
      expect(instr).toContain("<function=tool_name_here>");
      // Response recovery still accepts every dialect, but the instruction
      // teaches only the xiaomi format.
      expect(instr).not.toContain("<minimax:tool_call>");
      // The xiaomi-dialect XML response is still recovered.
      const j = await res.json();
      expect(j.choices[0].message.tool_calls?.[0]?.function.name).toBe("exec_bash");
    } finally {
      db.prepare("DELETE FROM models WHERE id = ?").run(mid);
      db.prepare("INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'").run();
      invalidateModelCache();
    }
  });

  test("anti-duplicate (buffered): native tool_calls win, markup stays content", async () => {
    const { req, url } = chatReq({
      model: "deepseek-dup", // fallback mode (native tools kept)
      tools: TOOLS,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const j = await res.json();
    const msg = j.choices[0].message;
    // Exactly ONE call — the native one; the markup is NOT recovered.
    expect(msg.tool_calls.length).toBe(1);
    expect(msg.tool_calls[0].id).toBe("call_native");
    expect(msg.content).toContain("<tool_call>");
  });

  test("anti-duplicate (stream): native tool_calls delta suppresses markup recovery", async () => {
    const { req, url } = chatReq({
      model: "deepseek-dup",
      tools: TOOLS,
      stream: true,
      messages: [{ role: "user", content: "run ls" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(200);
    const sse = await res.text();
    const frames = sse
      .split("\n")
      .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
      .map((l) => JSON.parse(l.slice(6)));
    const toolFrames = frames.flatMap((f: any) => f.choices?.[0]?.delta?.tool_calls ?? []);
    // Only the native call (id call_native) — no recovered duplicate.
    expect(toolFrames.length).toBe(1);
    expect(toolFrames[0].id).toBe("call_native");
    // The markup that arrived after the native delta is plain content.
    const content = frames.map((f: any) => f.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toContain("<tool_call>");
  });
});
