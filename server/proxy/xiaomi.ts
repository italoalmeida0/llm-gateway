/**
 * Xiaomi MiMo tool-call adaptation.
 *
 * MiMo's native function calling is unreliable through OpenAI-compatible
 * serving stacks: tool calls come back as an XML envelope in assistant
 * CONTENT (or are dropped entirely), and multi-turn tool conversations are
 * rejected unless the assistant's `reasoning_content` is replayed. The
 * proven workaround (originally a standalone proxy) is:
 *
 *   1. REQUEST: drop the native `tools`/`tool_choice` and deliver the tool
 *      schema as an in-band `<system_instruction>` XML block in a NEW user
 *      message (protocol-specific: chat `role:user` string, Anthropic
 *      `role:user` text block, Responses `input` `input_text` message);
 *   2. RESPONSE: recover the model's XML tool calls
 *
 *        <tool_call>
 *          <function=exec_bash>
 *            <parameter=cmd>ls -la</parameter>
 *          </function>
 *        </tool_call>
 *
 *      into native `tool_calls` (all three protocols), stripping the markup;
 *   3. REASONING: round-trip `reasoning_content` through a think block in
 *      content so a content-only client can replay it (chat only — the
 *      other protocols carry reasoning natively).
 *
 * Recovery is conservative, mirroring the DSML recoverer (dsml.ts): a
 * candidate must CLOSE (`</tool_call>`), the function name must match a
 * declared tool, and unmatched blocks are restored byte-verbatim. Active
 * only when the request declared tools.
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

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Detection is deliberately model-id based: any id containing "xiaomi"
 *  (e.g. `xiaomi/mimo-v2.5-pro`, `xiaomi-mimo`) gets the adaptation, so a
 *  MiMo served through a third-party gateway is covered too. */
export function isXiaomiModel(model: unknown): boolean {
  return typeof model === "string" && /xiaomi/i.test(model);
}

// ---------------------------------------------------------------------------
// XML dialect parsing (buffered)
// ---------------------------------------------------------------------------

/** Block open/close (`<tool_call>` … `</tool_call>`), tolerant of `-`/`_`
 *  and a plural `s`. */
const XIAOMI_MARKER = /<\s*tool[_-]?calls?\s*>/i;
/**
 * One scanner over every structural tag, so nesting can be tracked by
 * DEPTH: a tag appearing inside a parameter VALUE is literal text (a model
 * writing a file whose content happens to contain the markup), never a
 * separate call and never a premature terminator.
 *
 *   1 block close · 2 block open · 3 function close · 4 function open (5 name)
 *   · 6 parameter close · 7 parameter open (8 name)
 */
const TAG_RE = new RegExp(
  [
    String.raw`(<\s*\/\s*tool[_-]?calls?\s*>)`,
    String.raw`(<\s*tool[_-]?calls?\s*>)`,
    String.raw`(<\s*\/\s*function\s*>)`,
    String.raw`(<\s*function\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*>)`,
    String.raw`(<\s*\/\s*parameter\s*>)`,
    String.raw`(<\s*parameter\s*=\s*["']?\s*([^>\s"']+)\s*["']?\s*[^>]*>)`,
  ].join("|"),
  "gi",
);

let callSeq = 0;
function newCallId(): string {
  callSeq = (callSeq + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${callSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** tmp/proxy.ts parity: JSON when the raw text parses, otherwise the raw
 *  string (so `<parameter=cmd>ls -la</parameter>` stays a string). */
function parseXiaomiValue(raw: string): unknown {
  if (!raw) return "";
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface XiaomiBlock {
  start: number;
  end: number;
  name: string | null;
  params: Array<{ key: string; value: string }>;
}

/**
 * Single depth-aware scan of every structural tag. A `<tool_call>`/`<function>`
 * /`<parameter>` appearing INSIDE a parameter value is literal data (a model
 * writing a file whose content contains the markup) — it neither opens a
 * nested call nor terminates the enclosing one. Nested parameters are
 * tracked by depth so a balanced pair inside a value stays in the value.
 *
 * Returns only COMPLETE blocks (a block whose `</tool_call>` was seen); an
 * unclosed block is never returned, so it restores verbatim.
 */
function scanBlocks(text: string): XiaomiBlock[] {
  const re = new RegExp(TAG_RE.source, "gi");
  const out: XiaomiBlock[] = [];
  let blockDepth = 0;
  let blockStart = -1;
  let name: string | null = null;
  let params: Array<{ key: string; value: string }> = [];
  let paramDepth = 0;
  let paramKey: string | null = null;
  let paramValStart = 0;
  // A spurious call/function nested inside the outermost block (outside any
  // parameter value): ignored entirely — its params never join the outer call.
  let skipDepth = 0;

  const commitParam = (endIdx: number) => {
    if (paramKey) params.push({ key: paramKey, value: text.slice(paramValStart, endIdx) });
    paramKey = null;
    paramDepth = 0;
  };

  for (let m = re.exec(text); m; m = re.exec(text)) {
    const inParam = paramDepth > 0;
    if (m[1] !== undefined) {
      // </tool_call> — literal inside a value; a nested close unwinds the
      // skip region; otherwise it closes the outermost block.
      if (inParam) continue;
      if (skipDepth > 0) skipDepth--;
      else if (blockDepth === 1) {
        out.push({ start: blockStart, end: m.index + m[0].length, name, params });
        blockDepth = 0;
        name = null;
        params = [];
      }
      continue;
    }
    if (m[2] !== undefined) {
      // <tool_call> — literal inside a value; a nested open starts a skip
      // region; otherwise it opens the outermost block.
      if (inParam) continue;
      if (blockDepth === 0) {
        blockStart = m.index;
        blockDepth = 1;
        name = null;
        params = [];
      } else skipDepth++;
      continue;
    }
    if (m[3] !== undefined) {
      // </function> — literal inside a value; unwinds a skip region.
      if (!inParam && skipDepth > 0) skipDepth--;
      continue;
    }
    if (m[4] !== undefined) {
      // <function=NAME> — literal inside a value; a second sibling function
      // (or one inside a skip region) is ignored; the first one wins.
      if (inParam) continue;
      if (skipDepth > 0) skipDepth++;
      else if (blockDepth === 1 && name === null) name = (m[5] ?? "").trim();
      else if (blockDepth === 1) skipDepth++;
      continue;
    }
    if (m[6] !== undefined) {
      // </parameter> — closes the innermost open parameter.
      if (paramDepth > 1) paramDepth--;
      else if (paramDepth === 1) commitParam(m.index);
      continue;
    }
    if (m[7] !== undefined) {
      // <parameter=KEY> — literal inside a value (tracked by depth); ignored
      // in a skip region.
      if (inParam) {
        paramDepth++;
        continue;
      }
      if (skipDepth > 0 || blockDepth === 0) continue;
      paramDepth = 1;
      paramKey = (m[8] ?? "").trim();
      paramValStart = m.index + m[0].length;
      continue;
    }
  }
  return out;
}

/**
 * Recover Xiaomi XML tool calls from assistant content. Matched blocks are
 * removed (markup stripped) and become calls; a block whose function name is
 * not a declared tool (or that has no `<function=…>` at all) is restored
 * byte-verbatim. Only the OUTERMOST block commits — a call written inside
 * another is ignored, never emitted as a second overlapping call — while a
 * tag nested inside a parameter VALUE is preserved as literal text.
 */
export function extractXiaomiToolCalls(text: string, hints: DsmlToolHint[]): DsmlExtractResult {
  if (!hints.length || !XIAOMI_MARKER.test(text)) return { text, calls: [], changed: false };
  const calls: DsmlRecoveredCall[] = [];
  const segments: string[] = [];
  let pos = 0;
  let changed = false;
  for (const block of scanBlocks(text)) {
    const hint = block.name !== null ? findHint(hints, block.name) : undefined;
    if (!hint) continue; // restore verbatim (stays in the kept text)
    segments.push(text.slice(pos, block.start));
    const input: Record<string, unknown> = {};
    for (const p of block.params) {
      const key = p.key.trim();
      if (!key) continue;
      input[canonicalKey(hint, key)] = parseXiaomiValue(p.value.trim());
    }
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
// XML dialect parsing (streaming)
// ---------------------------------------------------------------------------

/** Hard cap on the held marker tail (bounded memory). */
const MAX_HOLD = 512 * 1024;

const OPEN_TAGS = ["tool_call", "tool-call", "tool_calls", "tool-calls", "toolcall", "toolcalls"];

/** Longest suffix that could still grow into a `<tool_call…` open tag. */
function partialOpenLen(s: string): number {
  const max = Math.min(s.length, 16);
  for (let k = max; k >= 1; k--) {
    const cand = s.slice(s.length - k);
    if (cand[0] !== "<") continue;
    const body = cand.slice(1).replace(/\s+/g, "").toLowerCase();
    if (OPEN_TAGS.some((t) => t.startsWith(body))) return k;
  }
  return 0;
}

/** End offset of the matching close of the FIRST open block, param-aware so
 *  a block tag inside a parameter value is literal (never a terminator), and
 *  skip-aware so a nested call does not close the outer block early. */
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
    } else if (m[4] !== undefined) {
      if (!inParam && blockDepth === 1) skipDepth++;
    } else if (m[6] !== undefined) {
      if (paramDepth > 0) paramDepth--;
    } else if (m[7] !== undefined) {
      if (inParam) paramDepth++;
      else if (skipDepth === 0 && blockDepth === 1) paramDepth = 1;
    }
  }
  return -1;
}

/**
 * Stream-side recovery: text streams through immediately; from the first
 * `<tool_call` the tail is held until the block closes (or the stream ends)
 * so a candidate commits or restores as a whole — partial markup is never
 * emitted to the client.
 */
export class XiaomiStreamExtractor implements StreamRecoverer {
  private hold = "";
  private scanTail = "";
  private holding = false;
  private nextIndex = 0;
  committed = 0;

  constructor(private hints: DsmlToolHint[]) {}

  get active(): boolean {
    return this.hints.length > 0;
  }

  feed(text: string): StreamEmit[] {
    if (!this.active) return [{ text }];
    const out: StreamEmit[] = [];
    if (!this.holding) {
      const s = this.scanTail + text;
      const m = XIAOMI_MARKER.exec(s);
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
    if (!this.active) return [{ text: s }];
    return this.emit(extractXiaomiToolCalls(s, this.hints));
  }

  private drain(): StreamEmit[] {
    const out: StreamEmit[] = [];
    for (;;) {
      if (this.hold.length > MAX_HOLD) {
        const r = extractXiaomiToolCalls(this.hold, this.hints);
        this.hold = "";
        this.holding = false;
        out.push(...this.emit(r));
        return out;
      }
      const cut = findCloseCut(this.hold);
      if (cut <= 0) break;
      const blob = this.hold.slice(0, cut);
      this.hold = this.hold.slice(cut);
      out.push(...this.emit(extractXiaomiToolCalls(blob, this.hints)));
    }
    // No complete block pending: release everything except a possible
    // partial open tag so trailing prose streams promptly.
    if (!XIAOMI_MARKER.test(this.hold)) {
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

// The proven proxy embedded reasoning as a markdown think block in `content`
// because its client only read `content`. The gateway delivers the NATIVE
// `reasoning_content` field (the IR round-trips it for every model family),
// so nothing is injected on the response side. Only the REVERSE direction is
// kept: a client that still replays the block in history gets it moved back
// into `reasoning_content` (a no-op for clients that never emit it).
const THINK_RE = /---\n###### Think Start \{([\s\S]*?)###### \} Think End\n---/;
/** MiMo rejects assistant tool-call turns without reasoning; replay a
 *  placeholder when the client never captured any (tmp/proxy.ts parity). */
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
      // only functions are expressible in the XML instruction.
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

/** The exact `<system_instruction>` block the proven proxy sends. */
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
  s += "Available Tools:\n";
  for (const t of tools) {
    s += `- Name: ${t.name}\n`;
    s += `  Description: ${t.description ?? ""}\n`;
    s += `  Parameters: ${JSON.stringify(t.parameters ?? {})}\n\n`;
  }
  s += "</system_instruction>";
  return s;
}

/**
 * Rewrite an attempt body for a Xiaomi target: strip native tools and inject
 * the XML instruction as a NEW user message, protocol-shaped so it never
 * breaks an in-flight tool result (Anthropic tool_result blocks stay in
 * their user message; chat/responses keep their own tool message and get a
 * separate user turn after it). Returns the same object when the body
 * declares no tools (nothing to adapt).
 */
export function applyXiaomiRequestAdaptation(
  body: Record<string, unknown>,
  via: RecoverProto,
): Record<string, unknown> {
  // `tool_choice: "none"` means the caller forbids tool calls: leave the
  // request exactly as-is (mirrors toolHintsFromRequest).
  const choice = body.tool_choice;
  if (choice === "none" || asRecord(choice).type === "none") return body;
  const tools = toolsFromBody(body, via);
  if (!tools.length) return body;
  const out: Record<string, unknown> = { ...body };
  const instruction = buildXiaomiToolInstruction(tools);
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
    // the `reasoning_content` field MiMo expects on tool-call turns.
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

/**
 * Patch a raw buffered body: Xiaomi XML recovery across the three protocols.
 * Returns null when nothing changed — untouched bodies keep their exact
 * bytes. Native `reasoning_content` is left alone (the client reads it).
 */
function patchXiaomiRaw(
  proto: RecoverProto,
  respText: string,
  hints: DsmlToolHint[],
  extract: (text: string) => DsmlExtractResult,
): string | null {
  if (!hints.length) return null;
  return patchRawResponseDsml(proto, respText, hints, extract, XIAOMI_MARKER);
}

/** The Xiaomi dialect as a ToolRecoverer (see recovery.ts). */
export function xiaomiRecoverer(hints: DsmlToolHint[]): ToolRecoverer {
  const extract = (text: string): DsmlExtractResult => extractXiaomiToolCalls(text, hints);
  return {
    active: hints.length > 0,
    extract,
    patchRaw: (proto, respText) => patchXiaomiRaw(proto, respText, hints, extract),
    stream: () => new XiaomiStreamExtractor(hints),
  };
}
