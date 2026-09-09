import { describe, expect, test } from "bun:test";

import {
  anthropicToOpenAI,
  openAIToAnthropicBody,
  openAIErrorToAnthropic,
  translatedUsageFromOpenAI,
  OpenAIToAnthropicStream,
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

  test("close without [DONE] still terminates the sequence", () => {
    const t = new OpenAIToAnthropicStream("public-m");
    feedLines(t, ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
    let s = "";
    for (const piece of t.flush()) s += new TextDecoder().decode(piece);
    expect(s).toContain("event: message_stop");
  });
});
