import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { decodeToIR, encodeIR, decodeResponseToIR, encodeResponseFromIR, IRStreamTranslator, type Proto } from "../server/proxy/gateway-ir";
import { compactToolIds, applyOutputLimitKey, normalizeAttemptBody } from "../server/proxy/target-profile";
import { StreamText } from "../server/proxy/stream-text";

const enc = new TextEncoder();
const dec = new TextDecoder();
const frame = (event: string, body: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(body)}\n\n`;
function translate(up: Proto, down: Proto, wire: string, bytewise = false): any[] {
  const t = new IRStreamTranslator(up, down, "test-model");
  const chunks: Uint8Array[] = [];
  const bytes = enc.encode(wire);
  try {
    if (bytewise) for (const byte of bytes) chunks.push(...t.feed(new Uint8Array([byte])));
    else chunks.push(...t.feed(bytes));
    chunks.push(...t.flush());
    return chunks.map((b) => dec.decode(b)).join("").split("\n").filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6)));
  } finally { t.dispose(); }
}
const chatParallel = frame("", { choices: [{ delta: { tool_calls: [
  { index: 0, id: "call_a", type: "function", function: { name: "first", arguments: '{"a":' } },
  { index: 1, id: "call_b", type: "function", function: { name: "second", arguments: '{"b":' } },
] } }] }) + frame("", { choices: [{ delta: { tool_calls: [
  { index: 0, function: { arguments: "1}" } }, { index: 1, function: { arguments: "2}" } },
] } }] }) + frame("", { choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
const responseTool = frame("response.output_item.added", { output_index: 0, item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "echo", arguments: "" } }) +
  frame("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: '{"value":' }) +
  frame("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 0, delta: '"OK"}' }) +
  frame("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, arguments: '{"value":"OK"}' }) +
  frame("response.output_item.done", { output_index: 0, item: { id: "fc_1", call_id: "call_1", type: "function_call", name: "echo", arguments: '{"value":"OK"}' } }) +
  frame("response.completed", { response: { usage: { input_tokens: 5, output_tokens: 4 } } });
function calls(events: any[], proto: Proto): Array<{ id: string; name: string; args: string }> {
  if (proto === "responses") return events.find((e) => e.type === "response.completed").response.output.filter((i: any) => i.type === "function_call").map((i: any) => ({ id: i.call_id, name: i.name, args: i.arguments }));
  const found = new Map<number, { id: string; name: string; args: string }>();
  for (const e of events) {
    if (proto === "anthropic") {
      if (e.type === "content_block_start" && e.content_block.type === "tool_use") found.set(e.index, { id: e.content_block.id, name: e.content_block.name, args: "" });
      if (e.delta?.type === "input_json_delta") found.get(e.index)!.args += e.delta.partial_json;
    } else for (const t of e.choices?.[0]?.delta?.tool_calls ?? []) {
      if (!found.has(t.index)) found.set(t.index, { id: "", name: "", args: "" });
      const c = found.get(t.index)!;
      c.id += t.id ?? "";
      c.name += t.function?.name ?? "";
      c.args += t.function?.arguments ?? "";
    }
  }
  return [...found.values()];
}
describe("IR streaming regressions", () => {
  for (const proto of ["openai", "anthropic", "responses"] as const) {
    test(`Responses argument snapshots do not duplicate deltas into ${proto}`, () => {
      expect(calls(translate("responses", proto, responseTool, true), proto)).toEqual([{ id: "call_1", name: "echo", args: '{"value":"OK"}' }]);
    });
    test(`parallel tools remain independent into ${proto}`, () => {
      const events = translate("openai", proto, chatParallel, true);
      expect(calls(events, proto)).toEqual([{ id: "call_a", name: "first", args: '{"a":1}' }, { id: "call_b", name: "second", args: '{"b":2}' }]);
      if (proto === "anthropic") expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([0, 1]);
    });
    test(`upstream errors remain failures into ${proto}`, () => {
      for (const [source, wire] of [
        ["anthropic", frame("error", { type: "error", error: { type: "overloaded_error", message: "Busy" } })],
        ["responses", frame("response.failed", { response: { error: { code: "server_error", message: "Busy" } } })],
        ["openai", frame("", { error: { type: "server_error", message: "Busy" } })],
      ] as const) {
        const events = translate(source, proto, wire);
        expect(JSON.stringify(events)).toContain("Busy");
        expect(events.some((e) => e.type === "message_stop" || e.type === "response.completed" || e.choices?.[0]?.finish_reason)).toBe(false);
        if (proto === "responses") expect(events.at(-1).response.status).toBe("failed");
      }
    });
    test(`reasoning remains distinct from the answer into ${proto}`, () => {
      const wire = frame("", { choices: [{ delta: { reasoning_content: "Thinking" } }] }) + frame("", { choices: [{ delta: { content: "Answer" } }] }) + "data: [DONE]\n\n";
      const events = translate("openai", proto, wire);
      if (proto === "openai") {
        expect(events.flatMap((e) => e.choices ?? []).map((c) => c.delta?.content).filter(Boolean)).toEqual(["Answer"]);
        expect(JSON.stringify(events)).toContain('"reasoning_content":"Thinking"');
      } else if (proto === "anthropic") expect(events.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text)).toEqual(["Answer"]);
      else expect(events.filter((e) => e.type === "response.output_text.delta").map((e) => e.delta)).toEqual(["Answer"]);
    });
  }
  test("Anthropic parallel blocks survive every destination", () => {
    const wire = frame("content_block_start", { index: 2, content_block: { type: "tool_use", id: "a", name: "first", input: {} } }) + frame("content_block_start", { index: 3, content_block: { type: "tool_use", id: "b", name: "second", input: {} } }) + frame("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }) + frame("content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '{"b":2}' } }) + frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
    for (const proto of ["openai", "anthropic", "responses"] as const) expect(calls(translate("anthropic", proto, wire), proto)).toEqual([{ id: "a", name: "first", args: '{"a":1}' }, { id: "b", name: "second", args: '{"b":2}' }]);
  });
  test("length and tool_calls survive a trailing usage chunk", () => {
    for (const reason of ["length", "tool_calls"]) {
      const wire = frame("", { choices: [{ delta: {}, finish_reason: reason }] }) + frame("", { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + "data: [DONE]\n\n";
      const event = translate("openai", "openai", wire).at(-1);
      expect(event.choices[0].finish_reason).toBe(reason);
      expect(event.usage.completion_tokens).toBe(2);
    }
  });
  test("Anthropic terminal usage reaches the client before message_stop", () => {
    const wire = frame("message_start", { message: { usage: { input_tokens: 10 } } }) + frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
    expect(translate("anthropic", "anthropic", wire).find((e) => e.type === "message_delta").usage.output_tokens).toBe(5);
    expect(translate("anthropic", "openai", wire).at(-1).usage.completion_tokens).toBe(5);
  });
  test("Responses incomplete and abrupt EOF never become completed", () => {
    const events = translate("responses", "responses", frame("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 3, output_tokens: 2 } } }));
    expect(events.at(-1).response.status).toBe("incomplete");
    const abrupt = translate("openai", "responses", frame("", { choices: [{ delta: { content: "partial" } }] }));
    expect(abrupt.at(-1).response.status).toBe("failed");
  });
  test("buffered Responses preserves incomplete and failed status", () => {
    for (const status of ["incomplete", "failed"]) {
      const ir = decodeResponseToIR("responses", JSON.stringify({ status, output: [], error: status === "failed" ? { code: "server_error", message: "Busy" } : null }), "m");
      expect(JSON.parse(encodeResponseFromIR("responses", ir, "m")).status).toBe(status);
    }
  });
});
describe("IR request and target regressions", () => {
  test("developer instructions remain instructions", async () => {
    const ir = await decodeToIR("openai", { model: "m", messages: [{ role: "developer", content: "Answer JSON" }, { role: "user", content: "hello" }] });
    expect(encodeIR("anthropic", ir, "m").system).toBe("Answer JSON");
    expect(encodeIR("responses", ir, "m").instructions).toBe("Answer JSON");
  });
  test("thinking budgets respect capability, output budget and forced tool choice", async () => {
    for (const max of [128, 1024, 1025, 4096]) {
      const ir = await decodeToIR("openai", { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: max, reasoning_effort: "high", temperature: 0.2 });
      const body: any = encodeIR("anthropic", ir, "claude-haiku-4-5");
      expect(body.max_tokens).toBe(max);
      if (max <= 1024) expect(body.thinking).toBeUndefined();
      else { expect(body.thinking.budget_tokens).toBeLessThan(max); expect(body.temperature).toBeUndefined(); }
      expect(encodeIR("anthropic", ir, "claude-3-haiku").thinking).toBeUndefined();
      ir.toolChoice = { mode: "required" };
      expect(encodeIR("anthropic", ir, "claude-haiku-4-5").thinking).toBeUndefined();
    }
  });
  test("chat encode emits reasoning_effort only for reasoning targets or explicit client effort (live 2026-09-26: gpt-4o-mini 400s it)", async () => {
    const base = { model: "m", system: "", warnings: [], messages: [{ role: "user" as const, blocks: [{ type: "text" as const, text: "hi" }] }], tools: [], toolChoice: { mode: "auto" as const }, params: {} };
    expect((encodeIR("openai", base, "gpt-4o-mini") as any).reasoning_effort).toBeUndefined();
    expect((encodeIR("openai", base, "gpt-5.6-luna") as any).reasoning_effort).toBe("low");
    const asked = { ...base, params: { reasoningEffort: "high" } };
    expect((encodeIR("openai", asked, "gpt-4o-mini") as any).reasoning_effort).toBe("high");
  });
  test("compacted tool ids cannot collide with existing ids", () => {
    const long = "a".repeat(100);
    const body: any = compactToolIds({ input: [{ type: "function_call", call_id: long }, { type: "function_call", call_id: "tc1" }, { type: "function_call_output", call_id: long }] });
    expect(body.input.map((i: any) => i.call_id)).toEqual(["tc2", "tc1", "tc2"]);
  });
  test("chat output-limit normalization never renames Anthropic max_tokens", () => {
    expect(normalizeAttemptBody({ max_tokens: 128 }, { via: "anthropic", upstreamModel: "luna", anthropic_base_url: "https://custom.test/v1" })).toEqual({ max_tokens: 128 });
  });
  test("deduplication emits the target key with the modern value", () => {
    expect(applyOutputLimitKey({ max_tokens: 1, max_completion_tokens: 2 }, "max_tokens")).toEqual({ max_tokens: 2 });
  });
  test("large snapshots spill and are removed on completion or cancellation", () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("llmgw-stream-")));
    const buffer = new StreamText();
    const text = "á🙂".repeat(40000);
    try { buffer.append(text); expect(buffer.text()).toBe(text); }
    finally { buffer.dispose(); }
    for (const cancel of [false, true]) {
      const t = new IRStreamTranslator("openai", "responses", "m");
      t.feed(enc.encode(frame("", { choices: [{ delta: { content: text } }] })));
      if (!cancel) {
        const tail = t.feed(enc.encode("data: [DONE]\n\n")).map((b) => dec.decode(b)).join("");
        expect(tail).toContain(text);
      }
      t.dispose();
    }
    expect(new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("llmgw-stream-")))).toEqual(before);
  });
});
