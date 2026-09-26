import { describe, expect, test } from "bun:test";

/**
 * "Own workaround" dialect suite: the fenced ```tool_call JSON block.
 *
 * The hard part is the JSON-aware closing-fence state machine: a ``` inside a
 * string VALUE (a model writing a file that itself contains a code fence) must
 * NOT terminate the block early, and the streaming extractor must behave
 * identically at every split boundary.
 */

const { toolHintsFromRequest } = await import("../server/proxy/dsml");
const {
  extractOwnToolCalls,
  OwnStreamExtractor,
  buildOwnToolInstruction,
  ownRecoverer,
} = await import("../server/proxy/own-tools");

const HINTS = toolHintsFromRequest({
  tools: [
    {
      type: "function",
      function: {
        name: "exec_bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
  ],
});

const CANON = 'Sure.\n```tool_call\n{"name": "exec_bash", "arguments": {"cmd": "ls -la"}}\n```\n';

describe("own workaround: fenced JSON extraction", () => {
  test("canonical block becomes a native call, markup stripped", () => {
    const r = extractOwnToolCalls(CANON, HINTS);
    expect(r.changed).toBe(true);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("exec_bash");
    expect(r.calls[0].input).toEqual({ cmd: "ls -la" });
    expect(r.text).toBe("Sure.");
  });

  test("arguments as a JSON string is unwrapped", () => {
    const src = '```tool_call\n{"name": "exec_bash", "arguments": "{\\"cmd\\":\\"ls\\"}"}\n```';
    expect(extractOwnToolCalls(src, HINTS).calls[0].input).toEqual({ cmd: "ls" });
  });

  test("a ``` inside a string VALUE does not close the block early", () => {
    const content = "here is code:\n```\nfoo\n```\ndone";
    const src =
      "```tool_call\n" + JSON.stringify({ name: "write_file", arguments: { path: "a.md", content } }) + "\n```";
    const r = extractOwnToolCalls(src, HINTS);
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("write_file");
    expect(r.calls[0].input).toEqual({ path: "a.md", content });
  });

  test("an escaped quote inside a value does not confuse the state machine", () => {
    const content = 'a "quoted" ``` fence and a \\" escaped quote';
    const src =
      "```tool_call\n" + JSON.stringify({ name: "write_file", arguments: { path: "b.txt", content } }) + "\n```";
    const r = extractOwnToolCalls(src, HINTS);
    expect(r.calls[0].input.content).toBe(content);
  });

  test("an undeclared tool name restores the block verbatim", () => {
    const src = '```tool_call\n{"name": "rm_rf", "arguments": {"path": "/"}}\n```';
    const r = extractOwnToolCalls(src, HINTS);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
    expect(r.calls.length).toBe(0);
  });

  test("an unclosed block is not recovered (conservative)", () => {
    const src = '```tool_call\n{"name": "exec_bash", "arguments": {"cmd": "ls"}}';
    const r = extractOwnToolCalls(src, HINTS);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(src);
  });

  test("malformed JSON restores verbatim", () => {
    const src = "```tool_call\n{not json}\n```";
    expect(extractOwnToolCalls(src, HINTS).changed).toBe(false);
  });

  test("no hints disables recovery entirely", () => {
    expect(extractOwnToolCalls(CANON, []).changed).toBe(false);
  });

  test("multiple blocks become multiple calls", () => {
    const two =
      '```tool_call\n{"name": "exec_bash", "arguments": {"cmd": "ls"}}\n```\n' +
      '```tool_call\n{"name": "write_file", "arguments": {"path": "x", "content": "y"}}\n```';
    const r = extractOwnToolCalls(two, HINTS);
    expect(r.calls.map((c) => c.name)).toEqual(["exec_bash", "write_file"]);
  });
});

describe("own workaround: streaming", () => {
  test("split at every boundary yields the same result as one shot", () => {
    for (let i = 0; i <= CANON.length; i++) {
      const ex = new OwnStreamExtractor(HINTS);
      const emits = [...ex.feed(CANON.slice(0, i)), ...ex.feed(CANON.slice(i)), ...ex.flush()];
      const text = emits.map((e) => ("text" in e ? e.text : "")).join("");
      const calls = emits.filter((e) => "call" in e) as any[];
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].call.argsJson)).toEqual({ cmd: "ls -la" });
      // Trailing whitespace after the block is insignificant.
      expect(text.trim()).toBe("Sure.");
    }
  });

  test("a fence inside a value survives a split at every boundary", () => {
    const content = "code:\n```\nfoo\n```\nend";
    const src =
      "```tool_call\n" + JSON.stringify({ name: "write_file", arguments: { path: "a.md", content } }) + "\n```";
    for (let i = 0; i <= src.length; i++) {
      const ex = new OwnStreamExtractor(HINTS);
      const emits = [...ex.feed(src.slice(0, i)), ...ex.feed(src.slice(i)), ...ex.flush()];
      const calls = emits.filter((e) => "call" in e) as any[];
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].call.argsJson)).toEqual({ path: "a.md", content });
    }
  });

  test("an unclosed block at end of stream restores verbatim", () => {
    const ex = new OwnStreamExtractor(HINTS);
    const src = '```tool_call\n{"name": "exec_bash", "arguments": {"cmd": "ls"}}';
    const emits = [...ex.feed(src), ...ex.flush()];
    expect(emits.map((e) => ("text" in e ? e.text : "")).join("")).toBe(src);
    expect(ex.committed).toBe(0);
  });

  test("disable() releases the held tail and stops recovery", () => {
    const ex = new OwnStreamExtractor(HINTS);
    ex.feed("Checking. ```tool_call\n{\"name\": \"exec_bash\"");
    const released = ex.disable();
    expect(released.map((e) => ("text" in e ? e.text : "")).join("")).toContain("```tool_call");
    expect(ex.active).toBe(false);
    const after = [...ex.feed(CANON), ...ex.flush()];
    expect(after.some((e) => "call" in e)).toBe(false);
    expect(ex.committed).toBe(0);
  });
});

describe("own workaround: raw body + instruction", () => {
  test("chat body: fenced call recovered into tool_calls", () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: CANON }, finish_reason: "stop" }],
    });
    const patched = ownRecoverer(HINTS).patchRaw("openai", body);
    expect(patched).not.toBeNull();
    const j = JSON.parse(patched!);
    expect(j.choices[0].message.tool_calls[0].function.name).toBe("exec_bash");
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(j.choices[0].message.content).toBe("Sure.");
  });

  test("anti-duplicate: a native tool_call suppresses fenced recovery", () => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            content: CANON,
            tool_calls: [{ id: "call_n", type: "function", function: { name: "exec_bash", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(ownRecoverer(HINTS).patchRaw("openai", body)).toBeNull();
  });

  test("the instruction demands the exact fence and lists tools as a JSON array", () => {
    const s = buildOwnToolInstruction([
      { name: "exec_bash", description: "Run a shell command", parameters: { type: "object" } },
    ]);
    expect(s).toContain("```tool_call\n");
    expect(s).toContain('{"name": "tool_name_here", "parameters": {"param_name_1": "value goes here"}}');
    expect(s).toContain("The opening line must be exactly: ```tool_call");
    expect(s).toContain("The closing line must be exactly: ```");
    expect(s).toContain('"name": "exec_bash"');
    expect(s).toContain("Native function calling is DISABLED");
  });
});
