/**
 * Gateway IR — the hub of the hub-and-spoke protocol translation.
 *
 * Architecture: every client protocol (openai/chat, anthropic, responses)
 * DECODEs once into this canonical form; every upstream attempt ENCODEs
 * from it to the attempt's egress protocol — INCLUDING same-protocol
 * attempts (dialects still differ: max_tokens vs max_completion_tokens,
 * thought_signature, id formats, ...). Adding protocol N+1 means writing
 * ONE decoder + ONE encoder (+ response/stream/error hooks), never N new
 * pairwise bridges. Translators are pure/sync over JSON; streaming uses the
 * per-egress incremental writers below; async work (image fetch) lives only
 * at the decode edge.
 *
 * Coverage: text, images (base64 data URLs — remote URLs fetched at decode),
 * tool calls + results across multi-turn conversations, tool_choice,
 * system prompts, stop sequences, sampling params, output limits, stream
 * flags. Drops are documented at each site (hosted/server tools, citations,
 * service-tier metadata...).
 */

export type IRRole = "system" | "user" | "assistant" | "tool";

import { countTextTokens, estimateThinkingTokens } from "../tokens";

/** Canonical content block. `text` is shared; media/tool blocks are typed. */
export type IRBlock =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /** Opaque reasoning passthrough (thought_signature / encrypted). Kept so a
   *  Google->Google or Responses->Responses round-trip stays lossless; only
   *  emitted by encoders that understand it. */
  | { type: "thinking"; format: "google" | "responses" | "text"; data: string };

export interface IRMessage {
  role: "user" | "assistant";
  blocks: IRBlock[];
}

export interface IRTool {
  name: string;
  description?: string;
  parameters: unknown; // JSON schema object
}

export type IRToolChoice =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "required" }
  | { mode: "named"; name: string };

export interface IRParams {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream?: boolean;
  /** Reasoning effort hint ("low"|"medium"|"high"|"max"| custom string). */
  reasoningEffort?: string;
}

export interface GatewayRequest {
  model: string;
  system: string;
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice: IRToolChoice;
  params: IRParams;
  /** Warnings for dropped/unsupported input (hosted tools, citations...). */
  warnings: string[];
}

export type Proto = "openai" | "anthropic" | "responses";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function blockText(v: unknown): string {
  const r = asRecord(v);
  if (r.type === "text" && typeof r.text === "string") return r.text;
  if (r.type === "input_text" && typeof r.text === "string") return r.text;
  if (r.type === "output_text" && typeof r.text === "string") return r.text;
  return "";
}

function toolResultToString(content: unknown): string {
  if (typeof content === "string") return content;
  return asArr(content)
    .map((b) => {
      const t = blockText(b);
      if (t) return t;
      const r = asRecord(b);
      if (typeof (r as any).text === "string") return (r as any).text as string;
      try {
        return JSON.stringify(b);
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function systemToString(system: unknown): string {
  if (typeof system === "string") return system;
  return asArr(system)
    .map((b) => {
      const t = blockText(b);
      if (t) return t;
      const r = asRecord(b);
      if (typeof (r as any).text === "string") return (r as any).text as string;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** data: URL passthrough; returns null for anything else (fetched at edge). */
function imageSourceToDataUrl(source: unknown): string | null {
  const url = typeof source === "string" ? source : asRecord(asRecord(source).image_url).url;
  if (typeof url === "string" && url.startsWith("data:")) return url;
  return null;
}

const REVERSE_IMAGE_TIMEOUT_MS = 15_000;
const REVERSE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Verbatim cap for the stream output-estimate samples (text + tool args).
 *  500KB ≈ 125k tokens — beyond any realistic single-turn model output —
 *  so counting is exact in practice; only the excess past the cap
 *  extrapolates by per-char ratio. Bounds per-stream memory. */
const OUT_SAMPLE_CAP = 500 * 1024;

async function fetchImageToDataUrl(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REVERSE_IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    const ct = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > REVERSE_MAX_IMAGE_BYTES) throw new Error("image too large");
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:${ct};base64,${btoa(binary)}`;
  } finally {
    clearTimeout(t);
  }
}

/** Resolve an image URL-ish value to a data: URL (data passthrough, http fetch). */
export async function imageToDataUrl(url: unknown): Promise<string | null> {
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith("data:")) return url;
  if (/^https?:\/\//i.test(url)) {
    try {
      return await fetchImageToDataUrl(url);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ingress: chat (OpenAI) -> IR
// ---------------------------------------------------------------------------

function openAIPartToText(p: unknown): string {
  const r = asRecord(p);
  if ((r.type === "text" || r.type === "input_text") && typeof r.text === "string") return r.text;
  return "";
}

function openAIToolChoiceToIR(choice: unknown): IRToolChoice {
  if (choice === "required") return { mode: "required" };
  if (choice === "none") return { mode: "none" };
  const r = asRecord(choice);
  if (r.type === "function") {
    const fn = asRecord(r.function);
    if (typeof fn.name === "string") return { mode: "named", name: fn.name };
  }
  return { mode: "auto" };
}

/** Decode an OpenAI chat-completions request body into the gateway IR. */
export async function decodeChatToIR(body: Record<string, unknown>): Promise<GatewayRequest> {
  const warnings: string[] = [];
  const systemParts: string[] = [];
  const messages: IRMessage[] = [];
  // OpenAI packs tool results as `role: tool` messages between turns;
  // accumulate their text per tool_call_id for the next assistant turn.
  let pendingResults: IRBlock[] = [];
  const flushResults = (): IRBlock[] => {
    const r = pendingResults;
    pendingResults = [];
    return r;
  };
  // Text fragments of the current user turn accumulate until a tool message
  // (or the message end) forces a flush.
  let textBuf = "";
  let media: IRBlock[] = [];
  const flushUser = () => {
    const blocks: IRBlock[] = [];
    if (textBuf) blocks.push({ type: "text", text: textBuf });
    blocks.push(...media);
    if (blocks.length) messages.push({ role: "user", blocks });
    textBuf = "";
    media = [];
  };

  for (const raw of asArr(body.messages)) {
    const m = asRecord(raw);
    const role = m.role;
    if (role === "system") {
      const t = typeof m.content === "string" ? m.content : asArr(m.content).map(openAIPartToText).filter(Boolean).join("\n");
      if (t) systemParts.push(t);
      continue;
    }
    if (role === "tool") {
      const toolId = m.tool_call_id;
      if (typeof toolId !== "string" || !toolId) throw new Error("tool message is missing tool_call_id");
      const content = typeof m.content === "string" ? m.content : asArr(m.content).map(openAIPartToText).filter(Boolean).join("\n");
      pendingResults.push({ type: "tool_result", toolUseId: toolId, content });
      continue;
    }
    if (role === "assistant") {
      flushUser();
      const blocks: IRBlock[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
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
        blocks.push({ type: "tool_use", id: r.id, name: fn.name, input });
      }
      // Opaque reasoning passthrough (Google thought_signature, Responses).
      const extra = asRecord(m.extra_content);
      const rr = asRecord(extra.responses_reasoning ?? (m as any).responses_reasoning);
      if (rr && (rr.id || rr.encrypted_content)) {
        blocks.push({
          type: "thinking",
          format: "responses",
          data: JSON.stringify({
            type: "reasoning",
            id: typeof rr.id === "string" ? rr.id : "",
            ...(typeof rr.encrypted_content === "string" ? { encrypted_content: rr.encrypted_content } : {}),
          }),
        });
      } else {
        let sig: unknown = asRecord(extra.google).thought_signature;
        if (!sig)
          for (const tc of asArr(m.tool_calls)) {
            const s = asRecord(asRecord(asRecord(tc).extra_content).google).thought_signature;
            if (typeof s === "string" && s) {
              sig = s;
              break;
            }
          }
        if (typeof sig === "string" && sig) blocks.push({ type: "thinking", format: "google", data: sig });
      }
      // Plain-text reasoning variants some providers attach.
      for (const key of ["reasoning", "reasoning_content"]) {
        if (typeof (m as any)[key] === "string" && (m as any)[key])
          blocks.push({ type: "thinking", format: "text", data: (m as any)[key] });
      }
      const results = flushResults();
      if (results.length) {
        // Tool results belong to the turn BEFORE this assistant message;
        // attach them as a synthetic user turn ahead of it.
        messages.push({ role: "user", blocks: results });
      }
      if (blocks.length) messages.push({ role: "assistant", blocks });
      continue;
    }
    // user role (anything else with string content is user text)
    flushUser();
    const results = flushResults();
    if (results.length) messages.push({ role: "user", blocks: results });
    if (typeof m.content === "string") {
      if (m.content) messages.push({ role: "user", blocks: [{ type: "text", text: m.content }] });
      continue;
    }
    for (const p of asArr(m.content)) {
      const r = asRecord(p);
      if (r.type === "image_url") {
        const url = await imageToDataUrl(asRecord(r.image_url).url);
        if (!url) throw new Error("unsupported image_url (only base64 data: URLs and reachable image http(s) URLs are supported)");
        media.push({ type: "image", dataUrl: url });
      } else {
        const t = openAIPartToText(p);
        if (t) textBuf += (textBuf ? "\n" : "") + t;
        else if (r.type && r.type !== "text") warnings.push(`dropped unsupported chat content part: ${String(r.type)}`);
      }
    }
    flushUser();
  }
  // Trailing tool results with no following assistant turn still form a turn.
  const tail = flushResults();
  if (tail.length) messages.push({ role: "user", blocks: tail });
  flushUser();

  const tools: IRTool[] = asArr(body.tools).map((t) => {
    const fn = asRecord(asRecord(t).function);
    return {
      name: String(fn.name ?? ""),
      description: typeof fn.description === "string" ? fn.description : undefined,
      parameters: fn.parameters ?? { type: "object" },
    };
  }).filter((t) => t.name);

  const maxTok = body.max_tokens ?? body.max_completion_tokens;
  const stop = body.stop;
  const stops = (Array.isArray(stop) ? stop : typeof stop === "string" ? [stop] : []).filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return {
    model: String(body.model ?? ""),
    system: systemParts.join("\n"),
    messages,
    tools,
    toolChoice: openAIToolChoiceToIR(body.tool_choice),
    params: {
      maxTokens: typeof maxTok === "number" && maxTok > 0 ? Math.floor(maxTok) : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      topP: typeof body.top_p === "number" ? body.top_p : undefined,
      stopSequences: stops.length ? stops : undefined,
      stream: body.stream === true ? true : undefined,
      reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ingress: anthropic -> IR
// ---------------------------------------------------------------------------

function anthropicToolChoiceToIR(choice: unknown): IRToolChoice {
  const r = asRecord(choice);
  if (r.type === "any") return { mode: "required" };
  if (r.type === "none") return { mode: "none" };
  if (r.type === "tool" && typeof r.name === "string") return { mode: "named", name: r.name };
  if (r.type === "auto") return { mode: "auto" };
  return { mode: "auto" };
}

/** Decode an Anthropic messages request body into the gateway IR. */
export async function decodeAnthropicToIR(body: Record<string, unknown>): Promise<GatewayRequest> {
  const warnings: string[] = [];
  const messages: IRMessage[] = [];
  let textBuf = "";
  let media: IRBlock[] = [];
  const flushUser = () => {
    const blocks: IRBlock[] = [];
    if (textBuf) blocks.push({ type: "text", text: textBuf });
    blocks.push(...media);
    if (blocks.length) messages.push({ role: "user", blocks });
    textBuf = "";
    media = [];
  };

  for (const raw of asArr(body.messages)) {
    const m = asRecord(raw);
    if (m.role === "assistant") {
      flushUser();
      const blocks: IRBlock[] = [];
      const content = asArr(m.content);
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      for (const b of content) {
        const block = asRecord(b);
        if (block.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: String(block.id ?? ""),
            name: String(block.name ?? ""),
            input: block.input ?? {},
          });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          blocks.push({ type: "thinking", format: "text", data: block.thinking });
        } else if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
          let isResponses = false;
          try {
            if (block.data.startsWith("{")) {
              const parsed = JSON.parse(block.data);
              if (parsed && parsed.type === "reasoning" && typeof parsed.id === "string" && parsed.id.startsWith("rs_")) {
                blocks.push({ type: "thinking", format: "responses", data: block.data });
                isResponses = true;
              }
            }
          } catch {}
          if (!isResponses) blocks.push({ type: "thinking", format: "google", data: block.data });
        } else if (block.type) {
          warnings.push(`dropped unsupported anthropic content block: ${String(block.type)}`);
        }
      }
      if (blocks.length) messages.push({ role: "assistant", blocks });
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
          if (url) media.push({ type: "image", dataUrl: url });
          else warnings.push("dropped unsupported anthropic image source (only base64 supported)");
        } else if (block.type === "tool_result") {
          flushUser();
          messages.push({
            role: "user",
            blocks: [
              {
                type: "tool_result",
                toolUseId: String(block.tool_use_id ?? ""),
                content: toolResultToString(block.content),
                ...(block.is_error === true ? { isError: true as const } : {}),
              },
            ],
          });
        } else if (block.type) {
          warnings.push(`dropped unsupported anthropic content block: ${String(block.type)}`);
        }
      }
    }
  }
  flushUser();

  const tools: IRTool[] = asArr(body.tools).map((t) => {
    const r = asRecord(t);
    return {
      name: String(r.name ?? ""),
      description: typeof r.description === "string" ? r.description : undefined,
      parameters: r.input_schema ?? { type: "object" },
    };
  }).filter((t) => t.name);

  const thinking = asRecord(body.thinking);
  return {
    model: String(body.model ?? ""),
    system: systemToString(body.system),
    messages,
    tools,
    toolChoice: anthropicToolChoiceToIR(body.tool_choice),
    params: {
      maxTokens: typeof body.max_tokens === "number" && body.max_tokens > 0 ? Math.floor(body.max_tokens) : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      topP: typeof body.top_p === "number" ? body.top_p : undefined,
      stopSequences: asArr(body.stop_sequences).filter((s): s is string => typeof s === "string"),
      stream: body.stream === true ? true : undefined,
      reasoningEffort: thinking.type === "enabled" ? "high" : undefined,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// ingress: responses -> IR
// ---------------------------------------------------------------------------

/** Decode an OpenAI Responses request body into the gateway IR. */
export async function decodeResponsesToIR(body: Record<string, unknown>): Promise<GatewayRequest> {
  const warnings: string[] = [];
  const systemParts: string[] = [];
  const instr = body.instructions;
  if (typeof instr === "string" && instr) systemParts.push(instr);
  else if (Array.isArray(instr)) {
    const t = instr.map(blockText).filter(Boolean).join("\n");
    if (t) systemParts.push(t);
  }
  const messages: IRMessage[] = [];

  // `input` may be a plain string, a message list, or a free-form item list.
  const input = body.input;
  const items: unknown[] = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : asArr(input);
  // Responses reuse function_call_output items as tool results; they may
  // arrive BEFORE/AFTER their turn — buffer by call_id until flushed.
  const pendingOutputs = new Map<string, IRBlock>();
  // Text of the current turn accumulates across adjacent message items.
  let textBuf = "";
  let media: IRBlock[] = [];
  const flushTurn = () => {
    const blocks: IRBlock[] = [];
    if (textBuf) blocks.push({ type: "text", text: textBuf });
    blocks.push(...media);
    if (blocks.length) messages.push({ role: "user", blocks });
    textBuf = "";
    media = [];
  };
  const flushOutputs = () => {
    if (pendingOutputs.size) {
      messages.push({ role: "user", blocks: [...pendingOutputs.values()] });
      pendingOutputs.clear();
    }
  };

  for (const raw of items) {
    const item = asRecord(raw);
    const itype = typeof item.type === "string" ? item.type : "message";
    if (itype === "message") {
      const role = item.role;
      if (role === "system" || role === "developer") {
        const t = typeof item.content === "string" ? item.content : asArr(item.content).map(blockText).filter(Boolean).join("\n");
        if (t) systemParts.push(t);
        continue;
      }
      if (role === "assistant") {
        flushTurn();
        flushOutputs();
        const blocks: IRBlock[] = [];
        if (typeof item.content === "string" && item.content) blocks.push({ type: "text", text: item.content });
        for (const p of asArr(item.content)) {
          const t = blockText(p);
          if (t) blocks.push({ type: "text", text: t });
        }
        if (blocks.length) messages.push({ role: "assistant", blocks });
        continue;
      }
      // user message
      flushOutputs();
      if (typeof item.content === "string") {
        textBuf += (textBuf ? "\n" : "") + item.content;
        continue;
      }
      for (const p of asArr(item.content)) {
        const r = asRecord(p);
        if (r.type === "input_text" && typeof r.text === "string") {
          textBuf += (textBuf ? "\n" : "") + r.text;
        } else if (r.type === "input_image" && typeof r.image_url === "string") {
          const url = await imageToDataUrl(r.image_url);
          if (!url) throw new Error("unsupported input_image (only base64 data: URLs and reachable image http(s) URLs are supported)");
          media.push({ type: "image", dataUrl: url });
        } else if (r.type) {
          warnings.push(`dropped unsupported responses input part: ${String(r.type)}`);
        }
      }
      continue;
    }
    if (itype === "function_call") {
      flushTurn();
      flushOutputs();
      let args: unknown = {};
      if (typeof item.arguments === "string" && item.arguments) {
        try {
          args = JSON.parse(item.arguments);
        } catch {
          args = {};
        }
      } else if (item.arguments !== undefined) args = item.arguments;
      const last = messages[messages.length - 1];
      const call: IRBlock = {
        type: "tool_use",
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "",
        name: typeof item.name === "string" ? item.name : "",
        input: args,
      };
      if (last && last.role === "assistant") last.blocks.push(call);
      else messages.push({ role: "assistant", blocks: [call] });
      continue;
    }
    if (itype === "function_call_output") {
      flushTurn();
      pendingOutputs.set(typeof item.call_id === "string" ? item.call_id : `out_${pendingOutputs.size}`, {
        type: "tool_result",
        toolUseId: typeof item.call_id === "string" ? item.call_id : "",
        content: typeof item.output === "string" ? item.output : toolResultToString(item.output),
      });
      continue;
    }
    if (itype === "reasoning") {
      // Provider thinking summaries are visibility-only; keep as text thinking.
      const texts: string[] = [];
      for (const s of asArr(item.summary)) texts.push(blockText(s));
      for (const c of asArr(item.content)) texts.push(blockText(c));
      const t = texts.filter(Boolean).join("\n");
      if (t) {
        const last = messages[messages.length - 1];
        const blk: IRBlock = { type: "thinking", format: "text", data: t };
        if (last && last.role === "assistant") last.blocks.push(blk);
        else messages.push({ role: "assistant", blocks: [blk] });
      }
      continue;
    }
    warnings.push(`dropped unsupported responses item: ${itype}`);
  }
  flushTurn();
  flushOutputs();

  const tools: IRTool[] = [];
  for (const t of asArr(body.tools)) {
    const r = asRecord(t);
    if (r.type === "function" || (typeof r.name === "string" && r.parameters !== undefined)) {
      tools.push({
        name: String(r.name ?? ""),
        description: typeof r.description === "string" ? r.description : undefined,
        parameters: r.parameters ?? { type: "object" },
      });
    } else if (typeof r.type === "string") {
      // Hosted/server tools (web_search, file_search, mcp, computer...).
      warnings.push(`dropped hosted responses tool: ${String(r.type)}`);
    }
  }

  const tc = body.tool_choice;
  let toolChoice: IRToolChoice = { mode: "auto" };
  if (tc === "required") toolChoice = { mode: "required" };
  else if (tc === "none") toolChoice = { mode: "none" };
  else {
    const r = asRecord(tc);
    if (r.type === "function" && typeof r.name === "string") toolChoice = { mode: "named", name: r.name };
  }

  if (body.previous_response_id !== undefined) {
    throw new Error("previous_response_id requires a native Responses upstream (no translation available)");
  }

  return {
    model: String(body.model ?? ""),
    system: systemParts.join("\n"),
    messages: messages.filter((m) => m.blocks.length > 0),
    tools: tools.filter((t) => t.name),
    toolChoice,
    params: {
      maxTokens: typeof body.max_output_tokens === "number" && body.max_output_tokens > 0 ? Math.floor(body.max_output_tokens) : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      topP: typeof body.top_p === "number" ? body.top_p : undefined,
      stream: body.stream === true ? true : undefined,
      reasoningEffort: typeof asRecord(body.reasoning).effort === "string" ? String(asRecord(body.reasoning).effort) : undefined,
    },
    warnings,
  };
}

/** Decode any ingress protocol body into the gateway IR. */
export async function decodeToIR(proto: Proto, body: Record<string, unknown>): Promise<GatewayRequest> {
  if (proto === "anthropic") return decodeAnthropicToIR(body);
  if (proto === "responses") return decodeResponsesToIR(body);
  return decodeChatToIR(body);
}

// ---------------------------------------------------------------------------
// egress: IR -> chat (OpenAI)
// ---------------------------------------------------------------------------

function irToolChoiceToChat(c: IRToolChoice): string | Record<string, unknown> {
  if (c.mode === "required") return "required";
  if (c.mode === "none") return "none";
  if (c.mode === "named") return { type: "function", function: { name: c.name } };
  return "auto";
}

/** Encode the gateway IR as an OpenAI chat-completions request body. */
export function encodeIRToChat(ir: GatewayRequest, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model, stream: ir.params.stream === true };
  // Classic `max_tokens` is the portable chat output-limit name: strict
  // upstreams (luna class) are renamed to `max_completion_tokens` by the
  // universal target-profile pass per attempt; unknown-param-strict
  // upstreams (Meta chat: "unknown parameter `max_completion_tokens`")
  // accept the classic name as-is.
  if (ir.params.maxTokens !== undefined) out.max_tokens = ir.params.maxTokens;
  const messages: Record<string, unknown>[] = [];
  if (ir.system) messages.push({ role: "system", content: ir.system });
  for (const m of ir.messages) {
    if (m.role === "user") {
      const texts: string[] = [];
      const media: Record<string, unknown>[] = [];
      for (const b of m.blocks) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "image") media.push({ type: "image_url", image_url: { url: b.dataUrl } });
        else if (b.type === "tool_result") {
          // Flush pending user content, then emit one role:tool message.
          if (texts.length || media.length) {
            messages.push(
              media.length
                ? { role: "user", content: [...(texts.length ? [{ type: "text", text: texts.join("\n") }] : []), ...media] }
                : { role: "user", content: texts.join("\n") },
            );
            texts.length = 0;
            media.length = 0;
          }
          messages.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content + (b.isError ? " [error]" : "") });
        }
      }
      if (texts.length || media.length) {
        messages.push(
          media.length
            ? { role: "user", content: [...(texts.length ? [{ type: "text", text: texts.join("\n") }] : []), ...media] }
            : { role: "user", content: texts.join("\n") },
        );
      }
    } else {
      const msg: Record<string, unknown> = { role: "assistant" };
      const texts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      for (const b of m.blocks) {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === "thinking") {
          if (b.format === "google") {
            msg.extra_content = { ...asRecord(msg.extra_content), google: { thought_signature: b.data } };
            // Tool calls replay the signature too (Gemini requirement).
            for (const tc of toolCalls) {
              tc.extra_content = { ...asRecord(tc.extra_content), google: { thought_signature: b.data } };
            }
          } else if (b.format === "responses") {
            try {
              const parsed = JSON.parse(b.data);
              msg.responses_reasoning = parsed;
              msg.extra_content = { ...asRecord(msg.extra_content), responses_reasoning: parsed };
            } catch {}
          }
        }
      }
      // Attach google signature to tool calls that came after the block.
      // Gemini hard-requires thought_signature on functionCall parts: when
      // the IR turn carries one, replay it on EVERY tool call in the turn
      // (message-level extra_content AND each tool_calls[] entry). When the
      // turn has tool_calls but NO signature (fresh client multi-turn being
      // fanned out to a Gemini egress), the caller (encodeIR) may set
      // `needsGoogleSignature`; without a signature Gemini 400s, so the
      // tool_call parts are demoted to plain-text recap instead.
      const gsig = asRecord(asRecord(msg.extra_content).google).thought_signature;
      if (typeof gsig === "string" && gsig) {
        for (const tc of toolCalls) {
          if (!asRecord(asRecord(tc.extra_content).google).thought_signature) {
            tc.extra_content = { ...asRecord(tc.extra_content), google: { thought_signature: gsig } };
          }
        }
      }
      if (texts.length) msg.content = texts.join("\n");
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (texts.length || toolCalls.length || msg.extra_content || msg.responses_reasoning) messages.push(msg);
    }
  }
  out.messages = messages;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters ?? {} },
    }));
    out.tool_choice = irToolChoiceToChat(ir.toolChoice);
  }
  if (ir.params.temperature !== undefined) out.temperature = ir.params.temperature;
  if (ir.params.topP !== undefined) out.top_p = ir.params.topP;
  if (ir.params.stopSequences?.length) out.stop = ir.params.stopSequences;
  // Reasoning-effort passthrough: MuseSpark-class reasoning models burn the
  // whole output budget on thinking unless told otherwise — a client that
  // says effort=low (chat `reasoning_effort`, Anthropic `thinking`,
  // Responses `reasoning.effort`) must have it honored on EVERY egress so
  // translated attempts don't 400/length where the native one succeeds.
  // Unknown to the client: default low so any->any translations terminate.
  out.reasoning_effort = ir.params.reasoningEffort ?? "low";
  if (out.stream === true) out.stream_options = { include_usage: true };
  return out;
}

// ---------------------------------------------------------------------------
// egress: IR -> anthropic
// ---------------------------------------------------------------------------

function irToolChoiceToAnthropic(c: IRToolChoice): Record<string, unknown> | undefined {
  if (c.mode === "required") return { type: "any" };
  if (c.mode === "none") return { type: "none" };
  if (c.mode === "named") return { type: "tool", name: c.name };
  return undefined; // default auto — omit
}

function dataUrlToAnthropicImage(dataUrl: string): Record<string, unknown> | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

/** Encode the gateway IR as an Anthropic messages request body. */
export function encodeIRToAnthropic(ir: GatewayRequest, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model, stream: ir.params.stream === true };
  out.max_tokens = ir.params.maxTokens ?? 4096;
  // Pending user fragments accumulate until a tool_result (or the message
  // end) forces a flush — Anthropic nests tool_result blocks inside a user
  // message while chat/responses want one message per result.
  const messages: Record<string, unknown>[] = [];
  let textBuf = "";
  let media: Record<string, unknown>[] = [];
  const flushUser = () => {
    if (!textBuf && media.length === 0) return;
    if (media.length === 0) messages.push({ role: "user", content: textBuf });
    else {
      const parts: Record<string, unknown>[] = [];
      if (textBuf) parts.push({ type: "text", text: textBuf });
      parts.push(...media);
      messages.push({ role: "user", content: parts });
    }
    textBuf = "";
    media = [];
  };

  for (const m of ir.messages) {
    if (m.role === "assistant") {
      flushUser();
      const content: Record<string, unknown>[] = [];
      for (const b of m.blocks) {
        if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") {
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
        } else if (b.type === "thinking") {
          if (b.format === "text") content.push({ type: "thinking", thinking: b.data });
          else content.push({ type: "redacted_thinking", data: b.data });
        }
      }
      if (content.length) messages.push({ role: "assistant", content });
    } else {
      for (const b of m.blocks) {
        if (b.type === "text") textBuf += (textBuf ? "\n" : "") + b.text;
        else if (b.type === "image") {
          const img = dataUrlToAnthropicImage(b.dataUrl);
          if (img) media.push(img);
        } else if (b.type === "tool_result") {
          flushUser();
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: b.toolUseId,
                content: b.content,
                ...(b.isError ? { is_error: true as const } : {}),
              },
            ],
          });
        }
      }
    }
  }
  flushUser();
  out.messages = messages;
  if (ir.system) out.system = ir.system;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: "object" },
    }));
    const choice = irToolChoiceToAnthropic(ir.toolChoice);
    if (choice !== undefined) out.tool_choice = choice;
  }
  if (ir.params.temperature !== undefined) out.temperature = ir.params.temperature;
  if (ir.params.topP !== undefined) out.top_p = ir.params.topP;
  if (ir.params.stopSequences?.length) out.stop_sequences = ir.params.stopSequences;
  if (ir.params.reasoningEffort !== undefined) out.thinking = { type: "enabled", budget_tokens: 10000 };
  return out;
}

// ---------------------------------------------------------------------------
// egress: IR -> responses
// ---------------------------------------------------------------------------

/** Encode the gateway IR as an OpenAI Responses request body. */
export function encodeIRToResponses(ir: GatewayRequest, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { model, stream: ir.params.stream === true };
  if (ir.params.maxTokens !== undefined) out.max_output_tokens = ir.params.maxTokens;
  if (ir.system) out.instructions = ir.system;
  const input: Record<string, unknown>[] = [];
  for (const m of ir.messages) {
    if (m.role === "user") {
      const content: Record<string, unknown>[] = [];
      for (const b of m.blocks) {
        if (b.type === "text") content.push({ type: "input_text", text: b.text });
        else if (b.type === "image") content.push({ type: "input_image", image_url: b.dataUrl });
        else if (b.type === "tool_result") {
          if (content.length) {
            input.push({ type: "message", role: "user", content });
            content.length = 0;
          }
          input.push({
            type: "function_call_output",
            call_id: b.toolUseId,
            output: b.content + (b.isError ? " [error]" : ""),
          });
        }
      }
      if (content.length) input.push({ type: "message", role: "user", content });
    } else {
      const assistantTexts: string[] = [];
      for (const b of m.blocks) {
        if (b.type === "text") assistantTexts.push(b.text);
        else if (b.type === "tool_use") {
          if (assistantTexts.length) {
            input.push({ type: "message", role: "assistant", content: assistantTexts.join("\n") });
            assistantTexts.length = 0;
          }
          input.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        } else if (b.type === "thinking" && b.format === "text") {
          if (assistantTexts.length) {
            input.push({ type: "message", role: "assistant", content: assistantTexts.join("\n") });
            assistantTexts.length = 0;
          }
          input.push({ type: "reasoning", summary: [{ type: "summary_text", text: b.data }] });
        }
        // google/responses opaque thinking has no Responses input
        // representation — dropped (same-proto round-trip keeps it via
        // the response path, not the request path).
      }
      if (assistantTexts.length) input.push({ type: "message", role: "assistant", content: assistantTexts.join("\n") });
    }
  }
  out.input = input;
  if (ir.tools.length) {
    out.tools = ir.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object" },
    }));
    const c = ir.toolChoice;
    out.tool_choice = c.mode === "required" ? "required" : c.mode === "none" ? "none" : c.mode === "named" ? { type: "function", name: c.name } : "auto";
  }
  if (ir.params.temperature !== undefined) out.temperature = ir.params.temperature;
  if (ir.params.topP !== undefined) out.top_p = ir.params.topP;
  if (ir.params.reasoningEffort !== undefined) out.reasoning = { effort: ir.params.reasoningEffort };
  return out;
}

/** Encode the gateway IR to any egress protocol body. */
export function encodeIR(proto: Proto, ir: GatewayRequest, model: string): Record<string, unknown> {
  // Empty model = keep the ingress model id (the loop only passes "" when
  // the target has no model override); the legacy bridges preserved it too.
  const m = model || ir.model;
  if (proto === "anthropic") return encodeIRToAnthropic(ir, m);
  if (proto === "responses") return encodeIRToResponses(ir, m);
  const body = encodeIRToChat(ir, m);
  if (isGeminiModel(m)) demoteUnsignedToolCalls(body);
  return body;
}

/** Gemini chat models hard-require thought_signature on functionCall parts. */
function isGeminiModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("gemini") || m.includes("gemma");
}

/**
 * Demote signature-less tool_call parts to plain-text recap so Gemini
 * answers without functionCall parts (no thought_signature needed).
 * Turns that carry a replayable signature are untouched.
 */
function demoteUnsignedToolCalls(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;
  for (const raw of messages) {
    const msg = asRecord(raw);
    if (msg.role !== "assistant") continue;
    const calls = msg.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const msgSig = asRecord(asRecord(msg.extra_content).google).thought_signature;
    const hasSig =
      typeof msgSig === "string" &&
      (calls as unknown[]).every(
        (c) => typeof asRecord(asRecord(c).extra_content).google === "object" || typeof msgSig === "string",
      );
    void hasSig;
    // A replayable message-level signature covers every call in the turn.
    if (typeof msgSig === "string" && msgSig) continue;
    // Check per-call signatures.
    let allSigned = true;
    for (const c of calls as unknown[]) {
      const s = asRecord(asRecord(asRecord(c).extra_content).google).thought_signature;
      if (typeof s !== "string" || !s) {
        allSigned = false;
        break;
      }
    }
    if (allSigned) continue;
    const parts: string[] = [];
    if (typeof msg.content === "string" && msg.content) parts.push(msg.content);
    for (const c of calls as unknown[]) {
      const fn = asRecord(asRecord(c).function);
      parts.push(`[tool call ${String(fn.name ?? "unknown")}: ${String(fn.arguments ?? "{}")}]`);
    }
    msg.content = parts.join("\n");
    delete msg.tool_calls;
  }
  // A role:tool message without a matching functionCall part is an orphan
  // function_response for Gemini (400 "Name cannot be empty"): fold orphan
  // tool results into a neighboring user turn as plain text.
  for (let i = 0; i < messages.length; i++) {
    const m2 = asRecord(messages[i]);
    if (m2.role !== "tool") continue;
    const prev = asRecord(messages[i - 1]);
    if (Array.isArray((prev as Record<string, unknown>).tool_calls)) continue;
    const text = `[tool result ${String((m2 as Record<string, unknown>).tool_call_id ?? "")}]: ${String((m2 as Record<string, unknown>).content ?? "")}`;
    if (i + 1 < messages.length) {
      const next = asRecord(messages[i + 1]);
      if (next.role === "user") {
        next.content = typeof next.content === "string" && next.content ? `${next.content}\n${text}` : text;
        messages.splice(i, 1);
        i--;
        continue;
      }
    }
    // role:tool must not carry tool_call_id into a plain user message.
    delete (m2 as Record<string, unknown>).tool_call_id;
    m2.role = "user";
  }
}

// ---------------------------------------------------------------------------
// response path: upstream body (buffered JSON) -> IR -> client body
// ---------------------------------------------------------------------------

export interface IRResponse {
  id: string;
  model: string;
  /** Visible text (reasoning excluded — it never becomes billable output). */
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  /** Opaque thinking for same-family round-trips. */
  thinking: Extract<IRBlock, { type: "thinking" }>[];
  finish: "stop" | "length" | "tool_calls" | "content_filter";
  inTok: number;
  cacheTok: number;
  outTok: number;
  /** Reasoning tokens (visible-text-excluded). Emitted as real
   *  `reasoning_tokens` in responses usage — strict clients (codex) 500
   *  when the field is missing. */
  reasonTok: number;
  /** True when usage was absent and had to be estimated. */
  usageEstimated: boolean;
  /** Raw request-body size (chars) — reserved for future input guards. */
  requestChars?: number;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return asRecord(Array.isArray(v) ? v[0] : v);
  } catch {
    return {};
  }
}

/** Parse a buffered upstream response of any protocol into an IRResponse.
 *
 *  Zero-input guard: when the upstream reports in+cache == 0 but the
 *  request body was non-trivial, the zero is a lie (observed live:
 *  MuseSpark 400k-context turn billed in:0/cache:0). The caller owns the
 *  body estimate — pass it via `bodyInEstimate`; the decoder then flags
 *  the response estimated and lets the record() call site split it into
 *  fresh/cache via the prefix-stability tracker. Nonzero upstream input
 *  figures are never touched. */
export function decodeResponseToIR(
  via: Proto,
  text: string,
  fallbackModel: string,
  bodyInEstimate?: number,
): IRResponse {
  const dec =
    via === "anthropic"
      ? decodeAnthropicResponseToIR(text, fallbackModel)
      : via === "responses"
        ? decodeResponsesResponseToIR(text, fallbackModel)
        : decodeChatResponseToIR(text, fallbackModel);
  if (bodyInEstimate !== undefined && bodyInEstimate > 0 && dec.inTok <= 0 && dec.cacheTok <= 0) {
    dec.usageEstimated = true;
  }
  return dec;
}

function decodeChatResponseToIR(text: string, fallbackModel: string): IRResponse {
  const j = parseJsonObject(text);
  const choices = asArr(j.choices);
  const first = asRecord(choices[0]);
  const message = asRecord(first.message);
  const toolUses: IRResponse["toolUses"] = [];
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
    if (typeof r.id === "string" && typeof fn.name === "string") {
      toolUses.push({ id: r.id, name: fn.name, input });
    }
  }
  const thinking: Extract<IRBlock, { type: "thinking" }>[] = [];
  const extra = asRecord(message.extra_content);
  const rr = asRecord(extra.responses_reasoning ?? (message as any).responses_reasoning);
  if (rr && (rr.id || rr.encrypted_content)) {
    thinking.push({
      type: "thinking",
      format: "responses",
      data: JSON.stringify({
        type: "reasoning",
        id: typeof rr.id === "string" ? rr.id : "",
        ...(typeof rr.encrypted_content === "string" ? { encrypted_content: rr.encrypted_content } : {}),
      }),
    });
  } else {
    let sig: unknown = asRecord(extra.google).thought_signature;
    if (!sig) {
      for (const tc of asArr(message.tool_calls)) {
        const s = asRecord(asRecord(asRecord(tc).extra_content).google).thought_signature;
        if (typeof s === "string" && s) {
          sig = s;
          break;
        }
      }
    }
    if (typeof sig === "string" && sig) thinking.push({ type: "thinking", format: "google", data: sig });
  }
  for (const key of ["reasoning", "reasoning_content"]) {
    if (typeof (message as any)[key] === "string" && (message as any)[key]) {
      thinking.push({ type: "thinking", format: "text", data: (message as any)[key] });
    }
  }
  const u = asRecord(j.usage);
  const prompt = Number(u.prompt_tokens ?? 0) || 0;
  const cached = Number(asRecord(u.prompt_tokens_details).cached_tokens ?? 0) || 0;
  const completion = Number(u.completion_tokens ?? 0) || 0;
  const reasonTok = Math.max(0, Number(asRecord(u.completion_tokens_details).reasoning_tokens ?? 0) || 0);
  const outTok = Math.max(0, completion - reasonTok);
  const visibleText = typeof message.content === "string" ? message.content : "";
  // Zero-output guard (buffered): upstream said 0 output but visible text/
  // tool bytes arrived. Estimate via btdby4 (conservative) and flag
  // estimated — trusting the zero would erase the turn. Nonzero figures
  // are never overridden. Output estimates use btdby4; input/cache splits
  // come from the btdby4 KV provider in the proxy record() path.
  const usageSaidNothing = u.prompt_tokens === undefined && u.completion_tokens === undefined;
  let estimated = usageSaidNothing;
  let finalOut = outTok;
  if (!usageSaidNothing && outTok <= 0 && (visibleText.length > 0 || toolUses.length > 0)) {
    finalOut = estimateBufferedOutTok(visibleText, toolUses, thinking);
    estimated = true;
  }
  const finish = String(first.finish_reason ?? "stop");
  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" && j.model ? j.model : fallbackModel,
    text: visibleText,
    toolUses,
    thinking,
    finish: finish === "length" ? "length" : finish === "tool_calls" ? "tool_calls" : finish === "content_filter" ? "content_filter" : "stop",
    inTok: Math.max(0, prompt - cached),
    cacheTok: Math.max(0, cached),
    outTok: finalOut,
    reasonTok,
    usageEstimated: estimated,
  };
}

function decodeAnthropicResponseToIR(text: string, fallbackModel: string): IRResponse {
  const j = parseJsonObject(text);
  let outText = "";
  const toolUses: IRResponse["toolUses"] = [];
  const thinking: Extract<IRBlock, { type: "thinking" }>[] = [];
  for (const b of asArr(j.content)) {
    const block = asRecord(b);
    if (block.type === "text" && typeof block.text === "string") outText += (outText ? "\n" : "") + block.text;
    else if (block.type === "tool_use") {
      toolUses.push({
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: block.input ?? {},
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      thinking.push({ type: "thinking", format: "text", data: block.thinking });
    } else if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
      let isResponses = false;
      try {
        if (block.data.startsWith("{")) {
          const parsed = JSON.parse(block.data);
          if (parsed && parsed.type === "reasoning" && typeof parsed.id === "string" && parsed.id.startsWith("rs_")) {
            thinking.push({ type: "thinking", format: "responses", data: block.data });
            isResponses = true;
          }
        }
      } catch {}
      if (!isResponses) thinking.push({ type: "thinking", format: "google", data: block.data });
    }
  }
  const u = asRecord(j.usage);
  const input = Number(u.input_tokens ?? 0) || 0;
  const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheCreation = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const stop = String(j.stop_reason ?? "end_turn");
  const outReported = Number(u.output_tokens ?? 0) || 0;
  // Zero-output guard (buffered): upstream said 0 output but visible text/
  // tool bytes arrived. Estimate via btdby4 (conservative) and flag
  // estimated — trusting the zero would erase the turn. Nonzero figures
  // are never overridden. Output estimates use btdby4; input/cache splits
  // come from the btdby4 KV provider in the proxy record() path.
  const usageSaidNothing = u.input_tokens === undefined && u.output_tokens === undefined;
  let estimated = usageSaidNothing;
  let finalOut = outReported;
  if (!usageSaidNothing && outReported <= 0 && (outText.length > 0 || toolUses.length > 0)) {
    finalOut = estimateBufferedOutTok(outText, toolUses, thinking);
    estimated = true;
  }
  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" && j.model ? j.model : fallbackModel,
    text: outText,
    toolUses,
    thinking,
    finish: stop === "max_tokens" ? "length" : toolUses.length ? "tool_calls" : stop === "refusal" ? "content_filter" : "stop",
    inTok: input,
    cacheTok: cacheRead + cacheCreation,
    outTok: finalOut,
    reasonTok: Math.max(0, Number(asRecord(u.output_tokens_details).thinking_tokens ?? 0) || 0),
    usageEstimated: estimated,
  };
}

function decodeResponsesResponseToIR(text: string, fallbackModel: string): IRResponse {
  const j = parseJsonObject(text);
  let outText = "";
  const toolUses: IRResponse["toolUses"] = [];
  const thinking: Extract<IRBlock, { type: "thinking" }>[] = [];
  for (const item of asArr(j.output)) {
    const r = asRecord(item);
    if (r.type === "message") {
      for (const p of asArr(r.content)) {
        const t = blockText(p);
        if (t) outText += (outText ? "\n" : "") + t;
      }
    } else if (r.type === "function_call") {
      let args: unknown = {};
      if (typeof r.arguments === "string" && r.arguments) {
        try {
          args = JSON.parse(r.arguments);
        } catch {
          args = {};
        }
      }
      toolUses.push({
        id: typeof r.call_id === "string" ? r.call_id : typeof r.id === "string" ? r.id : "",
        name: typeof r.name === "string" ? r.name : "",
        input: args,
      });
    } else if (r.type === "reasoning") {
      const texts: string[] = [];
      for (const s of asArr(r.summary)) texts.push(blockText(s));
      for (const c of asArr(r.content)) texts.push(blockText(c));
      const t = texts.filter(Boolean).join("\n");
      if (t) thinking.push({ type: "thinking", format: "text", data: t });
    }
  }
  // Fallback: some providers echo output_text at the top level.
  if (!outText && !toolUses.length && typeof j.output_text === "string") outText = j.output_text;
  const u = asRecord(j.usage);
  const input = Number(u.input_tokens ?? 0) || 0;
  const cached = Number(asRecord(u.input_tokens_details).cached_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? 0) || 0;
  const reasonTok = Math.max(0, Number(asRecord(u.output_tokens_details).reasoning_tokens ?? 0) || 0);
  const outTok = Math.max(0, output - reasonTok);
  // Zero-output guard (buffered): upstream said 0 output but visible text/
  // tool bytes arrived. Estimate via btdby4 (conservative) and flag
  // estimated — trusting the zero would erase the turn. Nonzero figures
  // are never overridden. Output estimates use btdby4; input/cache splits
  // come from the btdby4 KV provider in the proxy record() path.
  const usageSaidNothing = u.input_tokens === undefined && u.output_tokens === undefined;
  let estimated = usageSaidNothing;
  let finalOut = outTok;
  if (!usageSaidNothing && outTok <= 0 && (outText.length > 0 || toolUses.length > 0)) {
    finalOut = estimateBufferedOutTok(outText, toolUses, thinking);
    estimated = true;
  }
  return {
    id: typeof j.id === "string" ? j.id : "",
    model: typeof j.model === "string" && j.model ? j.model : fallbackModel,
    text: outText,
    toolUses,
    thinking,
    finish: toolUses.length ? "tool_calls" : String((j as any).incomplete_details?.reason ?? "") === "max_output_tokens" ? "length" : "stop",
    inTok: Math.max(0, input - cached),
    cacheTok: Math.max(0, cached),
    outTok: finalOut,
    reasonTok,
    usageEstimated: estimated,
  };
}

/** Full output estimate for the buffered path: text + tool-arg JSON
 *  (both via the btdby4 text counter) + opaque thinking payloads. */
function estimateBufferedOutTok(
  text: string,
  toolUses: Array<{ input: unknown }>,
  thinking: Array<{ format: string; data: string }>,
): number {
  let total = 0;
  if (text) total += countTextTokens(text);
  for (const t of toolUses) {
    try {
      total += countTextTokens(JSON.stringify(t.input ?? {}));
    } catch {
      total += 1;
    }
  }
  for (const th of thinking) {
    if (th.format === "text") total += countTextTokens(th.data);
    else total += estimateThinkingTokens(th.data);
  }
  return Math.max(1, total);
}

// ---------------------------------------------------------------------------
// response path: IR -> client body (buffered JSON)
// ---------------------------------------------------------------------------

/** Encode an IRResponse as the client's protocol (buffered JSON body). */
export function encodeResponseFromIR(proto: Proto, r: IRResponse, fallbackModel: string): string {
  const model = r.model || fallbackModel;
  if (proto === "anthropic") {
    const content: Record<string, unknown>[] = [];
    for (const t of r.thinking) {
      if (t.format === "text") content.push({ type: "thinking", thinking: t.data });
      else content.push({ type: "redacted_thinking", data: t.data });
    }
    if (r.text) content.push({ type: "text", text: r.text });
    for (const t of r.toolUses) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input ?? {} });
    return JSON.stringify({
      id: r.id || `msg_${Date.now().toString(36)}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: r.toolUses.length ? "tool_use" : r.finish === "length" ? "max_tokens" : r.finish === "content_filter" ? "refusal" : "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: r.inTok,
        output_tokens: r.outTok + r.toolUses.length * 0, // tool JSON is provider-side; usage comes from upstream
        cache_read_input_tokens: r.cacheTok,
      },
    });
  }
  if (proto === "responses") {
    const output: Record<string, unknown>[] = [];
    for (const t of r.thinking) {
      if (t.format === "text") output.push({ type: "reasoning", summary: [{ type: "summary_text", text: t.data }] });
    }
    if (r.text || !r.toolUses.length) {
      output.push({
        type: "message",
        id: `msg_${(r.id || "tmp").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "tmp"}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: r.text, annotations: [] }],
      });
    }
    for (const t of r.toolUses) {
      output.push({
        type: "function_call",
        id: t.id,
        call_id: t.id,
        name: t.name,
        arguments: JSON.stringify(t.input ?? {}),
        status: "completed",
      });
    }
    return JSON.stringify({
      id: r.id || `resp_${Date.now().toString(36)}`,
      object: "response",
      created_at: Date.now() / 1000,
      model,
      status: "completed",
      output,
      usage: {
        input_tokens: r.inTok + r.cacheTok,
        input_tokens_details: { cached_tokens: r.cacheTok },
        output_tokens: r.outTok,
        output_tokens_details: { reasoning_tokens: r.reasonTok },
        total_tokens: r.inTok + r.cacheTok + r.outTok,
      },
    });
  }
  // chat
  const message: Record<string, unknown> = { role: "assistant", content: r.text };
  if (r.toolUses.length) {
    message.tool_calls = r.toolUses.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
    }));
  }
  for (const t of r.thinking) {
    if (t.format === "google") {
      (message as any).extra_content = { ...(message as any).extra_content, google: { thought_signature: t.data } };
    } else if (t.format === "responses") {
      try {
        const parsed = JSON.parse(t.data);
        (message as any).responses_reasoning = parsed;
        (message as any).extra_content = { ...(message as any).extra_content, responses_reasoning: parsed };
      } catch {}
    } else if (t.format === "text") {
      (message as any).reasoning_content = t.data;
    }
  }
  return JSON.stringify({
    id: r.id || `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: r.finish,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: r.inTok + r.cacheTok,
      completion_tokens: r.outTok,
      total_tokens: r.inTok + r.cacheTok + r.outTok,
      prompt_tokens_details: { cached_tokens: r.cacheTok },
    },
  });
}

/**
 * Translate a buffered upstream response body to the client's protocol via
 * the IR. Returns the translated body text plus usage for accounting.
 */
export function translateBufferedResponse(
  clientProto: Proto,
  via: Proto,
  upstreamText: string,
  fallbackModel: string,
): { body: string; inTok: number; cacheTok: number; outTok: number; model: string; estimated: boolean } {
  const ir = decodeResponseToIR(via, upstreamText, fallbackModel);
  return {
    body: encodeResponseFromIR(clientProto, ir, fallbackModel),
    inTok: ir.inTok,
    cacheTok: ir.cacheTok,
    outTok: ir.outTok,
    model: ir.model,
    estimated: ir.usageEstimated,
  };
}

// ---------------------------------------------------------------------------
// errors: upstream body -> client envelope (via IR message extraction)
// ---------------------------------------------------------------------------

/** Extract a human message from an upstream error body of any protocol. */
export function errorMessageFromBody(via: Proto, bodyText: string): string {
  void via;
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
  return message;
}

/** Envelope an error message in the client's protocol. */
export function envelopeErrorIR(proto: Proto, status: number, message: string, type?: string): string {
  if (proto === "openai" || proto === "responses") {
    return JSON.stringify({
      error: { message, type: type ?? (status === 401 ? "authentication_error" : "invalid_request_error"), code: null },
    });
  }
  const aType =
    type ??
    (status === 401
      ? "authentication_error"
      : status === 429
        ? "rate_limit_error"
        : status >= 500
          ? "api_error"
          : "invalid_request_error");
  return JSON.stringify({ type: "error", error: { type: aType, message } });
}

/** Re-envelope an upstream error body (any protocol) to the client's protocol. */
export function reEnvelopeErrorIR(clientProto: Proto, via: Proto, _status: number, body: string): string {
  return envelopeErrorIR(clientProto, _status, errorMessageFromBody(via, body));
}

// ---------------------------------------------------------------------------
// streaming: generic IR stream translator (any upstream SSE -> any client SSE)
//
// Any new protocol plugs in ONE SSE event parser (upstream -> IR delta) and
// ONE SSE event writer (IR delta -> client) and instantly gets the full
// matrix in both directions. Parsers are line-oriented: each upstream chunk
// is split into lines and the protocol parser extracts text/tool/usage
// deltas; the writer emits the client protocol's event sequence.
// ---------------------------------------------------------------------------

export interface IRStreamDelta {
  text?: string;
  /** True for thinking text (reasoning_content): shown, not billed. */
  thinking?: boolean;
  toolUse?: { id: string; name: string; inputDelta: string; thoughtSignature?: string };
  usage?: { inTok: number; cacheTok: number; outTok: number; cacheCreation?: number; reasonTok?: number };
  finish?: "stop" | "length" | "tool_calls";
}

/** Parse one upstream SSE line (post-`data:`/event-stripped payload) into IR deltas. */
export type IRStreamParser = (data: string) => IRStreamDelta[];

/** Serialize IR deltas into client SSE frames. Stateful per stream. */
export interface IRStreamWriter {
  feed(deltas: IRStreamDelta[]): Uint8Array[];
  flush(): Uint8Array[];
}

const te = new TextEncoder();
const sseBytes = (payload: string): Uint8Array => te.encode(payload);

function chatStreamParser(data: string): IRStreamDelta[] {
  if (data === "[DONE]") return [{ finish: "stop" }];
  try {
    const j = JSON.parse(data) as any;
    const out: IRStreamDelta[] = [];
    const choice = j.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === "string" && delta.content) out.push({ text: delta.content });
    // DeepSeek-style reasoning models stream thinking in `reasoning_content`
    // (content arrives only after thinking completes): surface it as text so
    // stream clients see progress and nothing is silently dropped. Usage
    // accounting still excludes it (reasoning_tokens split at the terminal).
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      out.push({ text: delta.reasoning_content, thinking: true });
    }
    const tc = delta.tool_calls?.[0];
    if (tc) {
      const sig =
        typeof (tc.extra_content as any)?.google?.thought_signature === "string"
          ? (tc.extra_content as any).google.thought_signature
          : undefined;
      out.push({
        toolUse: {
          id: typeof tc.id === "string" ? tc.id : "",
          name: typeof tc.function?.name === "string" ? tc.function.name : "",
          inputDelta: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
          ...(sig ? { thoughtSignature: sig } : {}),
        },
      });
    }
    if (choice?.finish_reason === "tool_calls") out.push({ finish: "tool_calls" });
    else if (choice?.finish_reason === "length") out.push({ finish: "length" });
    else if (choice?.finish_reason) out.push({ finish: "stop" });
    // A bare finish frame (no usage yet — usage rides the NEXT chunk) is
    // only terminal when nothing follows. The translator tracks
    // pendingFinish and emits the terminal sequence on flush / next usage.
    // (The usage-only terminal chunk below still merges immediately.)
    const u = j.usage;
    // Usage-only terminal chunk (choices: [], usage: {...}): the canonical
    // OpenAI streaming usage frame. It carries no finish_reason, so merge
    // the usage INTO a finish delta — the writer emits exactly one terminal
    // chunk (finish + usage) + [DONE], legacy parity.
    if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
      const prompt = Number(u.prompt_tokens ?? 0) || 0;
      const cached = Number(u.prompt_tokens_details?.cached_tokens ?? 0) || 0;
      const completion = Number(u.completion_tokens ?? 0) || 0;
      const reasonTok = Math.max(0, Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0);
      const usage = {
        inTok: Math.max(0, prompt - cached),
        cacheTok: Math.max(0, cached),
        outTok: Math.max(0, completion - reasonTok),
        reasonTok,
      };
      // Lying-zero terminal chunk (all counters 0 while content flowed):
      // drop it so result() estimates from the wire. Nonzero figures
      // always flow through.
      const allZero = usage.inTok <= 0 && usage.cacheTok <= 0 && usage.outTok <= 0;
      if (allZero) return out;
      const hasFinish = out.some((d) => d.finish);
      if (!hasFinish && (!j.choices || j.choices.length === 0)) {
        out.push({ finish: "stop", usage });
      } else {
        out.push({ usage });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function anthropicStreamParser(event: string, data: string): IRStreamDelta[] {
  try {
    const j = JSON.parse(data) as any;
    if (event === "content_block_delta") {
      if (j.delta?.type === "text_delta" && typeof j.delta.text === "string") return [{ text: j.delta.text }];
      if (j.delta?.type === "input_json_delta" && typeof j.delta.partial_json === "string") {
        return [{ toolUse: { id: "", name: "", inputDelta: j.delta.partial_json } }];
      }
      return [];
    }
    if (event === "content_block_start") {
      const b = j.content_block ?? {};
      if (b.type === "tool_use") {
        return [{ toolUse: { id: String(b.id ?? ""), name: String(b.name ?? ""), inputDelta: "" } }];
      }
      return [];
    }
    if (event === "message_delta") {
      const out: IRStreamDelta[] = [];
      if (j.delta?.stop_reason === "tool_use") out.push({ finish: "tool_calls" });
      else if (j.delta?.stop_reason === "max_tokens") out.push({ finish: "length" });
      else if (j.delta?.stop_reason) out.push({ finish: "stop" });
      if (j.usage?.output_tokens !== undefined) {
        // output_tokens:0 with no other signal is the "lying zero" case
        // (usage block present but empty) — treat as absent so the
        // zero-output guard in result() estimates from the wire instead
        // of trusting the zero. A nonzero figure always flows through.
        const outTok = Number(j.usage.output_tokens ?? 0) || 0;
        const cache = Number(j.usage.cache_read_input_tokens ?? 0) || 0;
        if (outTok > 0 || cache > 0) {
          out.push({
            usage: { inTok: 0, cacheTok: cache, outTok },
          });
        }
      }
      return out;
    }
    if (event === "message_start") {
      const u = j.message?.usage ?? {};
      if (u.input_tokens !== undefined) {
        // Cache_creation is kept separate (not folded into cacheTok) so
        // the Anthropic writer can replay the native field split on
        // message_start; the translator still sums both into cacheTok.
        // All-zero input+cache (the lying-zero stream) is NOT trusted:
        // skip the delta so the zero-output guard in result() estimates
        // from the wire instead. Nonzero figures flow through untouched.
        const inTok = Number(u.input_tokens ?? 0) || 0;
        const cacheTok =
          (Number(u.cache_read_input_tokens ?? 0) || 0) + (Number(u.cache_creation_input_tokens ?? 0) || 0);
        if (inTok <= 0 && cacheTok <= 0) return [];
        return [
          {
            usage: {
              inTok,
              cacheTok,
              outTok: 0,
              cacheCreation: Number(u.cache_creation_input_tokens ?? 0) || 0,
            },
          },
        ];
      }
    }
    return [];
  } catch {
    return [];
  }
}

function responsesStreamParser(event: string, data: string): IRStreamDelta[] {
  try {
    const j = JSON.parse(data) as any;
    if (event === "response.output_text.delta" && typeof j.delta === "string") return [{ text: j.delta }];
    if ((event === "response.function_call_arguments.delta" || event === "response.function_call_arguments.done") && typeof (j.delta ?? j.arguments) === "string") {
      const s: string = j.delta ?? j.arguments;
      return [{ toolUse: { id: String(j.item_id ?? j.call_id ?? ""), name: String(j.name ?? ""), inputDelta: s } }];
    }
    if (event === "response.output_item.done" && j.item?.type === "function_call") {
      return [
        {
          toolUse: {
            id: String(j.item.call_id ?? j.item.id ?? ""),
            name: String(j.item.name ?? ""),
            inputDelta: typeof j.item.arguments === "string" ? j.item.arguments : "",
          },
        },
      ];
    }
    if (event === "response.completed") {
      const u = j.response?.usage;
      if (u) {
        const input = Number(u.input_tokens ?? 0) || 0;
        const cached = Number(u.input_tokens_details?.cached_tokens ?? 0) || 0;
        const output = Number(u.output_tokens ?? 0) || 0;
        const reasonTok = Math.max(0, Number(u.output_tokens_details?.reasoning_tokens ?? 0) || 0);
        return [
          { finish: "stop", usage: {
            inTok: Math.max(0, input - cached),
            cacheTok: Math.max(0, cached),
            outTok: Math.max(0, output - reasonTok),
            reasonTok,
          } },
        ];
      }
      return [{ finish: "stop" }];
    }
    if (event === "response.incomplete" || event === "response.failed") return [{ finish: "length" }];
    return [];
  } catch {
    return [];
  }
}

class ChatStreamWriter implements IRStreamWriter {
  private lastUsage: { inTok: number; cacheTok: number; outTok: number } | null = null;
  private sentRole = false;
  private headerSent = false;
  private id = `chatcmpl-${Date.now().toString(36)}`;
  constructor(private model: string) {}
  feed(deltas: IRStreamDelta[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    // First-byte liveness: emit the role chunk on the first upstream chunk
    // even when it carries no IR deltas (reasoning-only prefixes).
    if (!this.headerSent && deltas.length === 0) {
      this.headerSent = true;
      this.sentRole = true;
      out.push(sseBytes(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`));
    }
    for (const d of deltas) {
      if (d.finish) {
        const fr = d.finish === "tool_calls" ? "tool_calls" : d.finish === "length" ? "length" : "stop";
        // Usage may ride on the finish delta itself (Responses combined
        // frame) or on a preceding usage-only delta (chat terminal chunk):
        // either way the terminal chunk carries it (legacy finish() parity).
        const u = d.usage ?? this.lastUsage;
        this.lastUsage = null;
        if (u) {
          out.push(sseBytes(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: fr }], usage: { prompt_tokens: u.inTok + u.cacheTok, completion_tokens: u.outTok, prompt_tokens_details: { cached_tokens: u.cacheTok } } })}\n\n`));
        } else {
          out.push(sseBytes(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: {}, finish_reason: fr }] })}\n\n`));
        }
        out.push(sseBytes("data: [DONE]\n\n"));
        continue;
      }
      if (d.text) {
        if (!this.sentRole) {
          this.sentRole = true;
          out.push(sseBytes(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`));
        }
        out.push(sseBytes(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: { content: d.text } }] })}\n\n`));
      }
      if (d.toolUse && (d.toolUse.id || d.toolUse.name || d.toolUse.inputDelta)) {
        if (!this.sentRole) {
          this.sentRole = true;
          out.push(sseBytes(`data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`));
        }
        out.push(
          sseBytes(
            `data: ${JSON.stringify({ id: this.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: this.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: d.toolUse.id || undefined, type: "function", function: { name: d.toolUse.name || undefined, arguments: d.toolUse.inputDelta } }] } }] })}\n\n`,
          ),
        );
      }
      if (d.usage && !d.finish) {
        const u = d.usage;
        this.lastUsage = {
          inTok: Math.max(this.lastUsage?.inTok ?? 0, u.inTok),
          cacheTok: Math.max(this.lastUsage?.cacheTok ?? 0, u.cacheTok),
          outTok: Math.max(this.lastUsage?.outTok ?? 0, u.outTok),
        };
      }
    }
    return out;
  }
  flush(): Uint8Array[] {
    // Chat SSE always terminates with the usage-bearing finish chunk
    // (whenever upstream gave usage) + `data: [DONE]` — legacy parity
    // (ResponsesToChatStream.finish): a translated stream never ends on a
    // bare usage chunk.
    const out: Uint8Array[] = [];
    if (this.lastUsage) {
      out.push(sseBytes(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: this.lastUsage.inTok + this.lastUsage.cacheTok, completion_tokens: this.lastUsage.outTok, prompt_tokens_details: { cached_tokens: this.lastUsage.cacheTok } } })}\n\n`));
      this.lastUsage = null;
    }
    out.push(sseBytes("data: [DONE]\n\n"));
    return out;
  }
}

class AnthropicStreamWriter implements IRStreamWriter {
  private msgId = `msg_${Date.now().toString(36)}`;
  private headerSent = false;
  private headerQueue: Uint8Array[] = [];
  private textIndex = -1;
  private toolIndex = -1;
  private nextIndex = 0;
  private usage = { inTok: 0, cacheTok: 0, outTok: 0 };
  /** Input usage seen before the header went out (Anthropic message_start
   *  arrives as the first upstream event — it must ride message_start). */
  private pendingInputUsage: { inTok: number; cacheTok: number; cacheCreation: number } | null = null;
  constructor(private model: string) {}
  feed(deltas: IRStreamDelta[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    const ev = (event: string, o: unknown) => sseBytes(`event: ${event}\ndata: ${JSON.stringify(o)}\n\n`);
    const emitHeader = () => {
      // Usage known at header time (e.g. Anthropic message_start input +
      // cache counters) rides the message_start usage — native shape parity.
      const pending = this.pendingInputUsage;
      this.pendingInputUsage = null;
      out.push(ev("message_start", { type: "message_start", message: { id: this.msgId, type: "message", role: "assistant", content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: pending ? { input_tokens: pending.inTok, output_tokens: 0, cache_read_input_tokens: pending.cacheTok || undefined, cache_creation_input_tokens: pending.cacheCreation || undefined } : { input_tokens: 0, output_tokens: 0 } } }));
      out.push(ev("ping", { type: "ping" }));
    };
    // Stash input usage BEFORE the header decision so message_start itself
    // (which arrives as a usage delta) rides the header natively.
    for (const d of deltas) {
      if (d.usage && (d.usage.inTok > 0 || d.usage.cacheTok > 0)) {
        this.pendingInputUsage = {
          inTok: Math.max(this.pendingInputUsage?.inTok ?? 0, d.usage.inTok),
          cacheTok: Math.max(this.pendingInputUsage?.cacheTok ?? 0, d.usage.cacheTok - (d.usage.cacheCreation ?? 0)),
          cacheCreation: Math.max(this.pendingInputUsage?.cacheCreation ?? 0, d.usage.cacheCreation ?? 0),
        };
      }
    }
    // Emit message_start + ping on the FIRST upstream chunk even when it
    // carries no IR deltas (reasoning-only prefixes): clients/proxies treat
    // the first byte as stream liveness (header timeouts, TTFB budgets).
    if (!this.headerSent) {
      this.headerSent = true;
      emitHeader();
    }
    for (const d of deltas) {
      if (d.text) {
        if (this.textIndex === -1) {
          this.textIndex = this.nextIndex++;
          out.push(ev("content_block_start", { type: "content_block_start", index: this.textIndex, content_block: { type: "text", text: "" } }));
        }
        out.push(ev("content_block_delta", { type: "content_block_delta", index: this.textIndex, delta: { type: "text_delta", text: d.text } }));
      }
      if (d.toolUse && (d.toolUse.id || d.toolUse.name)) {
        this.toolIndex = this.nextIndex++;
        // Google thought_signature rides a redacted_thinking block AHEAD of
        // the tool_use block (native Anthropic shape for Gemini upstreams).
        if (d.toolUse.thoughtSignature) {
          const sigIndex = this.nextIndex++;
          out.push(ev("content_block_start", { type: "content_block_start", index: sigIndex, content_block: { type: "redacted_thinking", data: d.toolUse.thoughtSignature } }));
          out.push(ev("content_block_stop", { type: "content_block_stop", index: sigIndex }));
        }
        out.push(ev("content_block_start", { type: "content_block_start", index: this.toolIndex, content_block: { type: "tool_use", id: d.toolUse.id, name: d.toolUse.name, input: {} } }));
      } else if (d.toolUse && d.toolUse.inputDelta) {
        if (this.toolIndex === -1) {
          this.toolIndex = this.nextIndex++;
          out.push(ev("content_block_start", { type: "content_block_start", index: this.toolIndex, content_block: { type: "tool_use", id: "", name: "", input: {} } }));
        }
        out.push(ev("content_block_delta", { type: "content_block_delta", index: this.toolIndex, delta: { type: "input_json_delta", partial_json: d.toolUse.inputDelta } }));
      }
      if (d.usage) {
        this.usage = { inTok: Math.max(this.usage.inTok, d.usage.inTok), cacheTok: Math.max(this.usage.cacheTok, d.usage.cacheTok), outTok: Math.max(this.usage.outTok, d.usage.outTok) };
      }
      if (d.finish) {
        if (this.textIndex !== -1) out.push(ev("content_block_stop", { type: "content_block_stop", index: this.textIndex }));
        if (this.toolIndex !== -1) out.push(ev("content_block_stop", { type: "content_block_stop", index: this.toolIndex }));
        // A stream that emitted tool_use blocks ends with stop_reason tool_use
        // even when the upstream finish frame says plain "stop" (Google style:
        // tool_calls and finish_reason travel in separate chunks).
        const stopReason = d.finish === "tool_calls" || (d.finish === "stop" && this.toolIndex !== -1) ? "tool_use" : d.finish === "length" ? "max_tokens" : "end_turn";
        out.push(ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: this.usage.outTok || undefined } }));
        out.push(ev("message_stop", { type: "message_stop" }));
      }
    }
    return out;
  }
  flush(): Uint8Array[] {
    return [];
  }
  getUsage(): { inTok: number; cacheTok: number; outTok: number } {
    return this.usage;
  }
  setInputUsage(inTok: number, cacheTok: number): void {
    this.usage.inTok = Math.max(this.usage.inTok, inTok);
    this.usage.cacheTok = Math.max(this.usage.cacheTok, cacheTok);
  }
}

class ResponsesStreamWriter implements IRStreamWriter {
  private respId = `resp_${Date.now().toString(36)}`;
  private created = false;
  private msgAdded = false;
  private seq = 0;
  private model: string;
  private accText = "";
  private fnName = "";
  private fnCallId = "";
  private fnArgs = "";
  private fnAnnounced = false;
  private usage = { inTok: 0, cacheTok: 0, outTok: 0 };
  private reasonTok = 0;
  constructor(model: string) {
    this.model = model;
  }
  private createdEvent(): Uint8Array {
    const full = { id: this.respId, object: "response", created_at: Date.now() / 1000, model: this.model, status: "in_progress", output: [], usage: null };
    return sseBytes(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: this.seq++, response: full })}\n\n`);
  }
  feed(deltas: IRStreamDelta[]): Uint8Array[] {
    const out: Uint8Array[] = [];
    // First-byte liveness: response.created on the first upstream chunk
    // even when it carries no IR deltas (reasoning-only prefixes).
    if (!this.created && deltas.length === 0) {
      this.created = true;
      out.push(this.createdEvent());
    }
    for (const d of deltas) {
      if (!this.created) {
        this.created = true;
        out.push(this.createdEvent());
      }
      if (d.text) {
        if (!this.msgAdded) {
          this.msgAdded = true;
          out.push(sseBytes(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: this.seq++, output_index: 0, item: { type: "message", id: "msg_0", role: "assistant", status: "in_progress", content: [] } })}\n\n`));
          out.push(sseBytes(`event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", sequence_number: this.seq++, item_id: "msg_0", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })}\n\n`));
        }
        this.accText += d.text;
        out.push(sseBytes(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: this.seq++, item_id: "msg_0", output_index: 0, content_index: 0, delta: d.text })}\n\n`));
      }
      if (d.toolUse && (d.toolUse.id || d.toolUse.name || d.toolUse.inputDelta)) {
        if (d.toolUse.id) this.fnCallId = d.toolUse.id;
        if (d.toolUse.name) this.fnName = d.toolUse.name;
        if (d.toolUse.inputDelta) this.fnArgs += d.toolUse.inputDelta;
        if (!this.fnAnnounced && (this.fnName || this.fnCallId)) {
          this.fnAnnounced = true;
          out.push(sseBytes(`event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", sequence_number: this.seq++, output_index: 1, item: { type: "function_call", id: this.fnCallId, call_id: this.fnCallId, name: this.fnName, arguments: "", status: "in_progress" } })}\n\n`));
        } else if (d.toolUse.inputDelta) {
          out.push(sseBytes(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", sequence_number: this.seq++, item_id: this.fnCallId, output_index: 1, delta: d.toolUse.inputDelta })}\n\n`));
        }
      }
      if (d.usage) {
        this.usage = { inTok: Math.max(this.usage.inTok, d.usage.inTok), cacheTok: Math.max(this.usage.cacheTok, d.usage.cacheTok), outTok: Math.max(this.usage.outTok, d.usage.outTok) };
        this.reasonTok = Math.max(this.reasonTok, d.usage.reasonTok ?? 0);
      }
      if (d.finish) {
        const full = {
          id: this.respId,
          object: "response",
          created_at: Date.now() / 1000,
          model: this.model,
          status: "completed",
          output: [
            ...(this.accText ? [{ type: "message", id: "msg_0", role: "assistant", status: "completed", content: [{ type: "output_text", text: this.accText, annotations: [] }] }] : []),
            ...(this.fnAnnounced ? [{ type: "function_call", id: this.fnCallId, call_id: this.fnCallId, name: this.fnName, arguments: this.fnArgs, status: "completed" }] : []),
          ],
          usage: { input_tokens: this.usage.inTok + this.usage.cacheTok, input_tokens_details: { cached_tokens: this.usage.cacheTok }, output_tokens: this.usage.outTok, output_tokens_details: { reasoning_tokens: this.reasonTok }, total_tokens: this.usage.inTok + this.usage.cacheTok + this.usage.outTok },
        };
        out.push(sseBytes(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", sequence_number: this.seq++, response: full })}\n\n`));
      }
    }
    return out;
  }
  flush(): Uint8Array[] {
    return [];
  }
  getUsage(): { inTok: number; cacheTok: number; outTok: number } {
    return this.usage;
  }
}

/**
 * Generic any-to-any SSE translator: feed raw upstream bytes, get client
 * protocol bytes. Protocol N+1 plugs in one parser + one writer above.
 * Usage accumulates from IR usage deltas (with the same estimation rules
 * as the buffered path when upstream omits usage).
 */
export class IRStreamTranslator {
  private pending = "";
  private decoder = new TextDecoder();
  private done = false;
  private sawFinish = false;
  /** A bare finish frame arrived but usage may still ride the NEXT chunk
   *  (canonical OpenAI pattern: finish chunk THEN usage-only chunk THEN
   *  [DONE]). While pending, the terminal sequence is held back. */
  private pendingFinish: "stop" | "length" | "tool_calls" | null = null;
  private currentEvent = "";
  private writer: IRStreamWriter;
  private parser: (event: string, data: string) => IRStreamDelta[];
  inTok = 0;
  cacheTok = 0;
  outTok = 0;
  reasonTok = 0;
  /** Streamed thinking chars (reasoning_content deltas): visible to the
   *  client for progress, but NEVER billable output (same rule as the
   *  buffered reasoning_tokens split). */
  private thinkingChars = 0;
  private sawUsage = false;
  private model = "";
  private outChars = 0;
  /** Capped verbatim sample of streamed text/tool-arg JSON. 500KB covers
   *  any realistic model output (~125k tokens) with exact counting; only
   *  beyond that does the estimator fall back to per-char extrapolation.
   *  Kept as chunk arrays (not += string concat) so accumulation is O(n):
   *  blocks are pushed per delta and joined ONCE at estimate time; past
   *  the cap only the char length is counted, never stored. */
  private outChunks: string[] = [];
  private outSampleLen = 0;
  private toolJsonChars = 0;
  /** Bounded chunks of the streamed tool-arg JSON (extrapolation sample). */
  private toolArgsChunks: string[] = [];
  private toolArgsLen = 0;
  /** Opaque thinking payloads (thought_signature / encrypted blobs): billed
   *  output the upstream never itemizes — estimated via btdby4. */
  private opaqueThinking: string[] = [];

  constructor(
    private upstream: Proto,
    client: Proto,
    private fallbackModel: string,
  ) {
    this.writer =
      client === "anthropic"
        ? new AnthropicStreamWriter(fallbackModel)
        : client === "responses"
          ? new ResponsesStreamWriter(fallbackModel)
          : new ChatStreamWriter(fallbackModel);
    this.parser =
      upstream === "anthropic"
        ? anthropicStreamParser
        : upstream === "responses"
          ? responsesStreamParser
          : (_ev, data) => chatStreamParser(data);
  }

  get isDone(): boolean {
    return this.done;
  }

  feed(chunk: Uint8Array): Uint8Array[] {
    if (this.done) return [];
    this.pending += this.decoder.decode(chunk, { stream: true });
    const out: Uint8Array[] = [];
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        this.currentEvent = "";
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        this.currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (this.upstream === "openai" && data === "[DONE]") {
        // [DONE] after a held bare finish: emit the terminal sequence now
        // (usage arrived or not — flush the pending finish first).
        if (this.pendingFinish !== null) {
          const pf = this.pendingFinish;
          this.pendingFinish = null;
          for (const b of this.writer.feed([{ finish: pf }])) out.push(b);
        } else {
          for (const b of this.writer.feed([{ finish: "stop" }])) out.push(b);
        }
        // Chat-client writers terminate with [DONE] on the finish delta
        // itself (legacy finish() parity); other writers terminate on
        // flush() below. Either way the upstream terminator ends the stream.
        for (const b of this.writer.flush()) out.push(b);
        this.done = true;
        this.sawFinish = true;
        break;
      }
      let deltas: IRStreamDelta[];
      try {
        deltas = this.parser(this.currentEvent, data);
      } catch {
        deltas = [];
      }
      // Finish frames may carry tool_use deltas in the SAME chunk (Google
      // style: tool_calls + finish_reason:stop together). The pending
      // finish must not swallow them: only a BARE finish (finish alone,
      // no text/tool/usage) is held for a trailing usage chunk.
      // Usage-carrying finish frames and non-chat protocols pass through.
      const bareFinish = deltas.length === 1 && deltas[0].finish && !deltas[0].usage && !deltas[0].text && !deltas[0].toolUse;
      if (bareFinish && this.upstream === "openai" && this.pendingFinish === null) {
        this.pendingFinish = deltas[0].finish!;
        // Still feed the writer for first-byte/liveness side effects? No:
        // the writer would emit the terminal chunk now, before usage. Just
        // hold it — text already flowed, TTFB is satisfied.
        continue;
      }
      if (this.pendingFinish !== null) {
        const pf = this.pendingFinish;
        this.pendingFinish = null;
        // Usage arrived after the bare finish: merge into one terminal delta
        // so the writer emits a single finish+usage chunk (legacy parity).
        const ui = deltas.findIndex((d) => d.usage && !d.finish);
        if (ui !== -1) {
          deltas[ui] = { ...deltas[ui], finish: pf };
        } else if (!deltas.some((d) => d.finish)) {
          deltas.push({ finish: pf });
        }
      }
      if (!deltas.length) continue;
      for (const d of deltas) {
        if (d.text) {
          // Thinking text feeds the estimate sample ONLY when no visible
          // text exists yet (pure-reasoning streams still estimate
          // something); visible text always wins for the sample.
          if (d.thinking) {
            this.thinkingChars += d.text.length;
            if (this.outChars === 0 && this.outSampleLen < OUT_SAMPLE_CAP) {
              const room = OUT_SAMPLE_CAP - this.outSampleLen;
              this.outChunks.push(d.text.slice(0, room));
              this.outSampleLen += Math.min(d.text.length, room);
            }
          } else {
            if (this.thinkingChars > 0 && this.outChars === 0) {
              this.outChunks = [];
              this.outSampleLen = 0;
            }
            this.outChars += d.text.length;
            if (this.outSampleLen < OUT_SAMPLE_CAP) {
              const room = OUT_SAMPLE_CAP - this.outSampleLen;
              this.outChunks.push(d.text.slice(0, room));
              this.outSampleLen += Math.min(d.text.length, room);
            }
          }
        }
        if (d.toolUse?.inputDelta) {
          this.toolJsonChars += d.toolUse.inputDelta.length;
          if (this.toolArgsLen < OUT_SAMPLE_CAP) {
            const room = OUT_SAMPLE_CAP - this.toolArgsLen;
            this.toolArgsChunks.push(d.toolUse.inputDelta.slice(0, room));
            this.toolArgsLen += Math.min(d.toolUse.inputDelta.length, room);
          }
        }
        if (d.toolUse?.thoughtSignature) this.opaqueThinking.push(d.toolUse.thoughtSignature);
        // Text/tool bytes on the wire count as output activity even when the
        // upstream zeroed (or dropped) every usage figure — the zero-output
        // guard in result() needs to know content flowed. sawUsage marks
        // the translator ACTIVE (not: the upstream reported honest usage).
        if (d.text || d.toolUse?.inputDelta) this.sawUsage = true;
        if (d.usage) {
          this.sawUsage = true;
          this.inTok = Math.max(this.inTok, d.usage.inTok);
          this.cacheTok = Math.max(this.cacheTok, d.usage.cacheTok);
          this.outTok = Math.max(this.outTok, d.usage.outTok);
          this.reasonTok = Math.max(this.reasonTok, d.usage.reasonTok ?? 0);
          const w = this.writer as unknown as { setInputUsage?: (a: number, b: number) => void };
          if (d.usage.inTok > 0 || d.usage.cacheTok > 0) w.setInputUsage?.(d.usage.inTok, d.usage.cacheTok);
          void this.toolJsonChars;
        }
      }
      // Same-proto streams: upstream usage events pass through the IR
      // counters above, and the writer re-emits them in canonical form.
      // Empty-delta feeds still reach the writer: it emits first-byte
      // liveness frames (role/message_start/response.created) so TTFB
      // timeouts never fire on reasoning-only prefixes.
      for (const b of this.writer.feed(deltas)) out.push(b);
      if (deltas.some((d) => d.finish)) {
        this.sawFinish = true;
        this.done = true;
      }
      if (this.done) break;
    }
    return out;
  }

  flush(): Uint8Array[] {
    if (this.done) return [];
    this.done = true;
    const out: Uint8Array[] = [];
    if (this.pendingFinish !== null) {
      const pf = this.pendingFinish;
      this.pendingFinish = null;
      for (const b of this.writer.feed([{ finish: pf }])) out.push(b);
      this.sawFinish = true;
    }
    if (!this.sawFinish) {
      // Upstream closed the SSE stream without a terminal frame (stub
      // upstreams, cut connections): synthesize finish so the writer emits
      // the same terminal sequence as on a clean finish (legacy parity).
      for (const b of this.writer.feed([{ finish: "stop" }])) out.push(b);
    }
    for (const b of this.writer.flush()) out.push(b);
    return out;
  }

  setModel(m: string): void {
    if (m && !this.model) this.model = m;
  }

  result(): { inTok: number; cacheTok: number; outTok: number; model: string; estimated: boolean } {
    // sawUsage now ALSO means "bytes crossed the wire" (text/tool deltas
    // mark it — see feed()). The second branch below therefore covers the
    // lying-zero stream: upstream usage said 0/0/0 but content flowed.
    if (this.sawUsage && (this.inTok > 0 || this.outTok > 0 || this.cacheTok > 0 || this.outChars > 0 || this.toolJsonChars > 0)) {
      // Zero-output guard: the upstream said 0 (or omitted) output, but
      // text/tool bytes crossed the wire — observed live (400k-context
      // turn billed out:17403 with in/cache zeroed). Trusting that zero
      // would erase the turn; estimate from the streamed sample instead
      // (btdby4, conservative) and keep the event flagged estimated.
      // Nonzero upstream figures are NEVER overridden.
      let outTok = this.outTok;
      let estimated = false;
      if (outTok <= 0 && (this.outChars > 0 || this.toolJsonChars > 0)) {
        outTok = this.estimateOutTok();
        estimated = true;
      }
      return { inTok: this.inTok, cacheTok: this.cacheTok, outTok, model: this.model, estimated };
    }
    // Anthropic reports input usage at message_start; tool-only streams may
    // carry no text — still bill the reported counters, not an estimate.
    if (this.sawUsage) {
      return { inTok: this.inTok, cacheTok: this.cacheTok, outTok: this.outTok, model: this.model, estimated: false };
    }
    return {
      inTok: 0,
      cacheTok: 0,
      outTok: this.outChars > 0 && this.outSampleLen > 0 ? this.estimateOutTok() : 0,
      model: this.model,
      estimated: true,
    };
  }

  private estimateOutTok(): number {
    // Full output estimate (btdby4 engine throughout — the project's own
    // estimator, shared with the daemon):
    //   text / tool args: exact BPE count while the stream fits in the
    //     500KB sample cap (~125k tokens — beyond any realistic model
    //     output); only the excess past the cap extrapolates by per-char
    //     ratio (rule of three over the remainder);
    //   opaque thinking (thought_signature / encrypted blobs): the wasm's
    //     payload estimator — billed output the upstream never itemizes.
    // Pure tool-call turns carry no text: their JSON args still cost output
    // tokens, so they estimate from the arg bytes instead of defaulting.
    let total = 0;
    if (this.outSampleLen > 0) {
      // Single join of the capped blocks, counted once by the BPE engine;
      // the tail past the cap (length-only) scales by the sample density.
      const sample = this.outChunks.join("");
      const sampleTokens = countTextTokens(sample);
      total += sampleTokens;
      if (this.outChars > sample.length) {
        // Remainder past the cap: scale by the sample's own density.
        total += Math.round(
          (sampleTokens * (this.outChars - sample.length)) / sample.length,
        );
      }
    }
    if (this.toolJsonChars > 0) {
      const slice = this.toolArgsLen > 0 ? this.toolArgsChunks.join("") : "{}";
      const sliceTokens = countTextTokens(slice);
      total += Math.max(1, sliceTokens);
      if (this.toolJsonChars > slice.length) {
        total += Math.round(
          (sliceTokens * (this.toolJsonChars - slice.length)) / slice.length,
        );
      }
    }
    for (const blob of this.opaqueThinking) total += estimateThinkingTokens(blob);
    return Math.max(1, total);
  }
}
