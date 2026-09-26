/**
 * Markup tool-call adaptation.
 *
 * Some upstreams serve models whose native function calling is unreliable
 * through OpenAI-compatible stacks: calls come back as MARKUP in assistant
 * content (or are dropped), and multi-turn tool conversations may be
 * rejected unless the assistant's reasoning is replayed. The gateway can
 * recover that markup at the response edge — the same three-edge wiring
 * (stream / translated buffered / same-protocol raw) as the DSML recoverer,
 * behind the shared ToolRecoverer contract (recovery.ts).
 *
 * The strategy is chosen per model (tool_call_mode, see tool-call-mode.ts):
 *
 *   - `fallback` (default) — PASSIVE: native `tools` are forwarded, but
 *     markup found in the response is recovered from every supported dialect
 *     (xiaomi XML, MiniMax `<invoke>`, Hermes/Qwen JSON);
 *   - `workaround` — ACTIVE: native `tools` are stripped and the schema is
 *     re-delivered as an in-band instruction teaching the supported formats.
 *
 * Native `tool_calls` are ALWAYS accepted as a fallback: the workaround
 * instruction states native calling is disabled (to discourage it), but a
 * model that emits native calls anyway is never broken — recovery only ADDS
 * calls found in content, it never removes native ones.
 *
 * Recovery is conservative: a candidate must CLOSE, the function name must
 * match a declared tool, unmatched blocks restore byte-verbatim. Active only
 * when the request declared tools (tool_choice ≠ none).
 */

import {
  canonicalKey,
  findHint,
  patchRawResponseDsml,
  sanitizeArgs,
  type DsmlExtractResult,
  type DsmlRecoveredCall,
  type DsmlToolHint,
} from "./dsml";
import type {
  RecoverProto,
  StreamEmit,
  StreamRecoverer,
  ToolRecoverer,
} from "./recovery";
import type { ToolCallMode } from "../tool-call-mode";

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Detection by model id: any id containing "xiaomi" gets the workaround by
 *  default (mirrors defaultToolCallModeFor, kept for direct callers). */
export function isXiaomiModel(model: unknown): boolean {
  return typeof model === "string" && /xiaomi/i.test(model);
}
// ---------------------------------------------------------------------------
// markup dialects
// ---------------------------------------------------------------------------

/** The markup dialects `smart` mode understands. */
export type MarkupDialect = "xiaomi" | "minimax" | "hermes";

/**
 * One scanner over every structural tag, so nesting can be tracked by DEPTH:
 * a tag appearing inside a parameter VALUE is literal text (a model writing
 * a file whose content happens to contain the markup), never a separate call
 * and never a premature terminator.
 *
 * Group map (checked with `m[k] !== undefined`):
 *   1 block close · 2 block open · 3 function close
 *   4 function open (5 name) · 6 invoke open (7 name)
 *   8 parameter close · 9 parameter open (10 name) · 11 parameter name= (12)
 */
const TAG_RE = new RegExp(
  [
    String.raw`(<\s*\/\s*(?:minimax\s*:\s*)?tool[_-]?calls?\s*>)`,
    String.raw`(<\s*(?:minimax\s*:\s*)?tool[_-]?calls?\s*>)`,
    String.raw`(<\s*\/\s*(?:function|invoke)\s*>)`,
    String.raw`(<\s*function\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*>)`,
    String.raw`(<\s*invoke\s+name\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*>)`,
    String.raw`(<\s*\/\s*parameter\s*>)`,
    String.raw`(<\s*parameter\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*[^>]*>)`,
    String.raw`(<\s*parameter\s+name\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*[^>]*>)`,
  ].join("|"),
  "gi",
);

/** Any markup wrapper open (`<tool_call>` or `<minimax:tool_call>`). */
const MARKER = /<\s*(?:minimax\s*:\s*)?tool[_-]?calls?\s*>/i;

let callSeq = 0;
function newCallId(): string {
  callSeq = (callSeq + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${callSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** JSON when the raw text parses, otherwise the raw string (so
 *  `<parameter=cmd>ls -la</parameter>` stays a string). */
function parseValue(raw: string): unknown {
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface MarkupBlock {
  start: number;
  end: number;
  name: string | null;
  /** Which tag supplied the name: `function=` (xiaomi) or `invoke name=`
   *  (minimax). Gates dialect acceptance. */
  nameKind: "function" | "invoke" | null;
  params: Array<{ key: string; value: string }>;
  /** Raw inner text, for the JSON (hermes) dialect. */
  inner: string;
}

/**
 * Single depth-aware scan of every structural tag. A wrapper/function/
 * parameter tag appearing INSIDE a parameter value is literal data — it
 * neither opens a nested call nor terminates the enclosing one. A spurious
 * call/function nested inside the outermost block (outside any value) is
 * ignored entirely, so its params never join the outer call.
 *
 * Returns only COMPLETE blocks (a block whose close was seen); an unclosed
 * block is never returned, so it restores verbatim.
 */
function scanBlocks(text: string): MarkupBlock[] {
  const re = new RegExp(TAG_RE.source, "gi");
  const out: MarkupBlock[] = [];
  let blockDepth = 0;
  let blockStart = -1;
  let innerStart = -1;
  let name: string | null = null;
  let nameKind: "function" | "invoke" | null = null;
  let params: Array<{ key: string; value: string }> = [];
  let paramDepth = 0;
  let paramKey: string | null = null;
  let paramValStart = 0;
  let skipDepth = 0;

  const commitParam = (endIdx: number) => {
    if (paramKey) params.push({ key: paramKey, value: text.slice(paramValStart, endIdx) });
    paramKey = null;
    paramDepth = 0;
  };

  for (let m = re.exec(text); m; m = re.exec(text)) {
    const inParam = paramDepth > 0;
    if (m[1] !== undefined) {
      if (inParam) continue;
      if (skipDepth > 0) skipDepth--;
      else if (blockDepth === 1) {
        out.push({ start: blockStart, end: m.index + m[0].length, name, nameKind, params, inner: text.slice(innerStart, m.index) });
        blockDepth = 0;
        name = null;
        nameKind = null;
        params = [];
      }
      continue;
    }
    if (m[2] !== undefined) {
      if (inParam) continue;
      if (blockDepth === 0) {
        blockStart = m.index;
        innerStart = m.index + m[0].length;
        blockDepth = 1;
        name = null;
        nameKind = null;
        params = [];
      } else skipDepth++;
      continue;
    }
    if (m[3] !== undefined) {
      if (!inParam && skipDepth > 0) skipDepth--;
      continue;
    }
    if (m[4] !== undefined || m[6] !== undefined) {
      // <function=NAME> (xiaomi) or <invoke name="NAME"> (minimax)
      if (inParam) continue;
      if (skipDepth > 0) skipDepth++;
      else if (blockDepth === 1 && name === null) {
        name = (m[5] ?? m[7] ?? "").trim();
        nameKind = m[4] !== undefined ? "function" : "invoke";
      } else if (blockDepth === 1) skipDepth++;
      continue;
    }
    if (m[8] !== undefined) {
      if (paramDepth > 1) paramDepth--;
      else if (paramDepth === 1) commitParam(m.index);
      continue;
    }
    if (m[9] !== undefined || m[11] !== undefined) {
      if (inParam) {
        paramDepth++;
        continue;
      }
      if (skipDepth > 0 || blockDepth === 0) continue;
      paramDepth = 1;
      paramKey = (m[10] ?? m[12] ?? "").trim();
      paramValStart = m.index + m[0].length;
      continue;
    }
  }
  return out;
}

/** Parse the JSON (hermes) dialect: `<tool_call>{"name":…,"arguments":…}`. */
function parseHermesInner(inner: string): { name: string; input: Record<string, unknown> } | null {
  const s = inner.trim();
  if (!s.startsWith("{")) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  const rec = asRecord(obj);
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return null;
  const args = rec.arguments ?? rec.parameters ?? rec.input;
  let input: Record<string, unknown>;
  if (typeof args === "string") {
    try {
      input = asRecord(JSON.parse(args));
    } catch {
      input = {};
    }
  } else {
    input = asRecord(args);
  }
  return { name, input };
}

function dialectsFor(mode: ToolCallMode): MarkupDialect[] {
  // Both markup modes accept every dialect; only the INSTRUCTION differs
  // (workaround teaches the formats, fallback just listens).
  void mode;
  return ["xiaomi", "minimax", "hermes"];
}

/**
 * Recover markup tool calls from assistant content. Matched blocks are
 * removed (markup stripped) and become calls; a block whose function name is
 * not a declared tool (or that parses to no call at all) is restored
 * byte-verbatim. Only the OUTERMOST block commits, and a tag nested inside a
 * parameter VALUE stays literal text.
 */
export function extractMarkupToolCalls(
  text: string,
  hints: DsmlToolHint[],
  mode: ToolCallMode,
): DsmlExtractResult {
  if (!hints.length || mode === "native" || !MARKER.test(text)) return { text, calls: [], changed: false };
  const dialects = dialectsFor(mode);
  const calls: DsmlRecoveredCall[] = [];
  const segments: string[] = [];
  let pos = 0;
  let changed = false;
  for (const block of scanBlocks(text)) {
    // Resolve the call: a named function (xiaomi/minimax) or a JSON body
    // (hermes).
    let name = block.name;
    let input: Record<string, unknown> | null = null;
    if (name === null && dialects.includes("hermes")) {
      const h = parseHermesInner(block.inner);
      if (h) {
        name = h.name;
        input = h.input;
      }
    }
    const hint = name !== null ? findHint(hints, name) : undefined;
    if (!hint) continue; // restore verbatim (stays in the kept text)
    if (input === null) {
      input = {};
      for (const p of block.params) {
        const key = p.key.trim();
        if (!key) continue;
        input[canonicalKey(hint, key)] = parseValue(p.value.trim());
      }
    }
    segments.push(text.slice(pos, block.start));
    calls.push({ id: newCallId(), name: hint.name, input: sanitizeArgs(input, hint) });
    changed = true;
    pos = block.end;
  }
  if (!changed) return { text, calls: [], changed: false };
  segments.push(text.slice(pos));
  const out = segments.join("").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, calls, changed: true };
}

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

/** Hard cap on the held marker tail (bounded memory). */
const MAX_HOLD = 512 * 1024;

const OPEN_TAGS = ["tool_call", "tool-call", "tool_calls", "tool-calls", "toolcall", "toolcalls", "minimax:tool_call", "minimax:tool-call"];

/** Longest suffix that could still grow into a wrapper open tag. */
function partialOpenLen(s: string): number {
  const max = Math.min(s.length, 20);
  for (let k = max; k >= 1; k--) {
    const cand = s.slice(s.length - k);
    if (cand[0] !== "<") continue;
    const body = cand.slice(1).replace(/\s+/g, "").toLowerCase();
    if (OPEN_TAGS.some((t) => t.startsWith(body))) return k;
  }
  return 0;
}

/** End offset of the matching close of the FIRST open block, param-aware so
 *  a wrapper tag inside a parameter value is literal, and skip-aware so a
 *  nested call does not close the outer block early. */
function findCloseCut(s: string): number {
  const re = new RegExp(TAG_RE.source, "gi");
  let blockDepth = 0;
  let skipDepth = 0;
  let paramDepth = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const inParam = paramDepth > 0;
    if (m[1] !== undefined) {
      if (inParam) continue;
      if (skipDepth > 0) skipDepth--;
      else if (blockDepth === 1) return m.index + m[0].length;
    } else if (m[2] !== undefined) {
      if (inParam) continue;
      if (blockDepth === 0) blockDepth = 1;
      else skipDepth++;
    } else if (m[3] !== undefined) {
      if (!inParam && skipDepth > 0) skipDepth--;
    } else if (m[4] !== undefined || m[6] !== undefined) {
      if (!inParam && blockDepth === 1) skipDepth++;
    } else if (m[8] !== undefined) {
      if (paramDepth > 0) paramDepth--;
    } else if (m[9] !== undefined || m[11] !== undefined) {
      if (inParam) paramDepth++;
      else if (skipDepth === 0 && blockDepth === 1) paramDepth = 1;
    }
  }
  return -1;
}

/**
 * Stream-side recovery: text streams through immediately; from the first
 * wrapper open the tail is held until the block closes (or the stream ends)
 * so a candidate commits or restores as a whole — partial markup is never
 * emitted to the client.
 */
export class MarkupStreamExtractor implements StreamRecoverer {
  private hold = "";
  private scanTail = "";
  private holding = false;
  private disabled = false;
  private nextIndex = 0;
  committed = 0;

  constructor(
    private hints: DsmlToolHint[],
    private mode: ToolCallMode,
  ) {}

  get active(): boolean {
    return this.hints.length > 0 && this.mode !== "native" && !this.disabled;
  }

  feed(text: string): StreamEmit[] {
    if (!this.active) return [{ text }];
    const out: StreamEmit[] = [];
    if (!this.holding) {
      const s = this.scanTail + text;
      const m = MARKER.exec(s);
      if (!m) {
        const k = partialOpenLen(s);
        this.scanTail = k > 0 ? s.slice(s.length - k) : "";
        const vis = k > 0 ? s.slice(0, s.length - k) : s;
        if (vis) out.push({ text: vis });
        return out;
      }
      if (m.index > 0) out.push({ text: s.slice(0, m.index) });
      this.holding = true;
      this.scanTail = "";
      this.hold = s.slice(m.index);
    } else {
      this.hold += text;
    }
    out.push(...this.drain());
    return out;
  }

  /** End of stream: release the held tail (incomplete candidates restore
   *  verbatim). */
  flush(): StreamEmit[] {
    const s = this.scanTail + this.hold;
    this.scanTail = "";
    this.hold = "";
    this.holding = false;
    if (!s) return [];
    if (!this.active || this.disabled) return [{ text: s }];
    return this.emit(extractMarkupToolCalls(s, this.hints, this.mode));
  }

  /** A native tool_calls delta arrived: release the held tail as plain text
   *  and never recover markup again for this message. */
  disable(): StreamEmit[] {
    this.disabled = true;
    const s = this.scanTail + this.hold;
    this.scanTail = "";
    this.hold = "";
    this.holding = false;
    return s ? [{ text: s }] : [];
  }

  private drain(): StreamEmit[] {
    const out: StreamEmit[] = [];
    for (;;) {
      if (this.hold.length > MAX_HOLD) {
        const r = extractMarkupToolCalls(this.hold, this.hints, this.mode);
        this.hold = "";
        this.holding = false;
        out.push(...this.emit(r));
        return out;
      }
      const cut = findCloseCut(this.hold);
      if (cut <= 0) break;
      const blob = this.hold.slice(0, cut);
      this.hold = this.hold.slice(cut);
      out.push(...this.emit(extractMarkupToolCalls(blob, this.hints, this.mode)));
    }
    if (!MARKER.test(this.hold)) {
      const k = partialOpenLen(this.hold);
      const vis = k > 0 ? this.hold.slice(0, this.hold.length - k) : this.hold;
      this.hold = k > 0 ? this.hold.slice(this.hold.length - k) : "";
      this.holding = this.hold.length > 0;
      if (vis) out.push({ text: vis });
    }
    return out;
  }

  private emit(r: DsmlExtractResult): StreamEmit[] {
    const out: StreamEmit[] = [];
    if (r.text) out.push({ text: r.text });
    for (const c of r.calls) {
      this.committed++;
      out.push({ call: { id: c.id, name: c.name, argsJson: JSON.stringify(c.input), index: this.nextIndex++ } });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// reasoning round-trip (chat only, request side)
// ---------------------------------------------------------------------------

// A legacy proxy embedded reasoning as a markdown think block in `content`
// because its client only read `content`. The gateway delivers the NATIVE
// `reasoning_content` field (the IR round-trips it for every model family),
// so nothing is injected on the response side. Only the REVERSE direction is
// kept: a client that still replays the block in history gets it moved back
// into `reasoning_content` (a no-op for clients that never emit it).
const THINK_RE = /---\n###### Think Start \{([\s\S]*?)###### \} Think End\n---/;
/** Some models reject assistant tool-call turns without reasoning; replay a
 *  placeholder when the client never captured any. */
const THINK_FALLBACK = "Thinking process: deciding to call tools to process the user request.";

// ---------------------------------------------------------------------------
// request adaptation
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

function toolsFromBody(body: Record<string, unknown>, via: RecoverProto): ToolDef[] {
  const out: ToolDef[] = [];
  for (const raw of asArr(body.tools)) {
    const t = asRecord(raw);
    if (via !== "anthropic") {
      // Responses/chat tool lists may carry hosted tools (web_search, …):
      // only functions are expressible in the markup instruction.
      if (typeof t.type === "string" && t.type !== "function") continue;
      const fn = asRecord(t.function);
      const src = fn.name !== undefined ? fn : t;
      if (typeof src.name !== "string" || !src.name.trim()) continue;
      out.push({
        name: src.name.trim(),
        description: typeof src.description === "string" ? src.description : undefined,
        parameters: src.parameters,
      });
    } else {
      if (typeof t.name !== "string" || !t.name.trim()) continue;
      out.push({
        name: t.name.trim(),
        description: typeof t.description === "string" ? t.description : undefined,
        parameters: t.input_schema,
      });
    }
  }
  return out;
}

function toolList(tools: ToolDef[]): string {
  let s = "Available Tools:\n";
  for (const t of tools) {
    s += `- Name: ${t.name}\n`;
    s += `  Description: ${t.description ?? ""}\n`;
    s += `  Parameters: ${JSON.stringify(t.parameters ?? {})}\n\n`;
  }
  return s;
}

/**
 * `workaround` instruction: native calling is disabled, and ANY of the
 * supported markup formats is accepted (the gateway parses all of them).
 * One example per dialect; the model picks whichever it was trained on.
 */
export function buildWorkaroundToolInstruction(tools: ToolDef[]): string {
  let s = "\n\n<system_instruction>\n";
  s += "Native function calling is DISABLED. To call a tool, emit the call as text using ONE of the supported formats below. Do not mix formats in a single call.\n\n";
  s += "Format A:\n";
  s += "<tool_call>\n";
  s += "<function=tool_name_here>\n";
  s += "<parameter=param_name_1>value goes here</parameter>\n";
  s += "</function>\n";
  s += "</tool_call>\n\n";
  s += "Format B:\n";
  s += "<minimax:tool_call>\n";
  s += '<invoke name="tool_name_here">\n';
  s += '<parameter name="param_name_1">value goes here</parameter>\n';
  s += "</invoke>\n";
  s += "</minimax:tool_call>\n\n";
  s += "Format C:\n";
  s += '<tool_call>{"name": "tool_name_here", "arguments": {"param_name_1": "value goes here"}}</tool_call>\n\n';
  s += toolList(tools);
  s += "</system_instruction>";
  return s;
}

/** The single-format Xiaomi/MiMo instruction (kept for reference and tests). */
export function buildXiaomiToolInstruction(tools: ToolDef[]): string {
  let s = "\n\n<system_instruction>\n";
  s += "Native function calling is DISABLED. To call a tool, you MUST use the following exact XML format. Do not deviate.\n\n";
  s += "Format Example:\n";
  s += "<tool_call>\n";
  s += "<function=tool_name_here>\n";
  s += "<parameter=param_name_1>value goes here</parameter>\n";
  s += "<parameter=param_name_2>another value</parameter>\n";
  s += "</function>\n";
  s += "</tool_call>\n\n";
  s += toolList(tools);
  s += "</system_instruction>";
  return s;
}

/** Build the in-band instruction for a mode (empty for passive modes). */
export function buildMarkupInstruction(mode: ToolCallMode, tools: ToolDef[]): string {
  return mode === "workaround" ? buildWorkaroundToolInstruction(tools) : "";
}

/**
 * Rewrite an attempt body for a WORKAROUND target: strip native tools and
 * inject the instruction as a NEW user message, protocol-shaped so it never
 * breaks an in-flight tool result (Anthropic tool_result blocks stay in
 * their user message; chat/responses keep their own tool message and get a
 * separate user turn after it). Returns the same object for passive modes
 * (`native`/`fallback`) and when the body declares no tools.
 */
export function applyMarkupRequestAdaptation(
  body: Record<string, unknown>,
  via: RecoverProto,
  mode: ToolCallMode,
): Record<string, unknown> {
  if (mode !== "workaround") return body;
  // `tool_choice: "none"` means the caller forbids tool calls: leave the
  // request exactly as-is (mirrors toolHintsFromRequest).
  const choice = body.tool_choice;
  if (choice === "none" || asRecord(choice).type === "none") return body;
  const tools = toolsFromBody(body, via);
  if (!tools.length) return body;
  const out: Record<string, unknown> = { ...body };
  const instruction = buildMarkupInstruction(mode, tools);
  delete out.tools;
  delete out.tool_choice;
  delete out.functions;
  delete out.function_call;

  if (via === "anthropic") {
    const messages = asArr(out.messages).map((m) => ({ ...asRecord(m) }));
    const last = messages[messages.length - 1];
    if (last && last.role === "user") {
      // Append to the trailing user turn — a tool_result block keeps its
      // own user message and the instruction rides alongside it.
      const content = last.content;
      if (typeof content === "string") {
        last.content = [{ type: "text", text: content }, { type: "text", text: instruction }];
      } else if (Array.isArray(content)) {
        last.content = [...content, { type: "text", text: instruction }];
      } else {
        last.content = [{ type: "text", text: instruction }];
      }
    } else {
      messages.push({ role: "user", content: [{ type: "text", text: instruction }] });
    }
    out.messages = messages;
    return out;
  }

  if (via === "responses") {
    const input = asArr(out.input).map((m) => ({ ...asRecord(m) }));
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: instruction }] });
    out.input = input;
    return out;
  }

  const messages = asArr(out.messages).map((m) => ({ ...asRecord(m) }));
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    // Think-block round-trip: reasoning embedded in content goes back to
    // the `reasoning_content` field some models expect on tool-call turns.
    if (typeof msg.content === "string") {
      const m = THINK_RE.exec(msg.content);
      if (m) {
        msg.reasoning_content = m[1].trim();
        msg.content = msg.content.replace(THINK_RE, "").trim();
      }
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      if (typeof msg.reasoning_content !== "string" || !msg.reasoning_content.trim()) {
        msg.reasoning_content = THINK_FALLBACK;
      }
    }
  }
  messages.push({ role: "user", content: instruction });
  out.messages = messages;
  return out;
}

// ---------------------------------------------------------------------------
// recoverer factory
// ---------------------------------------------------------------------------

/** The markup dialect as a ToolRecoverer (see recovery.ts). */
export function markupRecoverer(mode: ToolCallMode, hints: DsmlToolHint[]): ToolRecoverer {
  const extract = (text: string): DsmlExtractResult => extractMarkupToolCalls(text, hints, mode);
  return {
    active: hints.length > 0 && mode !== "native",
    extract,
    patchRaw: (proto: RecoverProto, respText: string): string | null => {
      if (!hints.length || mode === "native") return null;
      return patchRawResponseDsml(proto, respText, hints, extract, MARKER);
    },
    stream: () => new MarkupStreamExtractor(hints, mode),
  };
}
