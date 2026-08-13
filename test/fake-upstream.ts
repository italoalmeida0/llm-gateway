/**
 * Fake LLM upstream for development, tests and benchmarks.
 *
 * Exposes BOTH surfaces the gateway may target:
 *   POST /openai/v1/chat/completions    (stream + non-stream, usage incl.)
 *   GET  /openai/v1/models
 *   POST /anthropic/v1/messages         (stream + non-stream, usage incl.)
 *   GET  /anthropic/v1/models
 *
 * Auth: any request must carry `Authorization: Bearer sk-fake-secret`
 * (or `x-api-key: sk-fake-secret`), otherwise it answers like a real
 * provider would (401) — this lets us verify the gateway injects the key.
 *
 * Run standalone:  bun run fake-upstream      (port 3399)
 */

const PORT = Number(process.env.FAKE_UPSTREAM_PORT || 3399);
const SECRET = process.env.FAKE_UPSTREAM_KEY || "sk-fake-secret";
const LATENCY_MS = Number(process.env.FAKE_UPSTREAM_LATENCY || 0);
const CHUNKS = Number(process.env.FAKE_UPSTREAM_CHUNKS || 5);
const CHUNK_INTERVAL_MS = Number(process.env.FAKE_UPSTREAM_CHUNK_INTERVAL || 25);

function authorized(req: Request): boolean {
  const bearer = req.headers.get("authorization");
  const xk = req.headers.get("x-api-key");
  return bearer === `Bearer ${SECRET}` || xk === SECRET;
}

function openai401(): Response {
  return Response.json(
    { error: { message: "Incorrect API key", type: "invalid_request_error", code: "invalid_api_key" } },
    { status: 401 },
  );
}

function anthropic401(): Response {
  return Response.json(
    { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    { status: 401 },
  );
}

const MODEL = "fake-llm-1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function promptGuess(body: any): { inTok: number; reply: string } {
  const s = JSON.stringify(body?.messages ?? body?.prompt ?? "");
  const inTok = Math.max(1, Math.ceil(s.length / 4));
  return { inTok, reply: "Hello from the fake upstream. This is a deterministic test answer." };
}

async function openAiChat(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || !body.model) {
    return Response.json(
      { error: { message: "model is required", type: "invalid_request_error", code: null } },
      { status: 400 },
    );
  }
  await sleep(LATENCY_MS);
  const { inTok, reply } = promptGuess(body);
  const outTok = Math.ceil(reply.length / 4);

  if (body.stream) {
    const includeUsage = body.stream_options?.include_usage === true;
    const words = reply.split(" ");
    const perChunk = Math.max(1, Math.ceil(words.length / CHUNKS));
    const stream = new ReadableStream<string>({
      async start(c) {
        const enc = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        for (let i = 0; i < words.length; i += perChunk) {
          c.enqueue(
            enc({
              id: "chatcmpl-fake",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [
                { index: 0, delta: { content: words.slice(i, i + perChunk).join(" ") + " " }, finish_reason: null },
              ],
            }),
          );
          await sleep(CHUNK_INTERVAL_MS);
        }
        c.enqueue(
          enc({
            id: "chatcmpl-fake",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
        if (includeUsage) {
          c.enqueue(
            enc({
              id: "chatcmpl-fake",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [],
              usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
            }),
          );
        }
        c.enqueue("data: [DONE]\n\n");
        c.close();
      },
    });
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  return Response.json({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  });
}

async function anthropicMessages(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || !body.model) {
    return Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "model is required" } },
      { status: 400 },
    );
  }
  await sleep(LATENCY_MS);
  const { inTok, reply } = promptGuess(body);
  const outTok = Math.ceil(reply.length / 4);

  if (body.stream) {
    const words = reply.split(" ");
    const perChunk = Math.max(1, Math.ceil(words.length / CHUNKS));
    let sent = 0;
    const stream = new ReadableStream<string>({
      async start(c) {
        const ev = (event: string, o: unknown) => `event: ${event}\ndata: ${JSON.stringify(o)}\n\n`;
        c.enqueue(
          ev("message_start", {
            type: "message_start",
            message: {
              id: "msg_fake",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: inTok, output_tokens: 1 },
            },
          }),
        );
        c.enqueue(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        for (let i = 0; i < words.length; i += perChunk) {
          const text = words.slice(i, i + perChunk).join(" ") + " ";
          sent = Math.min(outTok, Math.max(1, Math.ceil((i + perChunk) / 4)));
          c.enqueue(
            ev("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            }),
          );
          await sleep(CHUNK_INTERVAL_MS);
        }
        c.enqueue(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
        c.enqueue(
          ev("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: Math.max(sent, outTok) },
          }),
        );
        c.enqueue(ev("message_stop", { type: "message_stop" }));
        c.close();
      },
    });
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  return Response.json({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: body.model,
    content: [{ type: "text", text: reply }],
    stop_reason: "end_turn",
    usage: { input_tokens: inTok, output_tokens: outTok },
  });
}

// Test introspection: which auth header did the gateway actually send upstream?
let lastAuth: Record<string, string | null> = { authorization: null, "x-api-key": null };

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/__last-auth") return Response.json(lastAuth);
    lastAuth = {
      authorization: req.headers.get("authorization"),
      "x-api-key": req.headers.get("x-api-key"),
    };

    if (p.startsWith("/openai/v1/")) {
      if (!authorized(req)) return openai401();
      if (p === "/openai/v1/chat/completions" && req.method === "POST") return openAiChat(req);
      if (p === "/openai/v1/models" && req.method === "GET") {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fake" }] });
      }
      if (p === "/openai/v1/embeddings" && req.method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        const n = Math.ceil(JSON.stringify(body?.input ?? "").length / 4);
        return Response.json({
          object: "list",
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: body?.model ?? MODEL,
          usage: { prompt_tokens: n, total_tokens: n },
        });
      }
    }

    if (p.startsWith("/anthropic/v1/")) {
      if (!authorized(req)) return anthropic401();
      if (p === "/anthropic/v1/messages" && req.method === "POST") return anthropicMessages(req);
      if (p === "/anthropic/v1/models" && req.method === "GET") {
        return Response.json({
          data: [{ type: "model", id: MODEL, display_name: "Fake LLM 1" }],
          has_more: false,
        });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[fake-upstream] listening on :${server.port} (key: ${SECRET})`);

export { server as fakeUpstream };
