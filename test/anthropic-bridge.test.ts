import { describe, expect, test } from "bun:test";

import {
  anthropicToOpenAI,
  openAIToAnthropicBody,
  openAIErrorToAnthropic,
  translatedUsageFromOpenAI,
  OpenAIToAnthropicStream,
  openAIChatToAnthropic,
  anthropicToOpenAIBody,
  anthropicErrorToOpenAI,
  AnthropicToOpenAIStream,
} from "../server/proxy/anthropic-bridge";

describe("Anthropic → OpenAI request translation", () => {
  test("system, messages, tools and tool results map to chat completions", () => {
    const out = anthropicToOpenAI({
      model: "m",
      max_tokens: 100,
      temperature: 0.5,
      stream: true,
      system: "Be helpful",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "tu1", name: "read", input: { path: "a" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu1", content: "file!" }],
        },
      ],
      tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
    }) as any;
    expect(out.model).toBe("m");
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.messages[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[2].tool_calls).toEqual([
      { id: "tu1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
    ]);
    expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "tu1", content: "file!" });
    expect(out.tools[0].function.name).toBe("read");
    expect(out.tool_choice).toBe("auto");
    expect(out.max_tokens).toBe(100);
  });

  test("images become image_url parts; tool_choice any → required", () => {
    const out = anthropicToOpenAI({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
      ],
      tool_choice: { type: "any" },
    }) as any;
    const parts = out.messages[0].content;
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1].image_url.url).toStartWith("data:image/png;base64,");
  });

  test("error results keep an [error] marker", () => {
    const out = anthropicToOpenAI({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }],
        },
      ],
    }) as any;
    expect(out.messages[0].content).toContain("[error]");
  });
});

describe("OpenAI → Anthropic response translation", () => {
  const oai = JSON.stringify({
    id: "chatcmpl-1",
    model: "up-m",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "working",
          tool_calls: [
            { id: "call1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } },
  });

  test("content blocks, stop reason and usage", () => {
    const j = JSON.parse(openAIToAnthropicBody(oai, "public-m")) as any;
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.model).toBe("up-m");
    expect(j.stop_reason).toBe("tool_use");
    expect(j.content[0]).toEqual({ type: "text", text: "working" });
    expect(j.content[1]).toEqual({
      type: "tool_use",
      id: "call1",
      name: "bash",
      input: { cmd: "ls" },
    });
    expect(j.usage).toEqual({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20 });
  });

  test("fallback model when upstream omits it", () => {
    const j = JSON.parse(openAIToAnthropicBody("{}", "public-m")) as any;
    expect(j.model).toBe("public-m");
    expect(j.stop_reason).toBe("end_turn");
  });

  test("translated usage splits cached input like the native path", () => {
    const u = translatedUsageFromOpenAI(oai);
    expect(u).toMatchObject({ inTok: 100, cacheTok: 20, outTok: 30, estimated: false });
  });

  test("errors are re-enveloped per status", () => {
    const bad = JSON.stringify({ error: { message: "bad key", type: "invalid_request_error" } });
    expect(JSON.parse(openAIErrorToAnthropic(401, bad))).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "bad key" },
    });
    expect(JSON.parse(openAIErrorToAnthropic(429, bad)).error.type).toBe("rate_limit_error");
    expect(JSON.parse(openAIErrorToAnthropic(500, "boom")).error.type).toBe("api_error");
  });
});

describe("OpenAI SSE → Anthropic SSE translator", () => {
  const enc = new TextEncoder();
  const feedLines = (t: OpenAIToAnthropicStream, lines: string[]): string => {
    let s = "";
    for (const line of lines) {
      for (const piece of t.feed(enc.encode(line))) s += new TextDecoder().decode(piece);
    }
    return s;
  };

  test("text + tool call + terminal usage produce a valid event sequence", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    const s = feedLines(t, [
      'data: {"id":"c1","model":"up-m","choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"bash","arguments":"{\\"cmd\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":50,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(s).toContain("event: message_start");
    expect(s).toContain("event: content_block_start");
    expect(s).toContain('"text_delta"');
    expect(s).toContain('"input_json_delta"');
    expect(s).toContain('"stop_reason":"tool_use"');
    expect(s).toContain("event: message_stop");
    const u = t.result();
    expect(u).toMatchObject({ inTok: 50, outTok: 7, estimated: false });
  });

  test("close without [DONE] surfaces an error instead of a clean stop", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    feedLines(t, ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
    let s = "";
    for (const piece of t.flush()) s += new TextDecoder().decode(piece);
    expect(s).toContain("event: error");
    expect(s).toContain("without completing the response");
    expect(s).not.toContain("event: message_stop");
  });

  test("close with an unfinished tool call closes the block and errors", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    feedLines(t, [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"write"}}]}}]}\n\n',
    ]);
    let s = "";
    for (const piece of t.flush()) s += new TextDecoder().decode(piece);
    expect(s).toContain("event: content_block_stop");
    expect(s).toContain("event: error");
    expect(s).not.toContain('"stop_reason":"tool_use"');
  });

  test("reasoning deltas become a thinking block without duplicating details", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    const s = feedLines(t, [
      'data: {"choices":[{"delta":{"reasoning":"We","reasoning_details":[{"type":"reasoning.text","text":"We"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":9,"completion_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(s).toContain('"type":"thinking"');
    expect(s).toContain('"type":"thinking_delta"');
    // "We" once from `reasoning`, not twice via reasoning_details.
    expect(s.match(/We/g)?.length).toBe(1);
    expect(s).toContain("event: message_stop");
  });

  test("reasoning_content deltas become thinking deltas", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    const s = feedLines(t, [
      'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":9,"completion_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(s).toContain('"thinking":"hmm"');
    expect(s).toContain("event: message_stop");
  });
});

describe("OpenAI → Anthropic request translation (reverse)", () => {
  test("system, history, tools and tool results map to messages", async () => {
    const out = await openAIChatToAnthropic({
      model: "up-m",
      temperature: 0.5,
      stop: ["END"],
      tool_choice: "required",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
        { role: "tool", tool_call_id: "call1", content: "a\nb" },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
    });
    expect(out.model).toBe("up-m");
    expect(out.system).toBe("Be brief.");
    expect(out.temperature).toBe(0.5);
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.tool_choice).toEqual({ type: "any" });
    expect(out.max_tokens).toBe(4096);
    const msgs = out.messages as Record<string, unknown>[];
    expect(msgs.length).toBe(3);
    expect(msgs[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_use", id: "call1", name: "bash", input: { cmd: "ls" } }],
    });
    expect(msgs[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call1", content: "a\nb" }],
    });
    const tools = out.tools as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ name: "bash", input_schema: { type: "object" } });
  });

  test("data: image URLs become base64 image blocks; bad tool message throws", async () => {
    const out = await openAIChatToAnthropic({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "see?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
        ],
      }],
    });
    const blocks = (out.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[];
    expect(blocks[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    await expect(openAIChatToAnthropic({
      model: "m",
      messages: [{ role: "tool", content: "x" }],
    })).rejects.toThrow("tool_call_id");
  });
});

describe("Anthropic → OpenAI response translation (reverse)", () => {
  test("text, tool_use, stop reason and usage map to chat completion", () => {
    const s = anthropicToOpenAIBody(
      JSON.stringify({
        id: "msg1",
        model: "up-m",
        content: [
          { type: "text", text: "Run " },
          { type: "tool_use", id: "tu1", name: "bash", input: { cmd: "ls" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
      }),
      "public-m",
    );
    const j = JSON.parse(s);
    expect(j.object).toBe("chat.completion");
    expect(j.model).toBe("up-m");
    expect(j.choices[0].finish_reason).toBe("tool_calls");
    expect(j.choices[0].message.tool_calls[0]).toMatchObject({
      id: "tu1",
      function: { name: "bash", arguments: '{"cmd":"ls"}' },
    });
    expect(j.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 });
  });

  test("errors are re-enveloped per status", () => {
    expect(JSON.parse(anthropicErrorToOpenAI(429, '{"error":{"type":"rate_limit_error","message":"slow"}}')).error).toMatchObject({
      message: "slow",
      type: "rate_limit_error",
    });
    expect(JSON.parse(anthropicErrorToOpenAI(400, "nope")).error.type).toBe("invalid_request_error");
  });
});

describe("Anthropic SSE → OpenAI SSE translator (reverse)", () => {
  const enc = new TextEncoder();
  const feedLines = (t: AnthropicToOpenAIStream, lines: string[]): string => {
    let s = "";
    for (const line of lines) {
      for (const piece of t.feed(enc.encode(line))) s += new TextDecoder().decode(piece);
    }
    return s;
  };

  test("text + tool call + usage produce OpenAI chunks ending in [DONE]", () => {
    const t = new AnthropicToOpenAIStream("public-m");
    const s = feedLines(t, [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg1","model":"up-m","usage":{"input_tokens":10,"cache_read_input_tokens":2}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"bash"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"ls\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    expect(s).toContain('"role":"assistant"');
    expect(s).toContain('"content":"hi"');
    expect(s).toContain('"name":"bash"');
    expect(s).toContain('{\\"cmd\\"');
    expect(s).toContain('"finish_reason":"tool_calls"');
    expect(s).toContain('"completion_tokens":7');
    expect(s.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(t.result()).toMatchObject({ inTok: 10, cacheTok: 2, outTok: 7, estimated: false });
  });

  test("close without message_stop surfaces an error chunk", () => {
    const t = new AnthropicToOpenAIStream("public-m");
    feedLines(t, [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"w"}}\n\n',
    ]);
    let s = "";
    for (const piece of t.flush()) s += new TextDecoder().decode(piece);
    expect(s).toContain('"error"');
    expect(s.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
