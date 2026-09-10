/**
 * Anthropic → OpenAI translation for upstream providers that only expose an
 * OpenAI-compatible endpoint.
 *
 * One direction only: an Anthropic-protocol client request (`POST
 * /v1/messages`) is rewritten to an OpenAI chat-completions request before
 * the fetch, and the OpenAI response (buffered JSON or SSE) is converted
 * back to the Anthropic envelope before it reaches the client. There is no
 * reverse translation and no legacy fallback — the daemon speaks Anthropic
 * exclusively and this bridge is the only way OpenAI-only providers stay
 * reachable on the Anthropic surface.
 */

interface TranslatedUsage {
  inTok: number;
  cacheTok: number;
  outTok: number;
  model: string;
  estimated: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function blockText(v: unknown): string {
  const r = asRecord(v);
  return typeof r.text === "string" ? r.text : "";
}

/** Anthropic `system` (string or content blocks) → plain string. */
function anthropicSystemToString(system: unknown): string {
  if (typeof system === "string") return system;
  return asArr(system)
    .filter((b) => asRecord(b).type === "text")
    .map(blockText)
    .join("\n");
}

/** Anthropic image `source` → OpenAI `image_url` data URL. */
function imageSourceToDataUrl(source: unknown): string | null {
  const s = asRecord(source);
  if (s.type !== "base64" || typeof s.media_type !== "string" || typeof s.data !== "string") {
    return null;
  }
  return `data:${s.media_type};base64,${s.data}`;
}

function toolResultToString(content: unknown): string {
  if (typeof content === "string") return content;
  return asArr(content)
    .map((b) => {
      const r = asRecord(b);
      if (r.type === "text" && typeof r.text === "string") return r.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Convert an Anthropic `POST /v1/messages` body to an OpenAI
 * `POST /chat/completions` body. `model` is already the per-attempt upstream
 * model id (the caller rewrites it before calling).
 */
export function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    stream: body.stream === true,
  };

  const system = anthropicSystemToString(body.system);
  const messages: Record<string, unknown>[] = [];
  if (system) messages.push({ role: "system", content: system });

  // Pending user fragments accumulate until a tool_result (or the message
  // end) forces a flush — Anthropic nests tool_result blocks inside a user
  // message while OpenAI wants one `role: tool` message per result.
  let textBuf = "";
  let media: Array<Record<string, unknown>> = [];
  const flushUser = () => {
    if (!textBuf && media.length === 0) return;
    if (media.length === 0) {
      messages.push({ role: "user", content: textBuf });
    } else {
      const parts: Record<string, unknown>[] = [];
      if (textBuf) parts.push({ type: "text", text: textBuf });
      parts.push(...media);
      messages.push({ role: "user", content: parts });
    }
    textBuf = "";
    media = [];
  };

  for (const raw of asArr(body.messages)) {
    const m = asRecord(raw);
    if (m.role === "assistant") {
      flushUser();
      let text = "";
      let googleThoughtSignature = "";
      const toolCalls: Record<string, unknown>[] = [];
      for (const b of asArr(m.content)) {
        const block = asRecord(b);
        if (typeof m.content === "string") break;
        if (block.type === "text" && typeof block.text === "string") {
          text += (text ? "\n" : "") + block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        } else if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
          // Replay Google Gemini thought_signature when available
          googleThoughtSignature = block.data;
        }
      }
      if (typeof m.content === "string") text = m.content;
      const msg: Record<string, unknown> = { role: "assistant" };
      if (text) msg.content = text;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (googleThoughtSignature) {
        msg.extra_content = {
          google: {
            thought_signature: googleThoughtSignature,
          },
        };
        for (const tc of toolCalls) {
          tc.extra_content = {
            google: {
              thought_signature: googleThoughtSignature,
            },
          };
        }
      }
      if (text || toolCalls.length || googleThoughtSignature) messages.push(msg);
    } else {
      // user role (tool_result blocks arrive nested here)
      if (typeof m.content === "string") {
        textBuf += (textBuf ? "\n" : "") + m.content;
        continue;
      }
      for (const b of asArr(m.content)) {
        const block = asRecord(b);
        if (block.type === "text" && typeof block.text === "string") {
          textBuf += (textBuf ? "\n" : "") + block.text;
        } else if (block.type === "image") {
          const url = imageSourceToDataUrl(block.source);
          if (url) media.push({ type: "image_url", image_url: { url } });
        } else if (block.type === "tool_result") {
          flushUser();
          const content = toolResultToString(block.content);
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: content + (block.is_error === true ? " [error]" : ""),
          });
        }
      }
    }
  }
  flushUser();

  out.messages = messages;

  const tools = asArr(body.tools);
  if (tools.length) {
    out.tools = tools.map((t) => {
      const r = asRecord(t);
      return {
        type: "function",
        function: {
          name: r.name,
          description: typeof r.description === "string" ? r.description : undefined,
          parameters: r.input_schema ?? {},
        },
      };
    });
    const choice = asRecord(body.tool_choice);
    if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "tool" && typeof choice.name === "string") {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    } else out.tool_choice = "auto";
  }

  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.reasoning_effort === "string") {
    out.reasoning_effort = body.reasoning_effort;
  } else if (asRecord(body.thinking).type === "enabled") {
    out.reasoning_effort = "high";
  }
  const stop = asArr(body.stop_sequences).filter((s): s is string => typeof s === "string");
  if (stop.length) out.stop = stop;
  if (out.stream === true) out.stream_options = { include_usage: true };
  return out;
}

function openAIFinishToAnthropic(finish: unknown): string {
  switch (finish) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function openAIUsageToAnthropic(usage: unknown): Record<string, number> {
  const u = asRecord(usage);
  const prompt = Number(u.prompt_tokens ?? 0) || 0;
  const cached = Number(asRecord(u.prompt_tokens_details).cached_tokens ?? 0) || 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: Number(u.completion_tokens ?? 0) || 0,
    cache_read_input_tokens: Math.max(0, cached),
  };
}

/**
 * Convert a buffered OpenAI chat-completions response to an Anthropic
 * `POST /v1/messages` response. `fallbackModel` is the public model id the
 * client asked for (used when the upstream omits it).
 */
export function openAIToAnthropicBody(openaiText: string, fallbackModel: string): string {
  let j: Record<string, unknown>;
  try {
    j = asRecord(JSON.parse(openaiText));
  } catch {
    j = {};
  }
  const choices = asArr(j.choices);
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const content: Record<string, unknown>[] = [];
  let googleSig = asRecord(asRecord(message.extra_content).google).thought_signature;
  if (!googleSig) {
    for (const tc of asArr(message.tool_calls)) {
      const s = asRecord(asRecord(asRecord(tc).extra_content).google).thought_signature;
      if (typeof s === "string" && s) {
        googleSig = s;
        break;
      }
    }
  }
  if (typeof googleSig === "string" && googleSig) {
    content.push({ type: "redacted_thinking", data: googleSig });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const tc of asArr(message.tool_calls)) {
    const r = asRecord(tc);
    const fn = asRecord(r.function);
    let input: unknown = {};
    if (typeof fn.arguments === "string" && fn.arguments) {
      try {
        input = JSON.parse(fn.arguments);
      } catch {
        input = {};
      }
    }
    content.push({ type: "tool_use", id: r.id, name: fn.name, input });
  }
  const resp = {
    id: typeof j.id === "string" ? j.id : `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model: typeof j.model === "string" && j.model ? j.model : fallbackModel,
    content,
    stop_reason: content.some((c) => c.type === "tool_use")
      ? "tool_use"
      : openAIFinishToAnthropic(first.finish_reason),
    stop_sequence: null,
    usage: openAIUsageToAnthropic(j.usage),
  };
  return JSON.stringify(resp);
}

/** Usage of a buffered translated response, parsed from the OpenAI body. */
export function translatedUsageFromOpenAI(openaiText: string): TranslatedUsage {
  try {
    const j = asRecord(JSON.parse(openaiText));
    const u = openAIUsageToAnthropic(j.usage);
    const hasUsage = asRecord(j.usage).prompt_tokens !== undefined;
    return {
      inTok: u.input_tokens,
      cacheTok: u.cache_read_input_tokens,
      outTok: u.output_tokens,
      model: typeof j.model === "string" ? j.model : "",
      estimated: !hasUsage,
    };
  } catch {
    return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: true };
  }
}

/** Re-envelope an OpenAI error body as an Anthropic error body. */
export function openAIErrorToAnthropic(status: number, bodyText: string): string {
  let message = bodyText.slice(0, 2000);
  try {
    const parsed = JSON.parse(bodyText);
    const j = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
    const err = asRecord(j.error);
    if (typeof err.message === "string" && err.message) message = err.message;
    else if (typeof j.message === "string" && j.message) message = j.message;
  } catch {
    /* keep raw text */
  }
  const type =
    status === 401
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "api_error"
          : "invalid_request_error";
  return JSON.stringify({ type: "error", error: { type, message } });
}

const enc = new TextEncoder();

function sseEvent(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Incremental OpenAI-SSE → Anthropic-SSE translator for the streaming relay.
 * Feed raw upstream bytes; take Anthropic SSE bytes out. Memory stays
 * O(longest event line): text deltas stream through, only tool-argument
 * fragments accumulate per block (as the daemon does on its own side).
 */
export class OpenAIToAnthropicStream {
  private pending = "";
  private decoder = new TextDecoder();
  private headerSent = false;
  private textOpen = false;
  private textIndex = 0;
  private nextIndex = 0;
  private thoughtSigSent = false;
  private tools = new Map<number, { index: number; id: string; name: string; announced: boolean }>();
  private model = "";
  private upstreamId = "";
  private finishReason: unknown = null;
  private promptTokens = 0;
  private cachedTokens = 0;
  private completionTokens = 0;
  private done = false;
  /** Capped sample feeding usage estimation when upstream omits usage. */
  private outChars = 0;

  constructor(private fallbackModel: string) {}

  get isDone(): boolean {
    return this.done;
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    if (this.done) return [];
    this.pending += this.decoder.decode(chunk, { stream: true });
    const out: Uint8Array[] = [];
    for (;;) {
      const idx = this.pending.indexOf("\n");
      if (idx === -1) break;
      let line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        out.push(...this.finish());
        break;
      }
      out.push(...this.processData(data));
      if (this.done) break;
    }
    return out;
  }

  private header(): Uint8Array[] {
    if (this.headerSent) return [];
    this.headerSent = true;
    const model = this.model || this.fallbackModel;
    return [
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: this.upstreamId || `msg_${Date.now().toString(36)}`,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ];
  }

  private ensureText(out: Uint8Array[]): void {
    out.push(...this.header());
    if (!this.textOpen) {
      this.textIndex = this.nextIndex++;
      this.textOpen = true;
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.textIndex,
          content_block: { type: "text", text: "" },
        }),
      );
    }
  }

  private closeText(out: Uint8Array[]): void {
    if (this.textOpen) {
      this.textOpen = false;
      out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: this.textIndex }));
    }
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    let j: Record<string, unknown>;
    try {
      j = asRecord(JSON.parse(data));
    } catch {
      return [];
    }
    if (asRecord(j.error).message) {
      // Mid-stream error: close as an error stop.
      this.finishReason = "error";
      return this.finish();
    }
    if (typeof j.id === "string" && !this.upstreamId) this.upstreamId = j.id;
    if (typeof j.model === "string" && j.model && !this.model) this.model = j.model;
    const usage = asRecord(j.usage);
    if (usage.prompt_tokens !== undefined) {
      this.promptTokens = Number(usage.prompt_tokens) || 0;
      this.cachedTokens = Number(asRecord(usage.prompt_tokens_details).cached_tokens) || 0;
      this.completionTokens = Number(usage.completion_tokens) || 0;
      // If choices already supplied finishReason in a prior chunk, this is the terminal usage chunk.
      if (this.finishReason) {
        out.push(...this.finish());
        return out;
      }
    }
    for (const ch of asArr(j.choices)) {
      const c = asRecord(ch);
      const delta = asRecord(c.delta);

      let googleSig =
        asRecord(asRecord(delta.extra_content).google).thought_signature ??
        asRecord(asRecord(c.extra_content).google).thought_signature;
      if (!googleSig) {
        for (const rawTc of asArr(delta.tool_calls)) {
          const s = asRecord(asRecord(asRecord(rawTc).extra_content).google).thought_signature;
          if (typeof s === "string" && s) {
            googleSig = s;
            break;
          }
        }
      }
      if (typeof googleSig === "string" && googleSig && !this.thoughtSigSent) {
        this.thoughtSigSent = true;
        this.closeText(out);
        out.push(...this.header());
        const sigIndex = this.nextIndex++;
        out.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: sigIndex,
            content_block: { type: "redacted_thinking", data: googleSig },
          }),
          sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: sigIndex,
          }),
        );
      }

      const text = delta.content;
      if (typeof text === "string" && text) {
        this.ensureText(out);
        this.outChars += text.length;
        out.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.textIndex,
            delta: { type: "text_delta", text },
          }),
        );
      }
      const rawToolCalls = asArr(delta.tool_calls);
      for (let i = 0; i < rawToolCalls.length; i++) {
        const tc = asRecord(rawToolCalls[i]);
        const idx = typeof tc.index === "number" ? tc.index : i;
        let t = this.tools.get(idx);
        if (!t) {
          t = { index: this.nextIndex++, id: "", name: "", announced: false };
          this.tools.set(idx, t);
        }
        const fn = asRecord(tc.function);
        if (typeof tc.id === "string" && tc.id) t.id = tc.id;
        if (typeof fn.name === "string" && fn.name) t.name = fn.name;
        else if (typeof tc.name === "string" && tc.name) t.name = tc.name;
        if (!t.announced && t.id && t.name) {
          t.announced = true;
          this.closeText(out);
          out.push(...this.header());
          out.push(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index: t.index,
              content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
            }),
          );
        }
        const args = typeof fn.arguments === "string" ? fn.arguments : "";
        if (args && t.announced) {
          out.push(
            sseEvent("content_block_delta", {
              type: "content_block_delta",
              index: t.index,
              delta: { type: "input_json_delta", partial_json: args },
            }),
          );
        }
      }
      if (c.finish_reason) {
        this.finishReason = c.finish_reason;
        const hasTools = Array.from(this.tools.values()).some((t) => t.announced);
        if (usage.prompt_tokens !== undefined || this.promptTokens > 0 || hasTools) {
          out.push(...this.finish());
          break;
        }
      }
    }
    return out;
  }

  private finish(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [...this.header()];
    this.closeText(out);
    for (const t of this.tools.values()) {
      if (t.announced) {
        out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: t.index }));
      }
    }
    const hasTools = Array.from(this.tools.values()).some((t) => t.announced);
    const stopReason = hasTools
      ? "tool_use"
      : this.finishReason === "error"
        ? "end_turn"
        : openAIFinishToAnthropic(this.finishReason);

    out.push(
      sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: { output_tokens: this.completionTokens || 0 },
      }),
      sseEvent("message_stop", { type: "message_stop" }),
    );
    return out;
  }

  /** Flush terminal Anthropic events when upstream closes without [DONE]. */
  flush(): Uint8Array[] {
    return this.finish();
  }

  result(): TranslatedUsage {
    return {
      inTok: Math.max(0, this.promptTokens - this.cachedTokens),
      cacheTok: Math.max(0, this.cachedTokens),
      outTok: this.completionTokens,
      model: this.model,
      // No terminal usage chunk and no output observed: the caller falls
      // back to request-body (input) and text-sample (output) estimates.
      estimated: this.promptTokens === 0 && this.completionTokens === 0,
    };
  }

  get outputChars(): number {
    return this.outChars;
  }
}
