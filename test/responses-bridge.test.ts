import { describe, expect, test } from "bun:test";

import {
  responsesToChat,
  chatToResponsesRequest,
  anthropicToResponsesRequest,
  chatToResponsesBody,
  anthropicToResponsesBody,
  responsesToChatBody,
  responsesToAnthropicBody,
  parseResponsesJson,
  ChatToResponsesStream,
  AnthropicToResponsesStream,
  ResponsesToChatStream,
  ResponsesToAnthropicStream,
} from "../server/proxy/responses-bridge";

const enc = new TextEncoder();
const dec = new TextDecoder();

function runStream(
  t: { feed(c: Uint8Array): Uint8Array[]; flush(): Uint8Array[] },
  lines: string[],
): { events: { event: string; data: any }[]; raw: string } {
  let raw = "";
  for (const line of lines) {
    for (const piece of t.feed(enc.encode(line))) raw += dec.decode(piece);
  }
  for (const piece of t.flush()) raw += dec.decode(piece);
  const events: { event: string; data: any }[] = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data: any = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const d = line.slice(5).trim();
        data = d === "[DONE]" ? "[DONE]" : JSON.parse(d);
      }
    }
    events.push({ event, data });
  }
  return { events, raw };
}

describe("Responses → chat request translation", () => {
  test("instructions, input items, tools and effort map over", () => {
    const out = responsesToChat({
      model: "m",
      instructions: "Be terse",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: "calc", arguments: '{"a":6}' },
        { type: "function_call_output", call_id: "c1", output: "42" },
      ],
      tools: [{ type: "function", name: "calc", description: "mul", parameters: { type: "object" } }],
      tool_choice: "auto",
      reasoning: { effort: "high" },
      max_output_tokens: 50,
      stream: true,
    }) as any;
    expect(out.messages[0]).toEqual({ role: "system", content: "Be terse" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "calc", arguments: '{"a":6}' } }],
    });
    expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "42" });
    expect(out.tools[0].function.name).toBe("calc");
    expect(out.reasoning_effort).toBe("high");
    expect(out.max_completion_tokens).toBe(50);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  test("instructions merge with leading developer messages; store is dropped", () => {
    const out = responsesToChat({
      model: "m",
      instructions: "sys",
      store: false,
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }) as any;
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toEqual({ role: "system", content: "sys\n\ndev" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect("store" in out).toBe(false);
  });

  test("string input becomes one user message; hosted tools are dropped", () => {
    const out = responsesToChat({
      model: "m",
      input: "hello",
      tools: [{ type: "web_search" }, { type: "function", name: "f", parameters: {} }],
    }) as any;
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(out.tools).toHaveLength(1);
  });

  test("input images map to image_url parts", () => {
    const out = responsesToChat({
      model: "m",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "see" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    }) as any;
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });
});

describe("chat → Responses request translation", () => {
  test("system becomes instructions; tool calls become function_call items", () => {
    const out = chatToResponsesRequest({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [{ id: "c9", type: "function", function: { name: "calc", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c9", content: "42" },
      ],
      reasoning_effort: "low",
      max_tokens: 33,
    }) as any;
    expect(out.instructions).toBe("sys");
    expect(out.input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
    expect(out.input[1]).toMatchObject({ type: "message", role: "assistant" });
    expect(out.input[2]).toMatchObject({ type: "function_call", call_id: "c9", name: "calc" });
    // Response-scoped item id must carry the fc_ prefix strict upstreams require.
    expect(String(out.input[2].id)).toMatch(/^fc_/);
    expect(out.input[3]).toEqual({ type: "function_call_output", call_id: "c9", output: "42" });
    expect(out.reasoning).toEqual({ effort: "low" });
    expect(out.max_output_tokens).toBe(33);
  });
});

describe("buffered response translation", () => {
  const chat = JSON.stringify({
    id: "chatcmpl-1",
    model: "m",
    choices: [
      {
        message: {
          role: "assistant",
          content: "hello",
          tool_calls: [{ id: "c1", type: "function", function: { name: "calc", arguments: '{"a":1}' } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  });

  test("chat → responses keeps text, calls and usage", () => {
    const r = JSON.parse(chatToResponsesBody(chat, "pub")) as any;
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    const kinds = r.output.map((o: any) => o.type);
    expect(kinds).toEqual(["message", "function_call"]);
    expect(r.output[0].content[0]).toMatchObject({ type: "output_text", text: "hello" });
    expect(r.output[1]).toMatchObject({ name: "calc", call_id: "c1" });
    expect(r.usage).toMatchObject({ input_tokens: 100, output_tokens: 30 });
  });

  test("length finish becomes incomplete/max_output_tokens", () => {
    const j = JSON.parse(chat);
    j.choices[0].finish_reason = "length";
    j.choices[0].message.tool_calls = undefined;
    const r = JSON.parse(chatToResponsesBody(JSON.stringify(j), "pub")) as any;
    expect(r.status).toBe("incomplete");
    expect(r.incomplete_details).toEqual({ reason: "max_output_tokens" });
  });

  const resp = JSON.stringify({
    id: "resp-1",
    object: "response",
    model: "m",
    status: "completed",
    output: [
      { type: "message", id: "msg-1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] },
      { type: "function_call", id: "fc-1", call_id: "call-1", name: "calc", arguments: '{"a":2}', status: "completed" },
    ],
    usage: {
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 70,
    },
  });

  test("responses → chat keeps text, calls and buckets", () => {
    const c = JSON.parse(responsesToChatBody(resp, "pub")) as any;
    expect(c.object).toBe("chat.completion");
    expect(c.choices[0].message.content).toBe("hi");
    expect(c.choices[0].message.tool_calls[0]).toMatchObject({ id: "call-1" });
    expect(c.choices[0].finish_reason).toBe("tool_calls");
    expect(c.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 20 });
  });

  test("responses usage splits cached input", () => {
    expect(parseResponsesJson(resp)).toMatchObject({ inTok: 40, cacheTok: 10, outTok: 20, estimated: false });
  });

  test("chat round-trips through responses without text loss", () => {
    const back = JSON.parse(responsesToChatBody(chatToResponsesBody(chat, "pub"), "pub")) as any;
    expect(back.choices[0].message.content).toBe("hello");
    expect(back.choices[0].message.tool_calls[0].function.name).toBe("calc");
  });

  test("anthropic composes through chat in both directions", () => {
    const anth = JSON.stringify({
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "hey" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    const asResponses = JSON.parse(anthropicToResponsesBody(anth, "pub")) as any;
    expect(asResponses.output[0].content[0]).toMatchObject({ type: "output_text", text: "hey" });
    expect(asResponses.usage).toMatchObject({ input_tokens: 12, output_tokens: 4 });
    const req = anthropicToResponsesRequest({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) as any;
    expect(req.input[0]).toMatchObject({ type: "message", role: "user" });
    const back = JSON.parse(responsesToAnthropicBody(resp, "pub")) as any;
    expect(back.content[0]).toMatchObject({ type: "text", text: "hi" });
    expect(back.stop_reason).toBe("tool_use");
  });
});

describe("stream translation", () => {
  const chatLines = [
    'data: {"id":"chatcmpl-9","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-9","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-9","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
    "data: [DONE]\n\n",
  ];

  test("chat SSE → responses SSE ends with response.completed", () => {
    const t = new ChatToResponsesStream("pub");
    const { events } = runStream(t, chatLines);
    const types = events.map((e) => e.data?.type ?? e.data);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    const last = events[events.length - 1]!;
    expect(last.data.type).toBe("response.completed");
    expect(last.data.response.usage).toMatchObject({ input_tokens: 8, output_tokens: 3 });
    expect(t.isDone).toBe(true);
    expect(t.result()).toMatchObject({ inTok: 8, outTok: 3, estimated: false });
  });

  test("tool stream carries full arguments in done + completed snapshot", () => {
    const t = new ChatToResponsesStream("pub");
    const chunk = (delta: unknown) =>
      `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
    const { events } = runStream(t, [
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "calc", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":6}' } }] }),
      `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const done = events.find((e) => e.data?.type === "response.output_item.done" && e.data?.item?.type === "function_call")!;
    expect(done.data.item.arguments).toBe('{"a":6}');
    const last = events[events.length - 1]!;
    expect(last.data.type).toBe("response.completed");
    const fc = last.data.response.output.find((o: any) => o.type === "function_call")!;
    expect(fc).toMatchObject({ call_id: "call_1", name: "calc", arguments: '{"a":6}' });
  });

  test("per-chunk usage (Google-style) does not truncate the stream", () => {
    const t = new ChatToResponsesStream("pub");
    const chunk = (delta: unknown, usage = false) =>
      `data: ${JSON.stringify({
        id: "c1",
        model: "m",
        choices: [{ index: 0, delta, finish_reason: null }],
        ...(usage ? { usage: { prompt_tokens: 9, completion_tokens: 1 } } : {}),
      })}\n\n`;
    const { events } = runStream(t, [
      chunk({ content: "I" }, true),
      chunk({ content: " am here" }, true),
      `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const deltas = events.filter((e) => e.data?.type === "response.output_text.delta").map((e) => e.data.delta);
    expect(deltas.join("")).toBe("I am here");
    const last = events[events.length - 1]!;
    expect(last.data.type).toBe("response.completed");
  });

  test("bare upstream close becomes response.incomplete, never silent", () => {
    const t = new ChatToResponsesStream("pub");
    const { events } = runStream(t, [chatLines[0]!]);
    const last = events[events.length - 1]!;
    expect(["response.completed", "response.incomplete"]).toContain(last.data.type);
    expect(t.isDone).toBe(true);
  });

  const respLines = [
    'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp-7","object":"response","model":"m","status":"in_progress"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"item_id":"msg-1","output_index":0,"content_index":0,"delta":"Hel"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg-1","output_index":0,"content_index":0,"delta":"lo"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"id":"resp-7","model":"m","status":"completed","usage":{"input_tokens":8,"input_tokens_details":{"cached_tokens":0},"output_tokens":3,"output_tokens_details":{},"total_tokens":11}}}\n\n',
  ];

  test("responses SSE → chat SSE ends with [DONE] and usage", () => {
    const t = new ResponsesToChatStream("pub");
    const { events, raw } = runStream(t, respLines);
    expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const chunks = events.map((e) => e.data).filter((d) => d !== "[DONE]");
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks[1].choices[0].delta.content).toBe("Hel");
    const lastChunk = chunks[chunks.length - 1]!;
    expect(lastChunk.choices[0].finish_reason).toBe("stop");
    expect(lastChunk.usage).toMatchObject({ prompt_tokens: 8, completion_tokens: 3 });
    expect(t.isDone).toBe(true);
  });

  test("responses SSE → anthropic SSE ends with message_stop", () => {
    const t = new ResponsesToAnthropicStream("pub");
    const { events } = runStream(t, respLines);
    const types = events.map((e) => e.data.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_delta");
    expect(types.slice(-2)).toEqual(["message_delta", "message_stop"]);
    expect(t.isDone).toBe(true);
    expect(t.result()).toMatchObject({ inTok: 8, outTok: 3, estimated: false });
  });

  const anthLines = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-5","model":"m","usage":{"input_tokens":6,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  test("anthropic SSE → responses SSE ends with response.completed", () => {
    const t = new AnthropicToResponsesStream("pub");
    const { events } = runStream(t, anthLines);
    const types = events.map((e) => e.data.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    const last = events[events.length - 1]!;
    expect(last.data.type).toBe("response.completed");
    expect(last.data.response.usage).toMatchObject({ input_tokens: 6, output_tokens: 2 });
    expect(t.result()).toMatchObject({ inTok: 6, outTok: 2, estimated: false });
  });

  test("responses SSE → anthropic SSE preserves encrypted reasoning as redacted_thinking", () => {
    const lines = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","model":"m"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"rs_abc","type":"reasoning","summary":[]}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"rs_abc","type":"reasoning","encrypted_content":"enc_secret_blob","summary":[]}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"toolA","arguments":""}}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"toolA","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","model":"m","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    ];
    const t = new ResponsesToAnthropicStream("pub");
    const { events } = runStream(t, lines);
    const starts = events.filter((e) => e.event === "content_block_start");
    expect(starts.length).toBe(2);
    expect(starts[0].data.content_block.type).toBe("redacted_thinking");
    const parsed = JSON.parse(starts[0].data.content_block.data);
    expect(parsed).toEqual({ type: "reasoning", id: "rs_abc", encrypted_content: "enc_secret_blob" });
    expect(starts[1].data.content_block.type).toBe("tool_use");
    expect(starts[1].data.content_block.id).toBe("call_1");

    // Next turn: client sends back the assistant turn with redacted_thinking + tool_use
    const req = anthropicToResponsesRequest({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: starts[0].data.content_block.data },
            { type: "tool_use", id: "call_1", name: "toolA", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
        },
      ],
    });
    const items = req.input as any[];
    expect(items.length).toBe(4);
    expect(items[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] });
    expect(items[1]).toEqual({ type: "reasoning", id: "rs_abc", encrypted_content: "enc_secret_blob", summary: [] });
    expect(items[2]).toMatchObject({ type: "function_call", call_id: "call_1", name: "toolA" });
    expect(items[3]).toEqual({ type: "function_call_output", call_id: "call_1", output: "ok" });
  });

  test("anthropic SSE → responses SSE translates redacted_thinking into reasoning item", () => {
    const payload = JSON.stringify({ type: "reasoning", id: "rs_test", encrypted_content: "blob123" });
    const lines = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-6","model":"m","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":${JSON.stringify(payload)}}}\n\n`,
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const t = new AnthropicToResponsesStream("pub");
    const { events } = runStream(t, lines);
    const added = events.find((e) => e.data.type === "response.output_item.added");
    expect(added).toBeDefined();
    expect(added!.data.item).toEqual({
      id: "rs_test",
      type: "reasoning",
      status: "completed",
      encrypted_content: "blob123",
      summary: [],
    });
  });
});

