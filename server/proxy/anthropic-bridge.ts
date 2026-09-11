/**
 * Protocol translation for upstream providers that only expose one
 * capability endpoint.
 *
 * Anthropic → OpenAI: an Anthropic-protocol client request (`POST
 * /v1/messages`) is rewritten to an OpenAI chat-completions request before
 * the fetch, and the OpenAI response (buffered JSON or SSE) is converted
 * back to the Anthropic envelope before it reaches the client. This is
 * the only way OpenAI-only providers stay reachable on the Anthropic
 * surface (which the daemon speaks exclusively).
 *
 * OpenAI → Anthropic: the mirror direction. An OpenAI-protocol client
 * request (`POST /v1/chat/completions`) is rewritten to an Anthropic
 * messages request, and the Anthropic response is converted back to the
 * OpenAI envelope. Only used when the provider exposes no OpenAI
 * endpoint at all.
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
      let responsesReasoning: Record<string, unknown> | null = null;
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
          let isResponsesReasoning = false;
          try {
            if (block.data.startsWith("{")) {
              const parsed = JSON.parse(block.data);
              if (parsed && (parsed.type === "reasoning" || (typeof parsed.id === "string" && parsed.id.startsWith("rs_")))) {
                responsesReasoning = parsed;
                isResponsesReasoning = true;
              }
            }
          } catch {}
          if (!isResponsesReasoning) {
            // Replay Google Gemini thought_signature when available
            googleThoughtSignature = block.data;
          }
        }
      }
      if (typeof m.content === "string") text = m.content;
      const msg: Record<string, unknown> = { role: "assistant" };
      if (text) msg.content = text;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (responsesReasoning) {
        msg.responses_reasoning = responsesReasoning;
        msg.extra_content = {
          ...asRecord(msg.extra_content),
          responses_reasoning: responsesReasoning,
        };
      }
      if (googleThoughtSignature) {
        msg.extra_content = {
          ...asRecord(msg.extra_content),
          google: {
            thought_signature: googleThoughtSignature,
          },
        };
        for (const tc of toolCalls) {
          tc.extra_content = {
            ...asRecord(tc.extra_content),
            google: {
              thought_signature: googleThoughtSignature,
            },
          };
        }
      }
      if (text || toolCalls.length || googleThoughtSignature || responsesReasoning) messages.push(msg);
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

/** Reasoning text on a buffered OpenAI message (same field variance as streams). */
function bufferedReasoning(message: Record<string, unknown>): string {
  for (const key of ["reasoning", "reasoning_content"]) {
    if (typeof message[key] === "string" && message[key]) return message[key] as string;
  }
  let out = "";
  for (const raw of asArr(message.reasoning_details)) {
    const text = asRecord(raw).text;
    if (typeof text === "string") out += text;
  }
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
  const rr = asRecord(asRecord(message.extra_content).responses_reasoning);
  if (rr && (rr.id || rr.encrypted_content)) {
    content.push({
      type: "redacted_thinking",
      data: JSON.stringify({
        type: "reasoning",
        id: typeof rr.id === "string" ? rr.id : "",
        ...(typeof rr.encrypted_content === "string" ? { encrypted_content: rr.encrypted_content } : {}),
      }),
    });
  } else if (typeof googleSig === "string" && googleSig) {
    content.push({ type: "redacted_thinking", data: googleSig });
  }
  const reasoningText = bufferedReasoning(message);
  if (reasoningText) {
    content.push({ type: "thinking", thinking: reasoningText });
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
  private thinkingOpen = false;
  private thinkingIndex = 0;
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

  private ensureThinking(out: Uint8Array[]): void {
    out.push(...this.header());
    if (!this.thinkingOpen) {
      this.thinkingIndex = this.nextIndex++;
      this.thinkingOpen = true;
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: this.thinkingIndex,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
    }
  }

  private closeThinking(out: Uint8Array[]): void {
    if (this.thinkingOpen) {
      this.thinkingOpen = false;
      out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: this.thinkingIndex }));
    }
  }

  /**
   * Reasoning text carried by OpenAI-style deltas. Providers disagree on
   * the field: DeepSeek sends `reasoning_content`, OpenRouter normalizes
   * to `reasoning` plus a duplicative `reasoning_details` list. The
   * consolidated field wins; details are only a fallback so the same
   * tokens are never forwarded twice.
   */
  private extractReasoning(delta: Record<string, unknown>): string {
    const direct = delta.reasoning ?? delta.reasoning_content;
    if (typeof direct === "string" && direct) return direct;
    let out = "";
    for (const raw of asArr(delta.reasoning_details)) {
      const text = asRecord(raw).text;
      if (typeof text === "string") out += text;
    }
    return out;
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
      const reasoning = this.extractReasoning(delta);
      if (reasoning) {
        this.ensureThinking(out);
        out.push(
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.thinkingIndex,
            delta: { type: "thinking_delta", thinking: reasoning },
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
    this.closeThinking(out);
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

  /**
   * Terminal events when upstream closes without [DONE] and without a
   * finish chunk. The response is definitionally truncated, so this
   * surfaces an error instead of a clean stop: a half-streamed tool
   * call must never look like a finished turn.
   */
  flush(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [...this.header()];
    this.closeText(out);
    this.closeThinking(out);
    for (const t of this.tools.values()) {
      if (t.announced) {
        out.push(sseEvent("content_block_stop", { type: "content_block_stop", index: t.index }));
      }
    }
    out.push(
      sseEvent("error", {
        type: "error",
        error: {
          type: "api_error",
          message: "upstream closed the stream without completing the response",
        },
      }),
    );
    return out;
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

// ================= OpenAI → Anthropic (reverse direction) =================

/** Anthropic requires max_tokens; OpenAI clients often omit it. */
const REVERSE_DEFAULT_MAX_TOKENS = 4096;

/** Cap for server-side fetch of remote image URLs referenced by OpenAI clients. */
const REVERSE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const REVERSE_IMAGE_TIMEOUT_MS = 15_000;

function openAIToolChoiceToAnthropic(choice: unknown): Record<string, unknown> | string | undefined {
  if (choice === undefined || choice === null || choice === "auto") return undefined;
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  const r = asRecord(choice);
  const fn = asRecord(r.function);
  if (r.type === "function" && typeof fn.name === "string") return { type: "tool", name: fn.name };
  return undefined;
}

/** OpenAI `image_url` → Anthropic image block. data: URLs are decoded
 *  inline; remote URLs are fetched server-side (capped). Returns null
 *  when the URL cannot be turned into an image. */
async function imageUrlToAnthropic(url: unknown): Promise<Record<string, unknown> | null> {
  if (typeof url !== "string") return null;
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (data) {
    if (!data[2]) return null; // only base64 data URLs are supported
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[3] } };
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REVERSE_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const mime = (res.headers.get("content-type") || "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok || !mime.startsWith("image/")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > REVERSE_MAX_IMAGE_BYTES) return null;
    return { type: "image", source: { type: "base64", media_type: mime, data: Buffer.from(buf).toString("base64") } };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function openAIPartToText(part: unknown): string {
  const r = asRecord(part);
  if (r.type === "text" && typeof r.text === "string") return r.text;
  if (typeof r.text === "string" && r.type === undefined) return r.text;
  return "";
}

/**
 * Convert an OpenAI `POST /chat/completions` body to an Anthropic
 * `POST /v1/messages` body. `model` is already the per-attempt upstream
 * model id (the caller rewrites it before calling).
 */
export async function openAIChatToAnthropic(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    model: body.model,
    stream: body.stream === true,
  };

  const systemParts: string[] = [];
  const messages: Record<string, unknown>[] = [];
  // tool_result blocks must leave as their own user message — OpenAI
  // packs them as `role: tool` messages between the assistant turn and
  // the next user turn.
  let pendingToolResults: Record<string, unknown>[] = [];
  const flushTools = () => {
    if (pendingToolResults.length) {
      messages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const raw of asArr(body.messages)) {
    const m = asRecord(raw);
    const role = m.role;
    if (role === "system") {
      if (typeof m.content === "string" && m.content) systemParts.push(m.content);
      else for (const p of asArr(m.content)) {
        const t = openAIPartToText(p);
        if (t) systemParts.push(t);
      }
      continue;
    }
    if (role === "tool") {
      const toolId = m.tool_call_id;
      if (typeof toolId !== "string" || !toolId) {
        throw new Error("tool message is missing tool_call_id");
      }
      const content = typeof m.content === "string"
        ? m.content
        : asArr(m.content).map(openAIPartToText).filter(Boolean).join("\n");
      pendingToolResults.push({ type: "tool_result", tool_use_id: toolId, content });
      continue;
    }
    if (role === "assistant") {
      flushTools();
      const content: Record<string, unknown>[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content });
      }
      for (const tc of asArr(m.tool_calls)) {
        const r = asRecord(tc);
        const fn = asRecord(r.function);
        if (typeof r.id !== "string" || typeof fn.name !== "string") continue;
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
      if (content.length) messages.push({ role: "assistant", content });
      continue;
    }
    // user role (anything else is passed through as user text when string)
    flushTools();
    if (typeof m.content === "string") {
      if (m.content) messages.push({ role: "user", content: m.content });
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    for (const p of asArr(m.content)) {
      const r = asRecord(p);
      if (r.type === "image_url") {
        const img = await imageUrlToAnthropic(asRecord(r.image_url).url);
        if (!img) throw new Error("unsupported image_url (only base64 data: URLs and reachable image http(s) URLs are supported)");
        blocks.push(img);
      } else {
        const t = openAIPartToText(p);
        if (t) blocks.push({ type: "text", text: t });
      }
    }
    if (blocks.length) messages.push({ role: "user", content: blocks });
  }
  flushTools();

  if (systemParts.length) out.system = systemParts.join("\n");
  out.messages = messages;

  const tools = asArr(body.tools);
  if (tools.length) {
    out.tools = tools.map((t) => {
      const fn = asRecord(asRecord(t).function);
      return {
        name: fn.name,
        description: typeof fn.description === "string" ? fn.description : undefined,
        input_schema: fn.parameters ?? { type: "object" },
      };
    });
    const choice = openAIToolChoiceToAnthropic(body.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }

  const maxTok = body.max_tokens ?? body.max_completion_tokens;
  out.max_tokens = typeof maxTok === "number" && maxTok > 0 ? Math.floor(maxTok) : REVERSE_DEFAULT_MAX_TOKENS;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const stop = body.stop;
  const stops = (Array.isArray(stop) ? stop : typeof stop === "string" ? [stop] : []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (stops.length) out.stop_sequences = stops;
  return out;
}

function anthropicStopToOpenAI(stop: unknown, hasTools: boolean): string {
  if (hasTools) return "tool_calls";
  switch (stop) {
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

function anthropicUsageToOpenAI(usage: unknown): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const u = asRecord(usage);
  const input = Number(u.input_tokens ?? 0) || 0;
  const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheCreation = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? 0) || 0;
  const prompt = input + cacheRead + cacheCreation;
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output };
}

/**
 * Convert a buffered Anthropic messages response to an OpenAI
 * chat-completions response. `fallbackModel` is the public model id the
 * client asked for (used when the upstream omits it).
 */
export function anthropicToOpenAIBody(anthropicText: string, fallbackModel: string): string {
  let j: Record<string, unknown>;
  try {
    j = asRecord(JSON.parse(anthropicText));
  } catch {
    j = {};
  }
  let text = "";
  let toolIndex = 0;
  const toolCalls: Record<string, unknown>[] = [];
  for (const b of asArr(j.content)) {
    const block = asRecord(b);
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        index: toolIndex++,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking / redacted_thinking have no OpenAI channel and are dropped;
    // their tokens remain counted in usage.
  }
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const model = typeof j.model === "string" && j.model ? j.model : fallbackModel;
  return JSON.stringify({
    id: typeof j.id === "string" ? j.id : `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: anthropicStopToOpenAI(j.stop_reason, toolCalls.length > 0),
      },
    ],
    usage: anthropicUsageToOpenAI(j.usage),
  });
}

/** Re-envelope an Anthropic error body as an OpenAI error body. */
export function anthropicErrorToOpenAI(status: number, bodyText: string): string {
  let message = bodyText.slice(0, 2000);
  try {
    const j = asRecord(JSON.parse(bodyText));
    const err = asRecord(j.error);
    if (typeof err.message === "string" && err.message) message = err.message;
  } catch {
    /* keep raw text */
  }
  const type =
    status === 401
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "server_error"
          : "invalid_request_error";
  return JSON.stringify({ error: { message, type, code: null } });
}

function openAIChunk(id: string, model: string, choice: Record<string, unknown>, usage?: Record<string, number>): Uint8Array {
  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, ...choice }],
  };
  if (usage) payload.usage = usage;
  return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Incremental Anthropic-SSE → OpenAI-SSE translator for the streaming
 * relay. Feed raw upstream bytes; take OpenAI SSE bytes out. The stream
 * always terminates with `data: [DONE]` as OpenAI clients require.
 */
export class AnthropicToOpenAIStream {
  private pending = "";
  private decoder = new TextDecoder();
  private roleSent = false;
  private upstreamId = "";
  private model = "";
  private toolOrdinal = new Map<number, number>();
  private nextTool = 0;
  private finishReason: unknown = null;
  private inTok = 0;
  private cacheTok = 0;
  private outTok = 0;
  private usageSeen = false;
  private done = false;

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
      out.push(...this.processData(data));
      if (this.done) break;
    }
    return out;
  }

  private head(): { id: string; model: string } {
    return {
      id: this.upstreamId || `chatcmpl-${Date.now().toString(36)}`,
      model: this.model || this.fallbackModel,
    };
  }

  private ensureRole(out: Uint8Array[]): void {
    if (this.roleSent) return;
    this.roleSent = true;
    const { id, model } = this.head();
    out.push(openAIChunk(id, model, { delta: { role: "assistant", content: "" }, finish_reason: null }));
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    let j: Record<string, unknown>;
    try {
      j = asRecord(JSON.parse(data));
    } catch {
      return [];
    }
    if (j.type === "error") {
      const err = asRecord(j.error);
      out.push(
        enc.encode(
          `data: ${JSON.stringify({ error: { message: err.message ?? "upstream error", type: err.type ?? "server_error", code: null } })}\n\n`,
        ),
      );
      out.push(enc.encode("data: [DONE]\n\n"));
      this.done = true;
      return out;
    }
    if (j.type === "message_start") {
      const message = asRecord(j.message);
      if (typeof message.id === "string") this.upstreamId = message.id;
      else if (typeof j.id === "string") this.upstreamId = j.id;
      if (typeof message.model === "string" && message.model) this.model = message.model;
      const usage = asRecord(message.usage);
      if (usage.input_tokens !== undefined) {
        this.inTok = Number(usage.input_tokens) || 0;
        this.cacheTok =
          (Number(usage.cache_read_input_tokens) || 0) + (Number(usage.cache_creation_input_tokens) || 0);
        this.usageSeen = true;
      }
      return out;
    }
    if (j.type === "content_block_start") {
      const block = asRecord(j.content_block);
      const index = Number((j as Record<string, unknown>).index ?? 0) || 0;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.ensureRole(out);
        const ordinal = this.nextTool++;
        this.toolOrdinal.set(index, ordinal);
        const { id, model } = this.head();
        out.push(
          openAIChunk(id, model, {
            delta: {
              tool_calls: [
                { index: ordinal, id: block.id, type: "function", function: { name: block.name, arguments: "" } },
              ],
            },
            finish_reason: null,
          }),
        );
      }
      return out;
    }
    if (j.type === "content_block_delta") {
      const index = Number((j as Record<string, unknown>).index ?? 0) || 0;
      const delta = asRecord(j.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        this.ensureRole(out);
        const { id, model } = this.head();
        out.push(openAIChunk(id, model, { delta: { content: delta.text }, finish_reason: null }));
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
        const ordinal = this.toolOrdinal.get(index) ?? 0;
        this.ensureRole(out);
        const { id, model } = this.head();
        out.push(
          openAIChunk(id, model, {
            delta: { tool_calls: [{ index: ordinal, function: { arguments: delta.partial_json } }] },
            finish_reason: null,
          }),
        );
      }
      // thinking_delta / signature_delta have no OpenAI channel.
      return out;
    }
    if (j.type === "message_delta") {
      const delta = asRecord(j.delta);
      if (delta.stop_reason !== undefined) this.finishReason = delta.stop_reason;
      const usage = asRecord(j.usage);
      if (usage.output_tokens !== undefined) {
        this.outTok = Number(usage.output_tokens) || 0;
        this.usageSeen = true;
      }
      return out;
    }
    if (j.type === "message_stop") {
      const { id, model } = this.head();
      const prompt = this.inTok + this.cacheTok;
      const finish = this.finishReason === "tool_use" || this.toolOrdinal.size > 0 ? "tool_calls" : anthropicStopToOpenAI(this.finishReason, false);
      out.push(
        openAIChunk(
          id,
          model,
          { delta: {}, finish_reason: finish },
          { prompt_tokens: prompt, completion_tokens: this.outTok, total_tokens: prompt + this.outTok },
        ),
      );
      out.push(enc.encode("data: [DONE]\n\n"));
      this.done = true;
      return out;
    }
    return out;
  }

  /**
   * Terminal chunks when upstream closes without message_stop. The
   * response is truncated, so this surfaces an error chunk (then
   * [DONE]) instead of a clean finish — mirroring the forward
   * direction, a half-streamed tool call must never look finished.
   */
  flush(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [
      enc.encode(
        `data: ${JSON.stringify({ error: { message: "upstream closed the stream without completing the response", type: "server_error", code: null } })}\n\n`,
      ),
      enc.encode("data: [DONE]\n\n"),
    ];
    return out;
  }

  result(): TranslatedUsage {
    return {
      inTok: this.inTok,
      cacheTok: this.cacheTok,
      outTok: this.outTok,
      model: this.model,
      estimated: !this.usageSeen,
    };
  }
}
