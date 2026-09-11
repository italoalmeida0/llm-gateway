/**
 * OpenAI Responses API translation: the third protocol surface.
 *
 * Every ordered pair of protocols has a translator, so any provider
 * capability can serve any gateway surface (see `upstreamPreference` in
 * ../models.ts):
 *
 *   responses -> chat-completions   `responsesToChat` (sync, direct)
 *   chat-completions -> responses   `chatToResponsesRequest` (sync, direct)
 *   responses -> anthropic          composes responsesToChat + openAIChatToAnthropic
 *   anthropic -> responses          composes anthropicToOpenAI + chatToResponsesRequest
 *
 * Response/error/usage conversion composes the same way (buffered bodies
 * chain through the chat-completions shape; streams get dedicated
 * translators below). Responses errors already use the OpenAI
 * `{error:{...}}` envelope, so Chat <-> Responses error paths are
 * byte-passthrough and only the Anthropic direction re-envelopes.
 *
 * Fidelity notes (documented, not silent):
 * - Hosted tools (web_search, file_search, computer, mcp, code
 *   interpreter) have no chat/Messages equivalent and are dropped from
 *   translated requests; plain `function` tools round-trip exactly.
 * - Responses `reasoning` history items have no chat channel: their
 *   summary text is replayed as an assistant message so multi-turn
 *   context survives translation.
 * - `previous_response_id` server-side state only resolves on a native
 *   Responses upstream; translated upstreams reject it as a client
 *   error (delivered as-is, no failover).
 */

import {
  anthropicToOpenAI,
  openAIChatToAnthropic,
  openAIToAnthropicBody,
  anthropicToOpenAIBody,
  openAIErrorToAnthropic,
  anthropicErrorToOpenAI,
} from "./anthropic-bridge";
import { estimateTokenCount } from "tokenx";

export interface ResponsesUsage {
  inTok: number;
  cacheTok: number;
  outTok: number;
  model: string;
  estimated: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const rid = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;

function strArgs(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/** function_call_output output (string | content parts) -> plain string. */
function callOutputToString(output: unknown): string {
  if (typeof output === "string") return output;
  return asArr(output)
    .map((p) => {
      const r = asRecord(p);
      if ((r.type === "input_text" || r.type === "output_text") && typeof r.text === "string") return r.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** reasoning item summary parts -> plain string. */
function reasoningSummary(item: Record<string, unknown>): string {
  return asArr(item.summary)
    .map((p) => {
      const r = asRecord(p);
      return typeof r.text === "string" ? r.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

// ===== requests: responses -> chat-completions =====

/**
 * Convert an OpenAI Responses request to a chat-completions request.
 * `model` is already the per-attempt upstream model id.
 */
export function responsesToChat(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    stream: body.stream === true,
  };
  const messages: Record<string, unknown>[] = [];

  // System preamble: `instructions` plus every LEADING developer/system
  // input message merge into ONE system message — strict backends
  // (Synthetic, Gemini) reject a second system block ("system message
  // must be at the beginning").
  const sysParts: string[] = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions) {
    sysParts.push(instructions);
  } else if (Array.isArray(instructions)) {
    const text = (instructions as unknown[]).filter((x): x is string => typeof x === "string").join("\n");
    if (text) sysParts.push(text);
  }
  const inputItems = typeof body.input === "string" ? [] : asArr(body.input);
  let leadEnd = 0;
  const leadTexts: string[] = [];
  for (const raw of inputItems) {
    const item = asRecord(raw);
    if (item.type !== "message" || (item.role !== "developer" && item.role !== "system")) break;
    const texts: string[] = [];
    let hasMedia = false;
    for (const p of asArr(item.content)) {
      const part = asRecord(p);
      if (
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string"
      ) {
        texts.push(part.text);
      } else {
        hasMedia = true;
      }
    }
    if (hasMedia) break;
    if (texts.length) leadTexts.push(texts.join("\n"));
    leadEnd++;
  }
  sysParts.push(...leadTexts);
  if (sysParts.length) messages.push({ role: "system", content: sysParts.join("\n\n") });

  // Assistant tool calls accumulate until a function_call_output (or the
  // input end) forces a flush — Responses nests calls/outputs as sibling
  // items while chat wants assistant(tool_calls) + tool messages.
  let pendingCalls: Record<string, unknown>[] = [];
  const flushCalls = () => {
    if (pendingCalls.length) {
      messages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };

  const pushMessageItem = (item: Record<string, unknown>) => {
    const role = item.role;
    const target = role === "assistant" ? "assistant" : role === "developer" || role === "system" ? "system" : "user";
    const parts: Record<string, unknown>[] = [];
    let text = "";
    for (const p of asArr(item.content)) {
      const part = asRecord(p);
      if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        text += (text ? "\n" : "") + part.text;
      } else if (part.type === "input_image") {
        const url =
          typeof part.image_url === "string"
            ? part.image_url
            : typeof part.file_id === "string"
              ? part.file_id
              : null;
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
      // input_file (PDFs) has no chat-completions equivalent — dropped.
    }
    flushCalls();
    if (parts.length === 0) {
      messages.push({ role: target, content: text });
    } else {
      const content: Record<string, unknown>[] = [];
      if (text) content.push({ type: "text", text });
      content.push(...parts);
      messages.push({ role: target, content });
    }
  };

  const input = body.input;
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
  } else {
    for (const raw of asArr(input).slice(leadEnd)) {
      const item = asRecord(raw);
      if (item.type === "message") {
        pushMessageItem(item);
      } else if (item.type === "function_call") {
        pendingCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : (typeof item.id === "string" ? item.id : rid("call")),
          type: "function",
          function: {
            name: typeof item.name === "string" ? item.name : "",
            arguments: strArgs(item.arguments),
          },
        });
      } else if (item.type === "function_call_output") {
        flushCalls();
        messages.push({
          role: "tool",
          tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
          content: callOutputToString(item.output),
        });
      } else if (item.type === "reasoning") {
        const summary = reasoningSummary(item);
        if (summary) {
          flushCalls();
          messages.push({ role: "assistant", content: summary });
        }
      }
      // item_reference and hosted-tool items have no chat channel — dropped.
    }
  }
  flushCalls();
  out.messages = messages;

  const tools: Record<string, unknown>[] = [];
  for (const raw of asArr(body.tools)) {
    const t = asRecord(raw);
    if (t.type !== "function" || typeof t.name !== "string") continue;
    const fn: Record<string, unknown> = {
      name: t.name,
      parameters: t.parameters ?? {},
    };
    if (typeof t.description === "string") fn.description = t.description;
    if (t.strict === true) fn.strict = true;
    tools.push({ type: "function", function: fn });
  }
  if (tools.length) {
    out.tools = tools;
    const choice = body.tool_choice;
    if (choice === "none" || choice === "required" || choice === "auto") {
      out.tool_choice = choice;
    } else {
      const c = asRecord(choice);
      if (c.type === "function" && typeof c.name === "string") {
        out.tool_choice = { type: "function", function: { name: c.name } };
      } else if (c.type === "allowed_tools") {
        out.tool_choice = c.mode === "required" ? "required" : "auto";
      } else out.tool_choice = "auto";
    }
    if (body.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }

  const reasoning = asRecord(body.reasoning);
  if (typeof reasoning.effort === "string" && reasoning.effort) {
    out.reasoning_effort = reasoning.effort;
  }
  if (typeof body.max_output_tokens === "number") out.max_completion_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  // NOTE: `store` is deliberately NOT forwarded — strict chat backends
  // reject the unknown field, and server-side history is a Responses
  // concept with no chat equivalent.
  const textFmt = asRecord(asRecord(body.text).format);
  if (textFmt.type === "json_object") {
    out.response_format = { type: "json_object" };
  } else if (textFmt.type === "json_schema") {
    out.response_format = {
      type: "json_schema",
      json_schema: {
        name: typeof textFmt.name === "string" && textFmt.name ? textFmt.name : "response",
        schema: asRecord(textFmt.schema),
      },
    };
  }
  if (out.stream === true) out.stream_options = { include_usage: true };
  return out;
}

// ===== requests: chat-completions -> responses =====

/**
 * Convert a chat-completions request to a Responses request. `model` is
 * already the per-attempt upstream model id.
 */
export function chatToResponsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: body.model,
    stream: body.stream === true,
  };
  const input: Record<string, unknown>[] = [];
  const instructions: string[] = [];

  let pendingCalls: Record<string, unknown>[] = [];
  const flushCalls = () => {
    if (pendingCalls.length) {
      input.push(...pendingCalls);
      pendingCalls = [];
    }
  };

  for (const raw of asArr(body.messages)) {
    const m = asRecord(raw);
    const role = m.role === "assistant" ? "assistant" : m.role === "system" || m.role === "developer" ? "system" : "user";
    if (m.role === "tool") {
      flushCalls();
      input.push({
        type: "function_call_output",
        call_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "",
        output: typeof m.content === "string" ? m.content : strArgs(m.content),
      });
      continue;
    }
    const partType = role === "assistant" ? "output_text" : "input_text";
    const content: Record<string, unknown>[] = [];
    const pushText = (t: string) => {
      if (t) content.push({ type: partType, text: t });
    };
    if (typeof m.content === "string") {
      if (role === "system") instructions.push(m.content);
      else pushText(m.content);
    } else {
      for (const p of asArr(m.content)) {
        const part = asRecord(p);
        if (part.type === "text" && typeof part.text === "string") {
          if (role === "system") instructions.push(part.text);
          else pushText(part.text);
        } else if (part.type === "image_url") {
          const url = asRecord(part.image_url).url;
          if (typeof url === "string" && url) content.push({ type: "input_image", image_url: url });
        }
      }
    }
    if (role === "assistant") {
      const rr = asRecord(m.responses_reasoning) || asRecord(asRecord(m.extra_content).responses_reasoning);
      if (rr && (typeof rr.id === "string" || typeof rr.encrypted_content === "string")) {
        const id = typeof rr.id === "string" && rr.id ? rr.id : rid("rs");
        const rItem: Record<string, unknown> = {
          type: "reasoning",
          id,
          summary: [],
        };
        if (typeof rr.encrypted_content === "string" && rr.encrypted_content) {
          rItem.encrypted_content = rr.encrypted_content;
        }
        input.push(rItem);
      }
    }
    // Assistant text precedes its function calls (Responses items are
    // ordered: message, then the calls it made).
    if (content.length) input.push({ type: "message", role, content });
    else if (role === "system" && m.content == null) {
      /* system role carried instructions only */
    }
    if (role === "assistant") {
      for (const tc of asArr(m.tool_calls)) {
        const r = asRecord(tc);
        const fn = asRecord(r.function);
        // `id` is response-scoped: strict Responses upstreams (OpenAI)
        // require the `fc_` prefix. `call_id` is conversation-scoped and
        // keeps the client id so function_call_output linkage still matches.
        const cid = typeof r.id === "string" && r.id ? r.id : rid("call");
        pendingCalls.push({
          type: "function_call",
          id: cid.startsWith("fc_") ? cid : rid("fc"),
          call_id: cid,
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : strArgs(fn.arguments),
          status: "completed",
        });
      }
      flushCalls();
    }
  }
  flushCalls();

  if (instructions.length) out.instructions = instructions.join("\n");
  out.input = input;

  const tools: Record<string, unknown>[] = [];
  for (const raw of asArr(body.tools)) {
    const t = asRecord(raw);
    const fn = asRecord(t.function);
    if (t.type !== "function" || typeof fn.name !== "string") continue;
    const def: Record<string, unknown> = { type: "function", name: fn.name, parameters: fn.parameters ?? {} };
    if (typeof fn.description === "string") def.description = fn.description;
    if (fn.strict === true) def.strict = true;
    tools.push(def);
  }
  if (tools.length) {
    out.tools = tools;
    const choice = body.tool_choice;
    if (choice === "auto" || choice === "required" || choice === "none") {
      out.tool_choice = choice;
    } else {
      const fn = asRecord(asRecord(choice).function);
      out.tool_choice =
        asRecord(choice).type === "function" && typeof fn.name === "string"
          ? { type: "function", name: fn.name }
          : "auto";
    }
    if (body.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }

  if (typeof body.reasoning_effort === "string" && body.reasoning_effort) {
    out.reasoning = { effort: body.reasoning_effort };
  }
  const maxOut =
    typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : undefined;
  if (maxOut !== undefined) out.max_output_tokens = maxOut;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.store === false) out.store = false;
  const fmt = asRecord(body.response_format);
  if (fmt.type === "json_object") {
    out.text = { format: { type: "json_object" } };
  } else if (fmt.type === "json_schema") {
    const schema = asRecord(fmt.json_schema);
    out.text = {
      format: {
        type: "json_schema",
        name: typeof schema.name === "string" && schema.name ? schema.name : "response",
        schema: schema.schema ?? {},
      },
    };
  }
  return out;
}

/** Responses -> Anthropic messages request (through the chat shape). */
export async function responsesToAnthropic(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return openAIChatToAnthropic(responsesToChat(body));
}

/** Anthropic messages request -> Responses request (through the chat shape). */
export function anthropicToResponsesRequest(body: Record<string, unknown>): Record<string, unknown> {
  return chatToResponsesRequest(anthropicToOpenAI(body));
}

// ===== buffered responses: upstream -> client =====

/** Responses `usage` -> gateway token buckets (reasoning stays in output). */
export function responsesUsageSplit(usage: unknown): { inTok: number; cacheTok: number; outTok: number } {
  const u = asRecord(usage);
  const input = Number(u.input_tokens ?? 0) || 0;
  const cached = Number(asRecord(u.input_tokens_details).cached_tokens ?? 0) || 0;
  return {
    inTok: Math.max(0, input - cached),
    cacheTok: Math.max(0, cached),
    outTok: Number(u.output_tokens ?? 0) || 0,
  };
}

/** Usage of a buffered Responses body (native or translated-to). */
export function parseResponsesJson(bodyText: string): ResponsesUsage {
  try {
    const j = asRecord(JSON.parse(bodyText));
    const u = responsesUsageSplit(j.usage);
    return {
      ...u,
      model: typeof j.model === "string" ? j.model : "",
      estimated: asRecord(j.usage).input_tokens === undefined,
    };
  } catch {
    return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: true };
  }
}

function responsesStatus(finish: unknown, hasCalls: boolean): { status: string; incomplete: Record<string, unknown> | null } {
  if (hasCalls) return { status: "completed", incomplete: null };
  if (finish === "length") return { status: "incomplete", incomplete: { reason: "max_output_tokens" } };
  if (finish === "content_filter") return { status: "incomplete", incomplete: { reason: "content_filter" } };
  return { status: "completed", incomplete: null };
}

/**
 * Convert a buffered chat-completions response to a Responses response.
 * `fallbackModel` is the public model id the client asked for.
 */
export function chatToResponsesBody(chatText: string, fallbackModel: string): string {
  let j: Record<string, unknown>;
  try {
    j = asRecord(JSON.parse(chatText));
  } catch {
    j = {};
  }
  const choices = asArr(j.choices);
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const model = typeof j.model === "string" && j.model ? j.model : fallbackModel;
  const output: Record<string, unknown>[] = [];

  let reasoningText = "";
  for (const key of ["reasoning", "reasoning_content"]) {
    if (typeof message[key] === "string" && message[key]) {
      reasoningText = message[key] as string;
      break;
    }
  }
  if (!reasoningText) {
    for (const raw of asArr(message.reasoning_details)) {
      const text = asRecord(raw).text;
      if (typeof text === "string") reasoningText += text;
    }
  }
  const rr = asRecord(asRecord(message.extra_content).responses_reasoning);
  if (rr && (rr.id || rr.encrypted_content)) {
    output.push({
      type: "reasoning",
      id: typeof rr.id === "string" && rr.id ? rr.id : rid("rs"),
      summary: reasoningText ? [{ type: "summary_text", text: reasoningText }] : [],
      ...(typeof rr.encrypted_content === "string" ? { encrypted_content: rr.encrypted_content } : {}),
      status: "completed",
    });
  } else if (reasoningText) {
    output.push({
      type: "reasoning",
      id: rid("rs"),
      summary: [{ type: "summary_text", text: reasoningText }],
      status: "completed",
    });
  }

  const toolCalls = asArr(message.tool_calls);
  const hasCalls = toolCalls.length > 0;
  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    output.push({
      type: "message",
      id: rid("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const tc of toolCalls) {
    const r = asRecord(tc);
    const fn = asRecord(r.function);
    const id = typeof r.id === "string" && r.id ? r.id : rid("fc");
    output.push({
      type: "function_call",
      id,
      call_id: id,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: typeof fn.arguments === "string" ? fn.arguments : strArgs(fn.arguments),
      status: "completed",
    });
  }

  const { status, incomplete } = responsesStatus(first.finish_reason, hasCalls);
  const prompt = Number(asRecord(j.usage).prompt_tokens ?? 0) || 0;
  const cached = Number(asRecord(asRecord(j.usage).prompt_tokens_details).cached_tokens ?? 0) || 0;
  const outTok = Number(asRecord(j.usage).completion_tokens ?? 0) || 0;
  return JSON.stringify({
    id: typeof j.id === "string" && j.id ? j.id : rid("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    ...(incomplete ? { incomplete_details: incomplete } : {}),
    error: null,
    output,
    usage: {
      input_tokens: prompt,
      input_tokens_details: { cached_tokens: Math.max(0, cached) },
      output_tokens: outTok,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: prompt + outTok,
    },
  });
}

/** Anthropic messages response -> Responses response (through chat). */
export function anthropicToResponsesBody(anthropicText: string, fallbackModel: string): string {
  return chatToResponsesBody(anthropicToOpenAIBody(anthropicText, fallbackModel), fallbackModel);
}

/**
 * Convert a buffered Responses response to a chat-completions response.
 * `fallbackModel` is the public model id the client asked for.
 */
export function responsesToChatBody(responsesText: string, fallbackModel: string): string {
  let j: Record<string, unknown>;
  try {
    j = asRecord(JSON.parse(responsesText));
  } catch {
    j = {};
  }
  const model = typeof j.model === "string" && j.model ? j.model : fallbackModel;
  let text = "";
  let reasoningText = "";
  let responsesReasoning: Record<string, unknown> | null = null;
  const toolCalls: Record<string, unknown>[] = [];
  for (const raw of asArr(j.output)) {
    const item = asRecord(raw);
    if (item.type === "message") {
      for (const c of asArr(item.content)) {
        const part = asRecord(c);
        if (part.type === "output_text" && typeof part.text === "string") {
          text += (text ? "\n" : "") + part.text;
        }
      }
    } else if (item.type === "function_call") {
      const id =
        typeof item.call_id === "string" && item.call_id
          ? item.call_id
          : typeof item.id === "string" && item.id
            ? item.id
            : rid("call");
      toolCalls.push({
        id,
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : strArgs(item.arguments),
        },
      });
    } else if (item.type === "reasoning") {
      const s = reasoningSummary(item);
      if (s) reasoningText += (reasoningText ? "\n" : "") + s;
      const id = typeof item.id === "string" ? item.id : "";
      const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
      if (id || enc) {
        responsesReasoning = { id, ...(enc ? { encrypted_content: enc } : {}) };
      }
    }
  }
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (responsesReasoning) {
    message.extra_content = {
      ...asRecord(message.extra_content),
      responses_reasoning: responsesReasoning,
    };
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoningText) message.reasoning_content = reasoningText;
  const incomplete = asRecord(j.incomplete_details).reason;
  const finish =
    toolCalls.length > 0
      ? "tool_calls"
      : incomplete === "max_output_tokens"
        ? "length"
        : incomplete === "content_filter"
          ? "content_filter"
          : "stop";
  const u = responsesUsageSplit(j.usage);
  return JSON.stringify({
    id: typeof j.id === "string" && j.id ? j.id : rid("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: {
      prompt_tokens: u.inTok + u.cacheTok,
      completion_tokens: u.outTok,
      total_tokens: u.inTok + u.cacheTok + u.outTok,
    },
  });
}

/** Responses response -> Anthropic messages response (through chat). */
export function responsesToAnthropicBody(responsesText: string, fallbackModel: string): string {
  return openAIToAnthropicBody(responsesToChatBody(responsesText, fallbackModel), fallbackModel);
}

/** Usage of a buffered translated response, parsed from the Responses body. */
export function translatedUsageFromResponses(responsesText: string): ResponsesUsage {
  return parseResponsesJson(responsesText);
}

/**
 * Re-envelope an Anthropic error body as a Responses (OpenAI-envelope)
 * error body. Chat/Responses errors share the envelope: the other
 * directions pass the upstream body through untouched.
 */
export function anthropicErrorToResponses(status: number, bodyText: string): string {
  return anthropicErrorToOpenAI(status, bodyText);
}

/** Re-envelope an OpenAI-envelope (chat or Responses) error as Anthropic. */
export function responsesErrorToAnthropic(status: number, bodyText: string): string {
  return openAIErrorToAnthropic(status, bodyText);
}

// ===== streaming translators =====

const sseEnc = new TextEncoder();

function rEvent(event: string, data: unknown): Uint8Array {
  return sseEnc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseDataLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * Incremental chat-completions-SSE -> Responses-SSE translator.
 * The stream always terminates with `response.completed` (or
 * `response.incomplete` when the upstream ends mid-turn — never a
 * silent stop), because Responses clients treat a bare connection
 * close as a stall, not an ending.
 */
export class ChatToResponsesStream {
  private pending = "";
  private decoder = new TextDecoder();
  private respId = "";
  private model = "";
  private seq = 0;
  private created = false;
  private msgId = "";
  private msgAdded = false;
  private textBuf = "";
  private rsAdded = false;
  private rsId = "";
  private rsBuf = "";
  private tools = new Map<number, { index: number; callId: string; name: string; added: boolean; args: string }>();
  private nextToolSlot = 0;
  private finishReason: unknown = null;
  private promptTokens = 0;
  private cachedTokens = 0;
  private completionTokens = 0;
  private usageSeen = false;
  private done = false;
  private outChars = 0;
  private outSample = "";
  private sawOutput = false;

  constructor(private fallbackModel: string) {}

  get isDone(): boolean {
    return this.done;
  }

  private addOutText(t: string): void {
    this.outChars += t.length;
    if (this.outSample.length < 2048) {
      this.outSample += t.slice(0, 2048 - this.outSample.length);
    }
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

  flush(): Uint8Array[] {
    if (this.done) return [];
    return this.finish();
  }

  private skeleton(status: string): Record<string, unknown> {
    return {
      id: this.respId || rid("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.model || this.fallbackModel,
      status,
      error: null,
      output: [],
    };
  }

  private ensureCreated(out: Uint8Array[]): void {
    if (this.created) return;
    this.created = true;
    const response = this.skeleton("in_progress");
    out.push(rEvent("response.created", { type: "response.created", sequence_number: this.seq++, response }));
    out.push(rEvent("response.in_progress", { type: "response.in_progress", sequence_number: this.seq++, response }));
  }

  private ensureMessage(out: Uint8Array[]): void {
    this.ensureCreated(out);
    if (this.msgAdded) return;
    this.msgAdded = true;
    this.msgId = rid("msg");
    out.push(
      rEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: this.seq++,
        output_index: 0,
        item: { id: this.msgId, type: "message", role: "assistant", status: "in_progress", content: [] },
      }),
      rEvent("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: this.seq++,
        item_id: this.msgId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
  }

  private ensureReasoning(out: Uint8Array[]): void {
    this.ensureCreated(out);
    if (this.rsAdded) return;
    this.rsAdded = true;
    this.rsId = rid("rs");
    out.push(
      rEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: this.seq++,
        output_index: 1,
        item: { id: this.rsId, type: "reasoning", status: "in_progress", summary: [] },
      }),
    );
  }

  /** Full output items for the terminal snapshot: some clients (codex)
   *  rebuild function calls from `response.completed`, not from deltas. */
  private outputSnapshot(status: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    if (this.rsAdded) {
      out.push({
        type: "reasoning",
        id: this.rsId,
        summary: this.rsBuf ? [{ type: "summary_text", text: this.rsBuf }] : [],
        status,
      });
    }
    if (this.msgAdded) {
      out.push({
        type: "message",
        id: this.msgId,
        role: "assistant",
        status,
        content: this.textBuf ? [{ type: "output_text", text: this.textBuf, annotations: [] }] : [],
      });
    }
    for (const slot of this.tools.values()) {
      if (!slot.added) continue;
      out.push({
        type: "function_call",
        id: slot.callId,
        call_id: slot.callId,
        name: slot.name,
        arguments: slot.args,
        status,
      });
    }
    return out;
  }

  private toolSlot(index: number): { index: number; callId: string; name: string; added: boolean; args: string } {
    let t = this.tools.get(index);
    if (!t) {
      t = { index: this.nextToolSlot++, callId: "", name: "", added: false, args: "" };
      this.tools.set(index, t);
    }
    return t;
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    const j = parseDataLine(data);
    if (!j) return [];
    if (typeof j.id === "string" && j.id && !this.respId) this.respId = j.id;
    if (typeof j.model === "string" && j.model && !this.model) this.model = j.model;
    const u = asRecord(j.usage);
    if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
      this.promptTokens = Number(u.prompt_tokens ?? 0) || 0;
      this.cachedTokens = Number(asRecord(u.prompt_tokens_details).cached_tokens ?? 0) || 0;
      this.completionTokens = Number(u.completion_tokens ?? 0) || 0;
      this.usageSeen = true;
    }
    for (const c of asArr(j.choices)) {
      const choice = asRecord(c);
      if (choice.finish_reason != null) this.finishReason = choice.finish_reason;
      const delta = asRecord(choice.delta);
      if (typeof delta.content === "string" && delta.content) {
        this.ensureMessage(out);
        this.sawOutput = true;
        this.textBuf += delta.content;
        this.addOutText(delta.content);
        out.push(
          rEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: this.seq++,
            item_id: this.msgId,
            output_index: 0,
            content_index: 0,
            delta: delta.content,
          }),
        );
      }
      const reasoning = delta.reasoning ?? delta.reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        this.ensureReasoning(out);
        this.sawOutput = true;
        this.rsBuf += reasoning;
        this.addOutText(reasoning);
        out.push(
          rEvent("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            sequence_number: this.seq++,
            item_id: this.msgId,
            output_index: 1,
            summary_index: 0,
            delta: reasoning,
          }),
        );
      } else {
        let details = "";
        for (const raw of asArr(delta.reasoning_details)) {
          const text = asRecord(raw).text;
          if (typeof text === "string") details += text;
        }
        if (details) {
          this.ensureReasoning(out);
          this.sawOutput = true;
          this.rsBuf += details;
          this.addOutText(details);
          out.push(
            rEvent("response.reasoning_summary_text.delta", {
              type: "response.reasoning_summary_text.delta",
              sequence_number: this.seq++,
              item_id: this.msgId,
              output_index: 1,
              summary_index: 0,
              delta: details,
            }),
          );
        }
      }
      asArr(delta.tool_calls).forEach((rawTc, pos) => {
        const tc = asRecord(rawTc);
        const idx = typeof tc.index === "number" ? tc.index : pos;
        const slot = this.toolSlot(idx);
        const fn = asRecord(tc.function);
        if (typeof tc.id === "string" && tc.id) slot.callId = tc.id;
        if (typeof fn.name === "string" && fn.name) slot.name = fn.name;
        if (!slot.added && (slot.callId || slot.name)) {
          slot.added = true;
          this.ensureCreated(out);
          this.sawOutput = true;
          const id = slot.callId || rid("fc");
          slot.callId = id;
          out.push(
            rEvent("response.output_item.added", {
              type: "response.output_item.added",
              sequence_number: this.seq++,
              output_index: 2 + slot.index,
              item: {
                id,
                type: "function_call",
                status: "in_progress",
                call_id: id,
                name: slot.name,
                arguments: "",
              },
            }),
          );
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          this.sawOutput = true;
          slot.args += fn.arguments;
          out.push(
            rEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              sequence_number: this.seq++,
              item_id: slot.callId,
              output_index: 2 + slot.index,
              delta: fn.arguments,
            }),
          );
        }
      });
    }
    // A usage chunk ends the turn ONLY when a finish reason was already
    // seen: some vendors (Google) repeat usage on every chunk, and
    // finishing on the first one would truncate the stream after one
    // token (same guard as OpenAIToAnthropicStream).
    if (this.usageSeen && this.finishReason != null && !this.done) {
      out.push(...this.finish());
    }
    return out;
  }

  private finish(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    this.ensureCreated(out);
    const complete = this.usageSeen || this.finishReason != null || this.sawOutput;
    const finalStatus = complete ? "completed" : "incomplete";
    if (this.msgAdded) {
      out.push(
        rEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: this.seq++,
          output_index: 0,
          item: {
            id: this.msgId,
            type: "message",
            role: "assistant",
            status: finalStatus,
            content: this.textBuf ? [{ type: "output_text", text: this.textBuf, annotations: [] }] : [],
          },
        }),
      );
    }
    for (const slot of this.tools.values()) {
      if (!slot.added) continue;
      out.push(
        rEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: this.seq++,
          output_index: 2 + slot.index,
          item: {
            id: slot.callId,
            type: "function_call",
            status: finalStatus,
            call_id: slot.callId,
            name: slot.name,
            arguments: slot.args,
          },
        }),
      );
    }
    const response = this.skeleton(complete ? (this.finishReason === "length" ? "incomplete" : "completed") : "incomplete");
    response.output = this.outputSnapshot(finalStatus);
    if (response.status === "incomplete") {
      response.incomplete_details = {
        reason: this.finishReason === "content_filter" ? "content_filter" : "max_output_tokens",
      };
    }
    response.usage = {
      input_tokens: this.promptTokens,
      input_tokens_details: { cached_tokens: this.cachedTokens },
      output_tokens: this.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: this.promptTokens + this.completionTokens,
    };
    out.push(
      rEvent(complete ? "response.completed" : "response.incomplete", {
        type: complete ? "response.completed" : "response.incomplete",
        sequence_number: this.seq++,
        response,
      }),
    );
    return out;
  }

  result(): ResponsesUsage {
    if (this.usageSeen) {
      return {
        inTok: Math.max(0, this.promptTokens - this.cachedTokens),
        cacheTok: Math.max(0, this.cachedTokens),
        outTok: this.completionTokens,
        model: this.model,
        estimated: false,
      };
    }
    if (this.outChars === 0 || !this.outSample) {
      return { inTok: 0, cacheTok: 0, outTok: 0, model: this.model, estimated: true };
    }
    const scaled = Math.round((estimateTokenCount(this.outSample) * this.outChars) / this.outSample.length);
    return { inTok: 0, cacheTok: 0, outTok: Math.max(1, scaled), model: this.model, estimated: true };
  }
}

/**
 * Incremental Anthropic-SSE -> Responses-SSE translator.
 * Terminates with `response.completed` (or `response.incomplete` when
 * the upstream ends mid-turn — never a silent stop).
 */
export class AnthropicToResponsesStream {
  private pending = "";
  private decoder = new TextDecoder();
  private respId = "";
  private model = "";
  private seq = 0;
  private created = false;
  private msgId = "";
  private msgAdded = false;
  private textBuf = "";
  private rsId = "";
  private rsAdded = false;
  private rsBuf = "";
  private blocks = new Map<number, { kind: string; id: string; name: string; done: boolean; args: string }>();
  private inTok = 0;
  private cacheTok = 0;
  private outTok = 0;
  private stopReason: unknown = null;
  private done = false;
  private outChars = 0;
  private outSample = "";
  private sawOutput = false;

  constructor(private fallbackModel: string) {}

  get isDone(): boolean {
    return this.done;
  }

  private addOutText(t: string): void {
    this.outChars += t.length;
    if (this.outSample.length < 2048) {
      this.outSample += t.slice(0, 2048 - this.outSample.length);
    }
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

  flush(): Uint8Array[] {
    if (this.done) return [];
    return this.finish(false);
  }

  private skeleton(status: string): Record<string, unknown> {
    return {
      id: this.respId || rid("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.model || this.fallbackModel,
      status,
      error: null,
      output: [],
    };
  }

  private ensureCreated(out: Uint8Array[]): void {
    if (this.created) return;
    this.created = true;
    const response = this.skeleton("in_progress");
    out.push(rEvent("response.created", { type: "response.created", sequence_number: this.seq++, response }));
    out.push(rEvent("response.in_progress", { type: "response.in_progress", sequence_number: this.seq++, response }));
  }

  private ensureMessage(out: Uint8Array[]): void {
    this.ensureCreated(out);
    if (this.msgAdded) return;
    this.msgAdded = true;
    this.msgId = rid("msg");
    out.push(
      rEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: this.seq++,
        output_index: 0,
        item: { id: this.msgId, type: "message", role: "assistant", status: "in_progress", content: [] },
      }),
      rEvent("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: this.seq++,
        item_id: this.msgId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
  }

  private ensureReasoning(out: Uint8Array[]): void {
    this.ensureCreated(out);
    if (this.rsAdded) return;
    this.rsAdded = true;
    this.rsId = rid("rs");
    out.push(
      rEvent("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: this.seq++,
        output_index: 1,
        item: { id: this.rsId, type: "reasoning", status: "in_progress", summary: [] },
      }),
    );
  }

  /** Full output items for the terminal snapshot: some clients (codex)
   *  rebuild function calls from `response.completed`, not from deltas. */
  private outputSnapshot(status: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    if (this.rsAdded) {
      out.push({
        type: "reasoning",
        id: this.rsId,
        summary: this.rsBuf ? [{ type: "summary_text", text: this.rsBuf }] : [],
        status,
      });
    }
    if (this.msgAdded) {
      out.push({
        type: "message",
        id: this.msgId,
        role: "assistant",
        status,
        content: this.textBuf ? [{ type: "output_text", text: this.textBuf, annotations: [] }] : [],
      });
    }
    for (const [index, block] of this.blocks) {
      if (block.kind !== "tool") continue;
      out.push({
        type: "function_call",
        id: block.id,
        call_id: block.id,
        name: block.name,
        arguments: block.args,
        status,
      });
      void index;
    }
    return out;
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    const j = parseDataLine(data);
    if (!j) return [];
    const type = j.type;
    if (type === "message_start") {
      const msg = asRecord(j.message);
      if (typeof msg.id === "string" && msg.id) this.respId = msg.id;
      if (typeof msg.model === "string" && msg.model) this.model = msg.model;
      const u = asRecord(msg.usage);
      if (u.input_tokens !== undefined) {
        this.inTok = Number(u.input_tokens ?? 0) || 0;
        this.cacheTok =
          (Number(u.cache_read_input_tokens ?? 0) || 0) + (Number(u.cache_creation_input_tokens ?? 0) || 0);
      }
      return out;
    }
    if (type === "content_block_start") {
      const block = asRecord(j.content_block);
      const index = typeof j.index === "number" ? j.index : this.blocks.size;
      if (block.type === "text") {
        this.ensureMessage(out);
        this.blocks.set(index, { kind: "text", id: this.msgId, name: "", done: false, args: "" });
      } else if (block.type === "thinking") {
        this.ensureReasoning(out);
        this.blocks.set(index, { kind: "thinking", id: "", name: "", done: false, args: "" });
      } else if (block.type === "redacted_thinking") {
        const data = typeof block.data === "string" ? block.data : "";
        let rsId = rid("rs");
        let enc = data;
        try {
          if (data.startsWith("{")) {
            const p = JSON.parse(data);
            if (typeof p.id === "string" && p.id) rsId = p.id;
            if (typeof p.encrypted_content === "string") enc = p.encrypted_content;
          }
        } catch {}
        this.ensureCreated(out);
        this.sawOutput = true;
        out.push(
          rEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: this.seq++,
            output_index: 0,
            item: { id: rsId, type: "reasoning", status: "completed", encrypted_content: enc, summary: [] },
          }),
          rEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: this.seq++,
            output_index: 0,
            item: { id: rsId, type: "reasoning", status: "completed", encrypted_content: enc, summary: [] },
          }),
        );
      } else if (block.type === "tool_use") {
        this.ensureCreated(out);
        const id = typeof block.id === "string" && block.id ? block.id : rid("fc");
        const name = typeof block.name === "string" ? block.name : "";
        this.blocks.set(index, { kind: "tool", id, name, done: false, args: "" });
        this.sawOutput = true;
        out.push(
          rEvent("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: this.seq++,
            output_index: 2 + index,
            item: { id, type: "function_call", status: "in_progress", call_id: id, name, arguments: "" },
          }),
        );
      }
      return out;
    }
    if (type === "content_block_delta") {
      const index = typeof j.index === "number" ? j.index : -1;
      const block = this.blocks.get(index);
      const delta = asRecord(j.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        this.ensureMessage(out);
        this.sawOutput = true;
        this.textBuf += delta.text;
        this.addOutText(delta.text);
        out.push(
          rEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: this.seq++,
            item_id: this.msgId,
            output_index: 0,
            content_index: 0,
            delta: delta.text,
          }),
        );
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        this.ensureReasoning(out);
        this.sawOutput = true;
        this.rsBuf += delta.thinking;
        this.addOutText(delta.thinking);
        out.push(
          rEvent("response.reasoning_summary_text.delta", {
            type: "response.reasoning_summary_text.delta",
            sequence_number: this.seq++,
            item_id: this.msgId,
            output_index: 1,
            summary_index: 0,
            delta: delta.thinking,
          }),
        );
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json) {
        if (block?.kind === "tool") {
          this.sawOutput = true;
          block.args += delta.partial_json;
          out.push(
            rEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              sequence_number: this.seq++,
              item_id: block.id,
              output_index: 2 + index,
              delta: delta.partial_json,
            }),
          );
        }
      }
      return out;
    }
    if (type === "content_block_stop") {
      const index = typeof j.index === "number" ? j.index : -1;
      const block = this.blocks.get(index);
      if (block && !block.done && block.kind !== "text") {
        block.done = true;
        out.push(
          rEvent("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: this.seq++,
            output_index: block.kind === "thinking" ? 1 : 2 + index,
            item:
              block.kind === "thinking"
                ? {
                    id: this.rsId,
                    type: "reasoning",
                    status: "completed",
                    summary: this.rsBuf ? [{ type: "summary_text", text: this.rsBuf }] : [],
                  }
                : {
                    id: block.id,
                    type: "function_call",
                    status: "completed",
                    call_id: block.id,
                    name: block.name,
                    arguments: block.args,
                  },
          }),
        );
      }
      return out;
    }
    if (type === "message_delta") {
      const delta = asRecord(j.delta);
      if (delta.stop_reason !== undefined) this.stopReason = delta.stop_reason;
      const u = asRecord(j.usage);
      if (u.output_tokens !== undefined) this.outTok = Number(u.output_tokens) || 0;
      const ct =
        (Number(u.cache_read_input_tokens ?? 0) || 0) + (Number(u.cache_creation_input_tokens ?? 0) || 0);
      if (ct > 0) this.cacheTok = ct;
      return out;
    }
    if (type === "message_stop") {
      out.push(...this.finish(true));
      return out;
    }
    if (type === "error") {
      const err = asRecord(j.error);
      out.push(...this.fail(typeof err.message === "string" && err.message ? err.message : "upstream error"));
      return out;
    }
    return out;
  }

  private fail(message: string): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    this.ensureCreated(out);
    const response = this.skeleton("failed");
    response.error = { message };
    out.push(rEvent("response.failed", { type: "response.failed", sequence_number: this.seq++, response }));
    return out;
  }

  private finish(graceful: boolean): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    this.ensureCreated(out);
    const complete = graceful || this.stopReason != null || this.sawOutput;
    if (this.msgAdded) {
      out.push(
        rEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: this.seq++,
          output_index: 0,
          item: { id: this.msgId, type: "message", role: "assistant", status: "completed", content: [] },
        }),
      );
    }
    for (const [index, block] of this.blocks) {
      if (block.done || block.kind === "text") continue;
      block.done = true;
      out.push(
        rEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: this.seq++,
          output_index: block.kind === "thinking" ? 1 : 2 + index,
          item:
            block.kind === "thinking"
              ? { id: rid("rs"), type: "reasoning", status: "completed", summary: [] }
              : {
                  id: block.id,
                  type: "function_call",
                  status: "completed",
                  call_id: block.id,
                  name: block.name,
                  arguments: "",
                },
        }),
      );
    }
    const finalStatus = complete ? "completed" : "incomplete";
    const response = this.skeleton(finalStatus);
    response.output = this.outputSnapshot(finalStatus);
    if (this.stopReason === "max_tokens") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
    } else if (!complete) {
      response.incomplete_details = { reason: "max_output_tokens" };
    }
    response.usage = {
      input_tokens: this.inTok + this.cacheTok,
      input_tokens_details: { cached_tokens: this.cacheTok },
      output_tokens: this.outTok,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: this.inTok + this.cacheTok + this.outTok,
    };
    out.push(
      rEvent(complete && response.status === "completed" ? "response.completed" : "response.incomplete", {
        type: complete && response.status === "completed" ? "response.completed" : "response.incomplete",
        sequence_number: this.seq++,
        response,
      }),
    );
    return out;
  }

  result(): ResponsesUsage {
    const estimated = this.inTok === 0 && this.outTok === 0 && this.cacheTok === 0;
    if (!estimated) {
      return { inTok: this.inTok, cacheTok: this.cacheTok, outTok: this.outTok, model: this.model, estimated: false };
    }
    if (this.outChars === 0 || !this.outSample) {
      return { inTok: 0, cacheTok: 0, outTok: 0, model: this.model, estimated: true };
    }
    const scaled = Math.round((estimateTokenCount(this.outSample) * this.outChars) / this.outSample.length);
    return { inTok: 0, cacheTok: 0, outTok: Math.max(1, scaled), model: this.model, estimated: true };
  }
}

const chatEnc = new TextEncoder();

function chatChunk(id: string, model: string, choice: Record<string, unknown>, usage?: Record<string, unknown>): Uint8Array {
  const payload: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, ...choice }],
  };
  if (usage) payload.usage = usage;
  return chatEnc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const CHAT_DONE = chatEnc.encode("data: [DONE]\n\n");

/**
 * Incremental Responses-SSE -> chat-completions-SSE translator.
 * Always terminates with a usage chunk + `data: [DONE]` as OpenAI
 * clients require — a bare upstream close becomes an estimated
 * terminal chunk, never a silent stop.
 */
export class ResponsesToChatStream {
  private pending = "";
  private decoder = new TextDecoder();
  private upstreamId = "";
  private model = "";
  private roleSent = false;
  // Slots keyed by the response-scoped item id (`fc_…`, what
  // `function_call_arguments.delta` carries in `item_id`); the emitted
  // chat `tool_calls[].id` is the conversation-scoped `call_id`
  // (`call_…`), which is what clients echo back.
  private calls = new Map<string, { index: number; callId: string }>();
  private nextCall = 0;
  private hasCalls = false;
  private incomplete: unknown = null;
  private inTok = 0;
  private cacheTok = 0;
  private outTok = 0;
  private usageSeen = false;
  private outChars = 0;
  private outSample = "";
  private done = false;

  constructor(private fallbackModel: string) {}

  get isDone(): boolean {
    return this.done;
  }

  private addOutText(t: string): void {
    this.outChars += t.length;
    if (this.outSample.length < 2048) {
      this.outSample += t.slice(0, 2048 - this.outSample.length);
    }
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
      if (!data || data === "[DONE]") continue;
      out.push(...this.processData(data));
      if (this.done) break;
    }
    return out;
  }

  flush(): Uint8Array[] {
    if (this.done) return [];
    return this.finish();
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
    out.push(chatChunk(id, model, { delta: { role: "assistant", content: "" }, finish_reason: null }));
  }

  private callSlot(itemId: string, callId: string): { index: number; callId: string } {
    let s = this.calls.get(itemId);
    if (!s) {
      s = { index: this.nextCall++, callId: callId || itemId };
      this.calls.set(itemId, s);
    } else if (!s.callId && callId) {
      s.callId = callId;
    }
    return s;
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    const j = parseDataLine(data);
    if (!j) return [];
    const type = j.type;
    if (type === "response.created" || type === "response.in_progress" || type === "response.queued") {
      const r = asRecord(j.response);
      if (typeof r.id === "string" && r.id && !this.upstreamId) this.upstreamId = r.id;
      if (typeof r.model === "string" && r.model && !this.model) this.model = r.model;
      return out;
    }
    if (type === "response.output_text.delta") {
      const delta = j.delta;
      if (typeof delta === "string" && delta) {
        this.ensureRole(out);
        this.addOutText(delta);
        const { id, model } = this.head();
        out.push(chatChunk(id, model, { delta: { content: delta }, finish_reason: null }));
      }
      return out;
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const delta = j.delta;
      if (typeof delta === "string" && delta) {
        this.ensureRole(out);
        this.addOutText(delta);
        const { id, model } = this.head();
        out.push(chatChunk(id, model, { delta: { reasoning_content: delta }, finish_reason: null }));
      }
      return out;
    }
    if (type === "response.output_item.added") {
      const item = asRecord(j.item);
      if (item.type === "function_call") {
        this.ensureRole(out);
        this.hasCalls = true;
        const itemId = typeof item.id === "string" && item.id ? item.id : rid("fc");
        const callId =
          typeof item.call_id === "string" && item.call_id ? item.call_id : itemId;
        const slot = this.callSlot(itemId, callId);
        const { id, model } = this.head();
        out.push(
          chatChunk(id, model, {
            delta: {
              tool_calls: [
                {
                  index: slot.index,
                  id: slot.callId,
                  type: "function",
                  function: { name: typeof item.name === "string" ? item.name : "", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          }),
        );
      }
      return out;
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = j.delta;
      const itemId = typeof j.item_id === "string" ? j.item_id : "";
      if (typeof delta === "string" && delta && itemId) {
        this.ensureRole(out);
        const { id, model } = this.head();
        out.push(
          chatChunk(id, model, {
            delta: { tool_calls: [{ index: this.callSlot(itemId, "").index, function: { arguments: delta } }] },
            finish_reason: null,
          }),
        );
      }
      return out;
    }
    if (type === "response.output_item.done") {
      const item = asRecord(j.item);
      if (item.type === "reasoning") {
        const id = typeof item.id === "string" ? item.id : "";
        const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
        if (id || enc) {
          this.ensureRole(out);
          const { id: mid, model } = this.head();
          out.push(
            chatChunk(mid, model, {
              delta: {
                extra_content: {
                  responses_reasoning: { id, ...(enc ? { encrypted_content: enc } : {}) },
                },
              },
              finish_reason: null,
            }),
          );
        }
      }
      return out;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const r = asRecord(j.response);
      const u = responsesUsageSplit(r.usage);
      this.inTok = u.inTok;
      this.cacheTok = u.cacheTok;
      this.outTok = u.outTok;
      this.usageSeen = true;
      if (type !== "response.completed") {
        this.incomplete = asRecord(r.incomplete_details).reason ?? asRecord(r.error).message ?? true;
      }
      out.push(...this.finish());
      return out;
    }
    return out;
  }

  private finish(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    this.ensureRole(out);
    const { id, model } = this.head();
    const finish = this.hasCalls ? "tool_calls" : this.incomplete != null ? "length" : "stop";
    const estimated = !this.usageSeen;
    const outTok = estimated
      ? this.outChars > 0 && this.outSample
        ? Math.max(1, Math.round((estimateTokenCount(this.outSample) * this.outChars) / this.outSample.length))
        : 0
      : this.outTok;
    out.push(
      chatChunk(
        id,
        model,
        { delta: {}, finish_reason: finish },
        {
          prompt_tokens: this.inTok + this.cacheTok,
          completion_tokens: outTok,
          total_tokens: this.inTok + this.cacheTok + outTok,
        },
      ),
    );
    out.push(CHAT_DONE);
    if (estimated) this.outTok = outTok;
    return out;
  }

  result(): ResponsesUsage {
    return {
      inTok: this.inTok,
      cacheTok: this.cacheTok,
      outTok: this.outTok,
      model: this.model,
      estimated: !this.usageSeen,
    };
  }
}

/**
 * Incremental Responses-SSE -> Anthropic-SSE translator.
 * Terminates with message_delta + message_stop (or an `error` event
 * when the upstream fails mid-turn — never a silent stop).
 */
export class ResponsesToAnthropicStream {
  private pending = "";
  private decoder = new TextDecoder();
  private headerSent = false;
  private textOpen = false;
  private textIndex = 0;
  private thinkingOpen = false;
  private thinkingIndex = 0;
  private nextIndex = 0;
  // Keyed by response-scoped item id (`fc_…`, what deltas carry);
  // `callId` (`call_…`) is only informational here.
  private tools = new Map<string, { index: number; id: string; callId: string; name: string }>();
  private model = "";
  private upstreamId = "";
  private incomplete: unknown = null;
  private inTok = 0;
  private cacheTok = 0;
  private outTok = 0;
  private usageSeen = false;
  private done = false;
  private outChars = 0;
  private outSample = "";

  constructor(private fallbackModel: string) {}

  get isDone(): boolean {
    return this.done;
  }

  private addOutText(t: string): void {
    this.outChars += t.length;
    if (this.outSample.length < 2048) {
      this.outSample += t.slice(0, 2048 - this.outSample.length);
    }
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
      if (!data || data === "[DONE]") continue;
      out.push(...this.processData(data));
      if (this.done) break;
    }
    return out;
  }

  flush(): Uint8Array[] {
    if (this.done) return [];
    return this.finish();
  }

  private header(): Uint8Array[] {
    if (this.headerSent) return [];
    this.headerSent = true;
    const model = this.model || this.fallbackModel;
    return [
      rEvent("message_start", {
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
        rEvent("content_block_start", {
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
      out.push(rEvent("content_block_stop", { type: "content_block_stop", index: this.textIndex }));
    }
  }

  private ensureThinking(out: Uint8Array[]): void {
    out.push(...this.header());
    if (!this.thinkingOpen) {
      this.thinkingIndex = this.nextIndex++;
      this.thinkingOpen = true;
      out.push(
        rEvent("content_block_start", {
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
      out.push(rEvent("content_block_stop", { type: "content_block_stop", index: this.thinkingIndex }));
    }
  }

  private processData(data: string): Uint8Array[] {
    const out: Uint8Array[] = [];
    const j = parseDataLine(data);
    if (!j) return [];
    const type = j.type;
    if (type === "response.created" || type === "response.in_progress" || type === "response.queued") {
      const r = asRecord(j.response);
      if (typeof r.id === "string" && r.id && !this.upstreamId) this.upstreamId = r.id;
      if (typeof r.model === "string" && r.model && !this.model) this.model = r.model;
      return out;
    }
    if (type === "response.output_text.delta") {
      const delta = j.delta;
      if (typeof delta === "string" && delta) {
        this.ensureText(out);
        this.addOutText(delta);
        out.push(
          rEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.textIndex,
            delta: { type: "text_delta", text: delta },
          }),
        );
      }
      return out;
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const delta = j.delta;
      if (typeof delta === "string" && delta) {
        this.ensureThinking(out);
        this.addOutText(delta);
        out.push(
          rEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.thinkingIndex,
            delta: { type: "thinking_delta", thinking: delta },
          }),
        );
      }
      return out;
    }
    if (type === "response.output_item.added") {
      const item = asRecord(j.item);
      if (item.type === "function_call") {
        out.push(...this.header());
        this.closeText(out);
        this.closeThinking(out);
        const id =
          typeof item.id === "string" && item.id ? item.id : `fc_${Date.now().toString(36)}`;
        const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : id;
        const index = this.nextIndex++;
        const entry = { index, id, callId, name: typeof item.name === "string" ? item.name : "" };
        this.tools.set(id, entry);
        if (callId !== id) this.tools.set(callId, entry);
        out.push(
          rEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: callId, name: typeof item.name === "string" ? item.name : "", input: {} },
          }),
        );
      }
      return out;
    }
    if (type === "response.function_call_arguments.delta") {
      const delta = j.delta;
      const itemId = typeof j.item_id === "string" ? j.item_id : "";
      const tool = this.tools.get(itemId);
      if (tool && typeof delta === "string" && delta) {
        out.push(
          rEvent("content_block_delta", {
            type: "content_block_delta",
            index: tool.index,
            delta: { type: "input_json_delta", partial_json: delta },
          }),
        );
      }
      return out;
    }
    if (type === "response.output_item.done") {
      const item = asRecord(j.item);
      if (item.type === "reasoning") {
        out.push(...this.header());
        this.closeText(out);
        this.closeThinking(out);
        const id = typeof item.id === "string" ? item.id : "";
        const enc = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
        if (id || enc) {
          const payload = JSON.stringify({
            type: "reasoning",
            id,
            ...(enc ? { encrypted_content: enc } : {}),
          });
          const index = this.nextIndex++;
          out.push(
            rEvent("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "redacted_thinking", data: payload },
            }),
            rEvent("content_block_stop", { type: "content_block_stop", index }),
          );
        }
        return out;
      }
      if (item.type === "function_call") {
        const id = typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "";
        const tool = this.tools.get(id);
        if (tool) {
          out.push(rEvent("content_block_stop", { type: "content_block_stop", index: tool.index }));
        }
      }
      return out;
    }
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      const r = asRecord(j.response);
      const u = responsesUsageSplit(r.usage);
      this.inTok = u.inTok;
      this.cacheTok = u.cacheTok;
      this.outTok = u.outTok;
      this.usageSeen = true;
      if (type !== "response.completed") {
        this.incomplete = asRecord(r.incomplete_details).reason ?? asRecord(r.error).message ?? true;
      }
      out.push(...this.finish());
      return out;
    }
    return out;
  }

  private finish(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    out.push(...this.header());
    this.closeText(out);
    this.closeThinking(out);
    const hasTools = this.tools.size > 0;
    const stop = hasTools ? "tool_use" : this.incomplete != null ? "max_tokens" : "end_turn";
    out.push(
      rEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: this.outTok },
      }),
      rEvent("message_stop", { type: "message_stop" }),
    );
    return out;
  }

  result(): ResponsesUsage {
    if (this.usageSeen) {
      return {
        inTok: this.inTok,
        cacheTok: this.cacheTok,
        outTok: this.outTok,
        model: this.model,
        estimated: false,
      };
    }
    if (this.outChars === 0 || !this.outSample) {
      return { inTok: 0, cacheTok: 0, outTok: 0, model: this.model, estimated: true };
    }
    const scaled = Math.round((estimateTokenCount(this.outSample) * this.outChars) / this.outSample.length);
    return { inTok: 0, cacheTok: 0, outTok: Math.max(1, scaled), model: this.model, estimated: true };
  }
}
