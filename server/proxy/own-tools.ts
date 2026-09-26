/**
 * "Own workaround" tool-call dialect: a single JSON object inside a fenced
 * code block tagged `tool_call`.
 *
 * Some providers (notably OpenAI's own serving stack) RECOGNIZE and rewrite
 * the common `<tool_call>` markup before it reaches the client, so the XML
 * workaround never survives. This dialect uses a shape those stacks do not
 * touch — a fenced code block — and is therefore the safest workaround for
 * models served behind such a stack.
 *
 * Wire format (must be exact):
 *
 *   ```tool_call
 *   {"name": "exec_bash", "parameters": {"cmd": "ls"}}
 *   ```
 *
 * Recovery is conservative, mirroring the XML dialects: the block must CLOSE,
 * the `name` must match a declared tool, and any block that fails to parse or
 * names an undeclared tool is restored byte-verbatim. The closing fence is
 * detected with a JSON-aware state machine, so a ``` inside a string VALUE
 * (e.g. a file being written that itself contains a code fence) never
 * terminates the block early — the same guarantee the XML parser gives for
 * nested tags.
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
import type { RecoverProto, StreamEmit, StreamRecoverer, ToolRecoverer } from "./recovery";

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Cheap "does this text carry the dialect marker at all?" probe. No newline
 *  in the pattern so it also matches inside a JSON-escaped raw body. */
const FENCE_MARKER = /```[ \t]*tool_call/i;
/** Longest tag that can still grow into the opening fence. */
const FENCE_TAG = "```tool_call";
const CLOSE_LINE_RE = /^[ \t]*```[ \t]*\r?$/;

let callSeq = 0;
function newCallId(): string {
  callSeq = (callSeq + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${callSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface OwnToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

/**
 * The `own` instruction: native calling is disabled and the model is told to
 * reply with the fenced JSON block, EXACTLY. Unlike the XML workaround this
 * is not "an example" — the exact fence tags are part of the contract.
 */
export function buildOwnToolInstruction(tools: OwnToolDef[]): string {
  let s = "\n\n<system_instruction>\n";
  s +=
    "Native function calling is DISABLED. To call a tool you MUST reply with a fenced code block tagged tool_call containing a single JSON object, EXACTLY in this shape (nothing more, nothing less):\n\n";
  s += "```tool_call\n";
  s += '{"name": "tool_name_here", "parameters": {"param_name_1": "value goes here"}}\n';
  s += "```\n\n";
  s += "Rules:\n";
  s += "- The opening line must be exactly: ```tool_call\n";
  s += "- The closing line must be exactly: ```\n";
  s +=
    '- The block contains ONE JSON object: "name" (the tool name, a string) and "parameters" (an object of parameters).\n';
  s += "- Do not use any other tool-call format.\n\n";
  s += "Available Tools:\n";
  s += JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      Parameters: t.parameters ?? {},
    })),
    null,
    2,
  );
  s += "\n</system_instruction>";
  return s;
}

// ---------------------------------------------------------------------------
// parsing (buffered)
// ---------------------------------------------------------------------------

interface FencedBlock {
  start: number;
  end: number;
  json: string;
}

/**
 * Find the closing fence for a block whose body starts at `from`. A line that
 * is exactly ``` closes the block ONLY when we are not inside a JSON string,
 * so a ``` inside a parameter VALUE never terminates early.
 */
function findFenceClose(text: string, from: number): { bodyEnd: number; end: number } | null {
  let i = from;
  let inString = false;
  let escaped = false;
  while (i <= text.length) {
    const nl = text.indexOf("\n", i);
    const lineEnd = nl === -1 ? text.length : nl;
    if (!inString && CLOSE_LINE_RE.test(text.slice(i, lineEnd))) {
      return { bodyEnd: i, end: nl === -1 ? text.length : nl + 1 };
    }
    for (let j = i; j < lineEnd; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      }
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return null;
}

/** Complete fenced blocks (opening fence + body + closing fence). */
function scanFencedBlocks(text: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  const re = new RegExp(FENCE_MARKER.source, "gi");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const bodyStart = m.index + m[0].length;
    const close = findFenceClose(text, bodyStart);
    if (!close) break; // no closing fence -> incomplete, restore verbatim
    out.push({ start: m.index, end: close.end, json: text.slice(bodyStart, close.bodyEnd) });
    re.lastIndex = close.end;
  }
  return out;
}

function parseFencedCall(json: string, hints: DsmlToolHint[]): DsmlRecoveredCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(json.trim());
  } catch {
    return null;
  }
  const rec = asRecord(obj);
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) return null;
  const hint = findHint(hints, name);
  if (!hint) return null; // undeclared name -> conservative restore
  const args = rec.arguments ?? rec.parameters;
  let raw: Record<string, unknown>;
  if (typeof args === "string") {
    try {
      raw = asRecord(JSON.parse(args));
    } catch {
      raw = {};
    }
  } else {
    raw = asRecord(args);
  }
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) input[canonicalKey(hint, k)] = v;
  return { id: newCallId(), name: hint.name, input: sanitizeArgs(input, hint) };
}

/**
 * Recover fenced-JSON tool calls from assistant content. Matched blocks are
 * removed (markup stripped) and become calls; a block that fails to parse or
 * names an undeclared tool is restored byte-verbatim.
 */
export function extractOwnToolCalls(text: string, hints: DsmlToolHint[]): DsmlExtractResult {
  if (!hints.length || !FENCE_MARKER.test(text)) return { text, calls: [], changed: false };
  const calls: DsmlRecoveredCall[] = [];
  const segments: string[] = [];
  let pos = 0;
  let changed = false;
  for (const block of scanFencedBlocks(text)) {
    const call = parseFencedCall(block.json, hints);
    if (!call) continue; // restore verbatim (stays in the kept text)
    segments.push(text.slice(pos, block.start));
    calls.push(call);
    changed = true;
    pos = block.end;
  }
  if (!changed) return { text, calls: [], changed: false };
  segments.push(text.slice(pos));
  const out = segments.join("").replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, calls, changed: true };
}

// ---------------------------------------------------------------------------
// parsing (streaming)
// ---------------------------------------------------------------------------

/** Longest suffix that could still grow into the opening fence. */
function partialFenceLen(s: string): number {
  const max = Math.min(s.length, FENCE_TAG.length + 3);
  for (let k = max; k >= 1; k--) {
    const cand = s.slice(s.length - k);
    if (cand[0] !== "`") continue;
    const norm = cand.replace(/\s+/g, "").toLowerCase();
    if (norm.length > 0 && FENCE_TAG.toLowerCase().startsWith(norm)) return k;
  }
  return 0;
}

/**
 * Stream-side recovery: text streams through immediately; from the opening
 * fence the tail is held until the closing fence arrives (or the stream ends)
 * so a candidate commits or restores as a whole — a partial block is never
 * emitted to the client.
 */
export class OwnStreamExtractor implements StreamRecoverer {
  private hold = "";
  private scanTail = "";
  private holding = false;
  private disabled = false;
  private nextIndex = 0;
  committed = 0;

  constructor(private hints: DsmlToolHint[]) {}

  get active(): boolean {
    return this.hints.length > 0 && !this.disabled;
  }

  feed(text: string): StreamEmit[] {
    if (!this.active) return [{ text }];
    const out: StreamEmit[] = [];
    if (!this.holding) {
      const s = this.scanTail + text;
      const m = FENCE_MARKER.exec(s);
      if (!m) {
        const k = partialFenceLen(s);
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

  /** End of stream: release the held tail (incomplete blocks restore
   *  verbatim). */
  flush(): StreamEmit[] {
    const s = this.scanTail + this.hold;
    this.scanTail = "";
    this.hold = "";
    this.holding = false;
    if (!s) return [];
    if (!this.active) return [{ text: s }];
    return this.emit(extractOwnToolCalls(s, this.hints));
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
      const m = FENCE_MARKER.exec(this.hold);
      if (!m) break;
      const close = findFenceClose(this.hold, m.index + m[0].length);
      if (!close) break; // incomplete: keep holding
      const blob = this.hold.slice(0, close.end);
      this.hold = this.hold.slice(close.end);
      out.push(...this.emit(extractOwnToolCalls(blob, this.hints)));
    }
    // Release everything except a possible partial opening fence.
    if (!FENCE_MARKER.test(this.hold)) {
      const k = partialFenceLen(this.hold);
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
// recoverer factory
// ---------------------------------------------------------------------------

/** The fenced-JSON dialect as a ToolRecoverer (see recovery.ts). */
export function ownRecoverer(hints: DsmlToolHint[]): ToolRecoverer {
  const extract = (text: string): DsmlExtractResult => extractOwnToolCalls(text, hints);
  return {
    active: hints.length > 0,
    extract,
    patchRaw: (proto: RecoverProto, respText: string): string | null => {
      if (!hints.length) return null;
      return patchRawResponseDsml(proto, respText, hints, extract, FENCE_MARKER);
    },
    stream: () => new OwnStreamExtractor(hints),
  };
}
