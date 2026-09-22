import { describe, expect, test } from "bun:test";
import {
  normalizeAttemptBody,
  normalizeForTarget,
  applyOutputLimitKey,
  applyBlockFilter,
  profileForTarget,
  compactToolIds,
  DEFAULT_PROFILE,
  type TargetProfile,
} from "../server/proxy/target-profile";

const PROFILE: TargetProfile = { ...DEFAULT_PROFILE, forwardReasoningEffort: false, dropBlockTypes: [] };

describe("target-profile (universal IR pass)", () => {
  test("compliant bodies pass through untouched (same reference)", () => {
    const body = {
      model: "m",
      max_tokens: 50,
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "t", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_abc", content: "ok" },
      ],
    };
    expect(normalizeForTarget(body, PROFILE)).toBe(body);
  });

  test("legacy max_tokens is renamed to max_completion_tokens (strict targets)", () => {
    const out = applyOutputLimitKey({ model: "m", max_tokens: 50, messages: [] }, "max_completion_tokens") as any;
    expect(out.max_completion_tokens).toBe(50);
    expect("max_tokens" in out).toBe(false);
  });

  test("reasoning_effort is stripped when the target does not take it", () => {
    const body = { model: "m", reasoning_effort: "low", messages: [] };
    const out = normalizeForTarget(body, PROFILE) as any;
    expect(out.reasoning_effort).toBeUndefined();
    const kept = normalizeForTarget(body, DEFAULT_PROFILE) as any;
    expect(kept.reasoning_effort).toBe("low");
  });

describe("compactToolIds (strict 64-char tool id cap)", () => {
  const LONG = `call_${"a".repeat(200)}`;
  test("short ids pass through untouched (same object)", () => {
    const body = {
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "t", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_abc", content: "ok" },
      ],
    };
    expect(compactToolIds(body)).toBe(body);
  });
  test("over-long chat ids compact consistently (call + result match)", () => {
    const out = compactToolIds({
      model: "m",
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: LONG, type: "function", function: { name: "t", arguments: "{}" } }] },
        { role: "tool", tool_call_id: LONG, content: "ok" },
      ],
    }) as any;
    expect(out.messages[0].tool_calls[0].id).toBe("tc1");
    expect(out.messages[1].tool_call_id).toBe("tc1");
  });
  test("anthropic tool_use/tool_result blocks compact too", () => {
    const out = compactToolIds({
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: LONG, name: "t", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: LONG, content: "ok" }] },
      ],
    }) as any;
    expect(out.messages[0].content[0].id).toBe("tc1");
    expect(out.messages[1].content[0].tool_use_id).toBe("tc1");
  });
  test("responses input call_ids compact in first-seen order", () => {
    const other = `call_${"b".repeat(100)}`;
    const out = compactToolIds({
      model: "m",
      input: [
        { type: "function_call", call_id: LONG, name: "t", arguments: "{}" },
        { type: "function_call_output", call_id: LONG, output: "ok" },
        { type: "function_call", call_id: other, name: "u", arguments: "{}" },
      ],
    }) as any;
    expect(out.input[0].call_id).toBe("tc1");
    expect(out.input[1].call_id).toBe("tc1");
    expect(out.input[2].call_id).toBe("tc2");
  });
});


  test("default profile keeps portable max_tokens (Meta-class upstreams reject the modern name)", () => {
    expect(DEFAULT_PROFILE.outputLimitKey).toBe("max_tokens");
    const body = { model: "m", max_tokens: 50, messages: [] };
    expect(normalizeForTarget(body, DEFAULT_PROFILE)).toBe(body);
  });

  test("both limit keys present: legacy is dropped (mutually exclusive upstream)", () => {
    const out = applyOutputLimitKey(
      { model: "m", max_tokens: 400, max_completion_tokens: 400, messages: [] },
      "max_completion_tokens",
    ) as any;
    expect(out.max_completion_tokens).toBe(400);
    expect("max_tokens" in out).toBe(false);
    const out2 = applyOutputLimitKey(
      { model: "m", max_tokens: 400, max_completion_tokens: 400, messages: [] },
      "max_tokens",
    ) as any;
    expect("max_tokens" in out2).toBe(false);
  });

  test("long tool ids compact, short ones survive (all three layouts)", () => {
    const LONG = `call_${"a".repeat(200)}`;
    const out = normalizeAttemptBody(
      {
        model: "m",
        max_tokens: 10,
        messages: [
          { role: "assistant", content: null, tool_calls: [{ id: LONG, type: "function", function: { name: "t", arguments: "{}" } }] },
          { role: "tool", tool_call_id: LONG, content: "ok" },
        ],
      },
      { openai_base_url: "https://api.openai.com/v1", upstreamModel: "gpt-5.6-luna" },
    ) as any;
    expect(out.max_completion_tokens).toBe(10);
    expect(out.messages[0].tool_calls[0].id).toBe("tc1");
    expect(out.messages[1].tool_call_id).toBe("tc1");
  });

  test("anthropic tool_use/tool_result ids compact", () => {
    const LONG = `toolu_${"x".repeat(100)}`;
    const out = normalizeAttemptBody(
      {
        model: "m",
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: LONG, name: "t", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: LONG, content: "ok" }] },
        ],
      },
      {},
    ) as any;
    expect(out.messages[0].content[0].id).toBe("tc1");
    expect(out.messages[1].content[0].tool_use_id).toBe("tc1");
  });

  test("narrow targets drop non-portable blocks", () => {
    const narrow: TargetProfile = { ...DEFAULT_PROFILE, dropBlockTypes: ["citations"] };
    const out = applyBlockFilter(
      { model: "m", messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }, { type: "citations", text: "x" }] }] },
      narrow.dropBlockTypes,
    ) as any;
    expect(out.messages[0].content).toHaveLength(1);
    expect(out.messages[0].content[0].type).toBe("text");
  });

  test("responses reasoning object is stripped for non-reasoning targets", () => {
    const body = { model: "m", reasoning: { effort: "low" }, input: "hi" };
    expect((normalizeForTarget(body, DEFAULT_PROFILE, "gpt-4o-mini") as any).reasoning).toBeUndefined();
    expect((normalizeForTarget(body, DEFAULT_PROFILE, "gpt-5.6-luna") as any).reasoning).toEqual({ effort: "low" });
    expect((normalizeForTarget(body, DEFAULT_PROFILE, "muse-spark-1.3-contributor") as any).reasoning).toEqual({ effort: "low" });
  });

  test("glm/z-ai targets FORWARD reasoning_effort (A/B: effort helps them answer)", () => {
    // Live A/B 2026-09-22 on z-ai/glm-5.3-flash, same snake prompt, 4000 toks:
    // WITHOUT effort: 4000/4000 reasoning, finish:length, zero text (28s);
    // WITH effort:"low": finish:stop, 3388 chars of code, 0 reasoning (8s).
    expect(profileForTarget({ upstreamModel: "z-ai/glm-5.3-flash" }).forwardReasoningEffort).toBe(true);
    expect(profileForTarget({ upstreamModel: "hf:zai-org/GLM-4.7-Flash" }).forwardReasoningEffort).toBe(true);
    expect(profileForTarget({ upstreamModel: "muse-spark-1.3-contributor" }).forwardReasoningEffort).toBe(true);
  });

  test("API family owns strictness: openai base is strict, openrouter is tolerant (same luna model)", () => {
    // Live A/B 2026-09-22, model openai/gpt-5.6-luna both sides:
    // api.openai.com 400s max_tokens + temperature 0.5; OpenRouter 200s both.
    const strict = profileForTarget({ openai_base_url: "https://api.openai.com/v1", upstreamModel: "gpt-5.6-luna" });
    expect(strict.outputLimitKey).toBe("max_completion_tokens");
    expect(strict.temperaturePolicy).toBe("drop-non-default");
    const tolerant = profileForTarget({ openai_base_url: "https://openrouter.ai/api/v1", upstreamModel: "openai/gpt-5.6-luna" });
    expect(tolerant.outputLimitKey).toBe("max_tokens");
    expect(tolerant.temperaturePolicy).toBe("drop-non-default");
  });

  test("meta family keeps the classic output-limit name", () => {
    const p = profileForTarget({ openai_base_url: "https://api.meta.ai/v1", upstreamModel: "muse-spark-1.3-contributor" });
    expect(p.outputLimitKey).toBe("max_tokens");
  });

  test("unknown/custom bases fall back to portable generic defaults", () => {
    const p = profileForTarget({ openai_base_url: "https://my-proxy.local/v1", upstreamModel: "some-custom-model" });
    expect(p.outputLimitKey).toBe("max_tokens");
  });

  test("luna-class models get the strict profile", () => {
    // Backstop for strictly-behaving custom bases (family unknown): the
    // model exception still tightens the rule. On api.openai.com the
    // family already owns it (see test above).
    const p = profileForTarget({ openai_base_url: "https://my-proxy.local/v1", upstreamModel: "gpt-5.6-luna" });
    expect(p.outputLimitKey).toBe("max_completion_tokens");
    expect(p.temperaturePolicy).toBe("drop-non-default");
  });

  test("round-trip: normalized body renormalizes to itself (idempotent)", () => {
    const LONG = `call_${"q".repeat(99)}`;
    const once = normalizeAttemptBody(
      { model: "m", max_completion_tokens: 5, messages: [{ role: "tool", tool_call_id: LONG, content: "x" }] },
      {},
    );
    expect(normalizeAttemptBody(once as Record<string, unknown>, {})).toBe(once);
  });
});

describe("gateway IR (hub-and-spoke translation)", () => {
  test("3x3 request round-trip preserves tools and multi-turn results", async () => {
    const { decodeToIR, encodeIR } = await import("../server/proxy/gateway-ir");
    const chatBody = {
      model: "m",
      messages: [
        { role: "user", content: "w in Paris?" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
        { role: "tool", tool_call_id: "t1", content: "sunny 21C" },
      ],
      tools: [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } }],
      tool_choice: "required",
      max_tokens: 200,
    };
    for (const ingress of ["openai", "anthropic", "responses"] as const) {
      const src = ingress === "openai" ? chatBody : await decodeToIR("openai", chatBody).then((ir) => encodeIR(ingress, ir, "m"));
      for (const egress of ["openai", "anthropic", "responses"] as const) {
        const ir = await decodeToIR(ingress, src as Record<string, unknown>);
        const out = encodeIR(egress, ir, "m2") as Record<string, unknown>;
        expect(out.model).toBe("m2");
        const back = await decodeToIR(egress, out);
        expect(back.tools.map((t) => t.name)).toEqual(["get_weather"]);
        const kinds = back.messages.flatMap((m) => m.blocks.map((b) => b.type));
        expect(kinds).toContain("tool_use");
        expect(kinds).toContain("tool_result");
      }
    }
  });

  test("google thought_signature round-trips through the IR", async () => {
    const { decodeToIR, encodeIR } = await import("../server/proxy/gateway-ir");
    const chatBody = {
      model: "models/gemini-3.8-flash",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "run", arguments: "{}" }, extra_content: { google: { thought_signature: "sig123" } } },
          ],
          extra_content: { google: { thought_signature: "sig123" } },
        },
      ],
      max_tokens: 50,
    };
    const ir = await decodeToIR("openai", chatBody);
    expect(ir.messages.flatMap((m) => m.blocks).filter((b) => b.type === "thinking")).toHaveLength(1);
    // Same-model egress replays the signature on the message AND the call.
    const out = encodeIR("openai", ir, "models/gemini-3.8-flash") as any;
    const msg = out.messages[1];
    expect(msg.extra_content?.google?.thought_signature).toBe("sig123");
    expect(msg.tool_calls[0]?.extra_content?.google?.thought_signature).toBe("sig123");
    // Cross-provider egress without a signature demotes (Gemini 400 rule).
    const demoted = encodeIR("openai", await decodeToIR("openai", {
      model: "m",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [{ id: "t9", type: "function", function: { name: "w", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "t9", content: "r" },
      ],
    }), "models/gemini-3.8-flash") as any;
    expect(JSON.stringify(demoted)).not.toContain("tool_calls");
    expect(JSON.stringify(demoted)).not.toContain("tool_call_id");
  });

  test("9-way stream matrix terminates with content", async () => {
    const { IRStreamTranslator } = await import("../server/proxy/gateway-ir");
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const frames: Record<string, string[]> = {
      openai: [
        'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ],
      anthropic: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      responses: [
        'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"m0","output_index":0,"content_index":0,"delta":"Hi"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"usage":{"input_tokens":10,"input_tokens_details":{},"output_tokens":3,"output_tokens_details":{},"total_tokens":13}}}\n\n',
      ],
    };
    for (const up of ["openai", "anthropic", "responses"] as const) {
      for (const cl of ["openai", "anthropic", "responses"] as const) {
        const t = new IRStreamTranslator(up, cl, "m");
        let all = "";
        for (const f of frames[up]) for (const p of t.feed(enc.encode(f))) all += dec.decode(p);
        for (const p of t.flush()) all += dec.decode(p);
        expect(all).toContain("Hi");
        if (cl === "openai") expect(all).toContain("data: [DONE]");
        if (cl === "anthropic") expect(all).toContain("event: message_stop");
        if (cl === "responses") expect(all).toContain("event: response.completed");
      }
    }
  });
});

describe("passthrough affinity (right provider first)", () => {
  test("id-shape heuristics route each family to its provider", async () => {
    const { scoreAffinity } = await import("../server/models");
    const snap: any = {
      targets: new Map(),
      providers: new Map(
        ["syn", "meta", "or", "xai", "oai", "gem", "ant"].map((name, i) => [
          `p${i}`,
          { row: { id: `p${i}`, name, openai_base_url: "https://x", anthropic_base_url: name === "syn" || name === "meta" ? "https://x" : null, responses_base_url: name === "meta" ? "https://x" : null }, keys: [{ id: "k", key: "k", status: "active", failCount: 0, cooldownUntil: null }] },
        ]),
      ),
    };
    expect(scoreAffinity(snap, "hf:Qwen/Qwen3.8-27B", "openai")).toBe("p0"); // syn
    expect(scoreAffinity(snap, "hf:Qwen/Qwen3.8-27B", "anthropic")).toBe("p0"); // syn HAS anthropic cap
    expect(scoreAffinity(snap, "muse-spark-1.3-contributor", "openai")).toBe("p1"); // meta
    expect(scoreAffinity(snap, "z-ai/glm-5.3-flash", "openai")).toBe("p2"); // or
    expect(scoreAffinity(snap, "grok-4.7", "responses")).toBe("p3"); // xai
    expect(scoreAffinity(snap, "gpt-5.6-luna", "openai")).toBe("p4"); // oai
    expect(scoreAffinity(snap, "models/gemini-3.8-flash", "openai")).toBe("p5"); // gem
    expect(scoreAffinity(snap, "claude-haiku-4-5", "anthropic")).toBe("p6"); // ant native
  });
});
