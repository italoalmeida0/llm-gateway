/**
 * DSML (DeepSeek Markup Language) tool-call recovery.
 *
 * DeepSeek V4 / V4.1 models wrap tool calls in DSML — an XML-ish envelope
 * the vendor stack converts to JSON tool calls server-side:
 *
 *   <｜DSML｜tool_calls>
 *     <｜DSML｜invoke name="exec_bash">
 *       <｜DSML｜parameter name="cmd" string="true">ls -la</｜DSML｜parameter>
 *     </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * (the vertical bar is the FULL-WIDTH ｜ U+FF5C, not ASCII `|`). Through an
 * OpenAI-compatible upstream that conversion does not always happen — the
 * markup leaks into assistant content and the client never sees a tool
 * call. Long contexts make it worse (serving-layer bug reports around
 * DeepSeek-V4-Flash document the whole family):
 *
 *   - opening wrapper corrupted/misspelled: `toolcalls`, `tool`, `calls`;
 *   - opening wrapper omitted entirely (only the inner invoke survives);
 *   - the invoke open tag missing while its close tag is emitted
 *     (parameter run + `</｜DSML｜invoke>`);
 *   - orphan closing tails leaking AFTER a successful call
 *     (`</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`).
 *
 * This module recovers those into real tool calls at the response edge
 * (buffered bodies and IR stream deltas). Recovery is deliberately
 * conservative — a mis-parse that invents a call is worse than markup:
 *
 *   - never active unless the request DECLARED tools (tool_choice != none):
 *     a completion that merely quotes DSML is never consumed;
 *   - a candidate must CLOSE (`</｜DSML｜invoke>`) before it commits —
 *     prose that merely mentions markers cannot become a phantom call;
 *   - the tool name must match a declared tool; for the missing-invoke-open
 *     variant the name is reconstructed ONLY when exactly one declared tool
 *     fits the recovered parameter names (and its required args are all
 *     present). Rejected or incomplete candidates are restored byte-verbatim;
 *   - orphan closing tails (closing markers with no opener) are absorbed —
 *     they are protocol debris and must never surface as content.
 *
 * Everything here is pure/sync and dependency-free; the stream extractor
 * holds at most the marker tail (see MAX_HOLD) so memory stays bounded.
 */

// ---------------------------------------------------------------------------
// request-side tool hints
// ---------------------------------------------------------------------------

export interface DsmlToolHint {
  name: string;
  /** Declared property name -> JSON schema type ("" when unspecified). */
  props: Map<string, string>;
  required: Set<string>;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Declared tools of a request body (any protocol: OpenAI `tools[].function`,
 * Anthropic `tools[].input_schema`, Responses `tools[]`). Returns [] — i.e.
 * recovery disabled — when the request declares no tools or explicitly sets
 * tool_choice "none".
 */
export function toolHintsFromRequest(body: unknown): DsmlToolHint[] {
  const root = asRecord(body);
  const choice = root.tool_choice;
  if (choice === "none" || asRecord(choice).type === "none") return [];
  const out: DsmlToolHint[] = [];
  for (const t of asArr(root.tools)) {
    const rec = asRecord(t);
    const fn = asRecord(rec.function);
    const src = fn.name !== undefined ? fn : rec;
    const name = typeof src.name === "string" ? src.name.trim() : "";
    if (!name) continue;
    const schema = asRecord(src.parameters ?? src.input_schema);
    const props = new Map<string, string>();
    for (const [k, v] of Object.entries(asRecord(schema.properties))) {
      const ty = asRecord(v).type;
      props.set(k, typeof ty === "string" ? ty : "");
    }
    const required = new Set<string>();
    for (const r of asArr(schema.required)) if (typeof r === "string") required.add(r);
    out.push({ name, props, required });
  }
  return out;
}

// ---------------------------------------------------------------------------
// marker tokenizer
// ---------------------------------------------------------------------------

/** Full DSML-ish tag. Bar is ASCII `|` or full-width `｜`, spacing is free,
 *  the tag name may be absent (garbled variants become opaque brackets). */
const TAG_SRC = String.raw`<\s*(\/?)\s*[|｜]\s*DSML\s*[|｜]\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_-]*)?([^<>]*)>`;
/** Start of any DSML tag — the hold trigger on the stream path. */
const MSTART = /<\s*\/?\s*[|｜]\s*DSML\s*[|｜]/i;

interface TagTok {
  start: number;
  end: number;
  /** Normalized name (lowercase, `_`/`-` removed): `tool_calls` -> `toolcalls`. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attrs: string;
}

type Piece = { start: number; end: number; tag: TagTok | null };

function tokenize(text: string): Piece[] {
  const re = new RegExp(TAG_SRC, "gi");
  const pieces: Piece[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) pieces.push({ start: last, end: m.index, tag: null });
    const attrsRaw = m[4] ?? "";
    const selfClosing = m[2] === "/" || /\/\s*$/.test(attrsRaw);
    const end = m.index + m[0].length;
    pieces.push({
      start: m.index,
      end,
      tag: {
        start: m.index,
        end,
        name: (m[3] ?? "").toLowerCase().replace(/[_-]/g, ""),
        closing: m[1] === "/",
        selfClosing,
        attrs: attrsRaw.replace(/\/\s*$/, ""),
      },
    });
    last = end;
  }
  if (last < text.length) pieces.push({ start: last, end: text.length, tag: null });
  return pieces;
}

const PARAM_NAMES = new Set(["parameter", "param", "params", "argument", "arguments", "arg"]);
const INVOKE_NAMES = new Set(["invoke", "call", "function"]);

const isParamTag = (t: TagTok) => PARAM_NAMES.has(t.name);
const isInvokeClose = (t: TagTok) => t.closing && INVOKE_NAMES.has(t.name);
/** An invoke open is `invoke`, or a `call`/`function` tag carrying the tool
 *  name attribute (a bare `<｜DSML｜calls>` is the WRAPPER variant). */
const isInvokeOpen = (t: TagTok) =>
  !t.closing && (t.name === "invoke" || (INVOKE_NAMES.has(t.name) && attrValue(t.attrs, "name") !== null));
/** Everything that is not invoke/param brackets the block (tool_calls,
 *  toolcalls, tool, tools, calls, and unknown names). */
const isWrapperClose = (t: TagTok) => t.closing && !INVOKE_NAMES.has(t.name) && !PARAM_NAMES.has(t.name);

function attrValue(attrs: string, key: string): string | null {
  const m = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? "";
}

function findTag(pieces: Piece[], from: number, to: number, pred: (t: TagTok) => boolean): number {
  for (let i = from; i < to; i++) {
    const t = pieces[i].tag;
    if (t && pred(t)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// value parsing
// ---------------------------------------------------------------------------

/** Strict JSON first, then a trailing-comma tolerance; `ok:false` means
 *  "not JSON at all" and the caller falls back to the raw string. */
function parseLooseJson(raw: string): { ok: boolean; value: unknown } {
  const s = raw.trim();
  if (!s) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {}
  try {
    return { ok: true, value: JSON.parse(s.replace(/,\s*([}\]])/g, "$1")) };
  } catch {}
  return { ok: false, value: undefined };
}

/** `string="true"` -> the raw text is the value; `string="false"` (or
 *  absent) -> the text is JSON, falling back to the raw string. */
function paramValue(raw: string, attrs: string): unknown {
  const sAttr = (attrValue(attrs, "string") ?? "").toLowerCase();
  if (sAttr === "true") return raw;
  const parsed = parseLooseJson(raw);
  return parsed.ok ? parsed.value : raw;
}

/**
 * Light argument hygiene for RECOVERED calls only (native tool_calls are
 * byte-faithful and never touched): the classic DeepSeek harness mistakes —
 * `null` for optional keys (omit instead) and JSON-in-a-string for typed
 * values (unwrap and coerce against the declared schema).
 */
function sanitizeArgs(input: Record<string, unknown>, hint: DsmlToolHint): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const type = hint.props.get(k) ?? "";
    if (v === null && !hint.required.has(k)) continue;
    if (typeof v === "string" && type && type !== "string") {
      const parsed = parseLooseJson(v);
      if (parsed.ok && parsed.value !== null && typeof parsed.value !== "string") {
        out[k] = parsed.value;
        continue;
      }
      if (type === "number" || type === "integer") {
        const n = Number(v);
        if (v.trim() !== "" && Number.isFinite(n)) {
          out[k] = n;
          continue;
        }
      }
      if (type === "boolean" && (v === "true" || v === "false")) {
        out[k] = v === "true";
        continue;
      }
      out[k] = v;
      continue;
    }
    if (type === "string" && v !== null && typeof v === "object") {
      out[k] = JSON.stringify(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// buffered extraction
// ---------------------------------------------------------------------------

export interface DsmlRecoveredCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface DsmlExtractResult {
  /** Text with committed regions removed and orphan closers absorbed. */
  text: string;
  calls: DsmlRecoveredCall[];
  /** True when the text differs from the input (calls and/or absorbed debris). */
  changed: boolean;
}

let callSeq = 0;
function newCallId(): string {
  callSeq = (callSeq + 1) % 1_000_000;
  return `call_${Date.now().toString(36)}${callSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface RangeResult {
  text: string;
  calls: DsmlRecoveredCall[];
  changed: boolean;
}

/** Build a call from one invoke candidate; null = reject (restore verbatim). */
function buildInvokeCall(t: TagTok, inner: Piece[], src: string, hints: DsmlToolHint[]): DsmlRecoveredCall | null {
  const nameAttr = attrValue(t.attrs, "name") ?? attrValue(t.attrs, "tool") ?? attrValue(t.attrs, "function");
  const params: Array<{ name: string; value: unknown }> = [];
  let i = 0;
  while (i < inner.length) {
    const p = inner[i];
    if (!p.tag) {
      // Only whitespace may sit between parameters.
      if (src.slice(p.start, p.end).trim()) return null;
      i++;
      continue;
    }
    const tt = p.tag;
    if (!tt.closing && isParamTag(tt)) {
      const name = attrValue(tt.attrs, "name");
      if (name === null) return null;
      let value: unknown;
      if (tt.selfClosing) {
        value = paramValue("", tt.attrs);
      } else {
        const closeIdx = findTag(inner, i + 1, inner.length, (x) => x.closing && isParamTag(x));
        if (closeIdx === -1) return null;
        if (inner.slice(i + 1, closeIdx).some((x) => x.tag)) return null;
        value = paramValue(src.slice(tt.end, inner[closeIdx].start), tt.attrs);
        i = closeIdx;
      }
      params.push({ name: name.trim(), value });
      i++;
      continue;
    }
    return null; // unexpected tag inside an invoke
  }
  return assembleCall(nameAttr, params, hints);
}

/** Name resolution + argument assembly shared by both candidate shapes. */
function assembleCall(
  nameAttr: string | null,
  params: Array<{ name: string; value: unknown }>,
  hints: DsmlToolHint[],
): DsmlRecoveredCall | null {
  let hint: DsmlToolHint | undefined;
  if (nameAttr !== null) {
    const n = nameAttr.trim();
    hint = hints.find((h) => h.name === n);
    if (!hint) return null; // undeclared name -> conservative restore
  } else {
    // Missing invoke open: reconstruct the name ONLY when exactly one
    // declared tool fits the recovered parameter names.
    const names = new Set(params.map((p) => p.name));
    if (names.size === 0) return null;
    const fits = hints.filter(
      (h) =>
        [...names].every((n) => h.props.has(n)) && [...h.required].every((r) => names.has(r)),
    );
    if (fits.length !== 1) return null;
    hint = fits[0];
  }
  const input: Record<string, unknown> = {};
  for (const p of params) input[p.name] = p.value;
  return { id: newCallId(), name: hint.name, input: sanitizeArgs(input, hint) };
}

/** A parameter run outside any invoke open (the missing-invoke-open variant).
 *  Trailing orphan closers join the candidate so a reject restores the whole
 *  fragment symmetrically (and a commit absorbs them). */
function parseOrphanRun(
  src: string,
  pieces: Piece[],
  i: number,
  hi: number,
  hints: DsmlToolHint[],
): { next: number; call: DsmlRecoveredCall | null } {
  let j = i;
  let bad = false;
  const params: Array<{ name: string; value: unknown }> = [];
  while (j < hi) {
    const p = pieces[j];
    const t = p.tag!;
    if (!t) {
      if (src.slice(p.start, p.end).trim()) break;
      j++;
      continue;
    }
    if (!t.closing && isParamTag(t)) {
      const name = attrValue(t.attrs, "name");
      if (name === null) {
        bad = true;
        break;
      }
      if (t.selfClosing) {
        params.push({ name: name.trim(), value: paramValue("", t.attrs) });
        j++;
        continue;
      }
      const closeIdx = findTag(pieces, j + 1, hi, (x) => x.closing && isParamTag(x));
      if (closeIdx === -1) {
        bad = true;
        break;
      }
      if (pieces.slice(j + 1, closeIdx).some((x) => x.tag)) {
        bad = true;
        break;
      }
      params.push({ name: name.trim(), value: paramValue(src.slice(t.end, pieces[closeIdx].start), t.attrs) });
      j = closeIdx + 1;
      continue;
    }
    break;
  }
  // Absorb closing debris directly after the params (`</invoke></tool_calls>`).
  while (j < hi) {
    const p = pieces[j];
    const t = p.tag!;
    if (!t) {
      if (src.slice(p.start, p.end).trim()) break;
      j++;
      continue;
    }
    if (t.closing) {
      j++;
      continue;
    }
    break;
  }
  const call = bad || params.length === 0 ? null : assembleCall(null, params, hints);
  return { next: j, call };
}

function processRange(
  src: string,
  pieces: Piece[],
  lo: number,
  hi: number,
  hints: DsmlToolHint[],
  dropWs = false,
): RangeResult {
  const res: RangeResult = { text: "", calls: [], changed: false };
  let i = lo;
  let pendingWs = "";
  let debris = false;
  const rangeEnd = hi > lo ? pieces[hi - 1].end : pieces[lo]?.start ?? src.length;
  while (i < hi) {
    const p = pieces[i];
    const t = p.tag;
    if (!t) {
      const raw = src.slice(p.start, p.end);
      // Inside a wrapper region, whitespace-only pieces are block padding —
      // they must not surface as content once the block commits.
      if (dropWs && !raw.trim()) {
        i++;
        continue;
      }
      // Whitespace-only pieces are deferred: their fate depends on whether
      // the next structural thing is absorbed debris (see below).
      if (!raw.trim()) {
        pendingWs += raw;
        i++;
        continue;
      }
      res.text += pendingWs + raw;
      pendingWs = "";
      debris = false;
      i++;
      continue;
    }

    // --- invoke candidate ---------------------------------------------
    if (isInvokeOpen(t)) {
      res.text += pendingWs;
      pendingWs = "";
      debris = false;
      if (t.selfClosing) {
        const call = buildInvokeCall(t, [], src, hints);
        if (call) {
          res.calls.push(call);
          res.changed = true;
        } else res.text += src.slice(t.start, t.end);
        i++;
        continue;
      }
      const closeIdx = findTag(pieces, i + 1, hi, (x) => isInvokeClose(x));
      if (closeIdx === -1) {
        // Incomplete candidate (no close): it can never commit — restore
        // everything from here verbatim and stop parsing this range.
        res.text += src.slice(t.start, rangeEnd);
        i = hi;
        continue;
      }
      const call = buildInvokeCall(t, pieces.slice(i + 1, closeIdx), src, hints);
      const raw = src.slice(t.start, pieces[closeIdx].end);
      if (call) {
        res.calls.push(call);
        res.changed = true;
      } else res.text += raw;
      i = closeIdx + 1;
      continue;
    }

    // --- orphan parameter run (missing invoke open) --------------------
    if (!t.closing && isParamTag(t)) {
      res.text += pendingWs;
      pendingWs = "";
      debris = false;
      const run = parseOrphanRun(src, pieces, i, hi, hints);
      const raw = src.slice(t.start, pieces[Math.max(i, run.next - 1)].end);
      if (run.call) {
        res.calls.push(run.call);
        res.changed = true;
      } else res.text += raw;
      i = Math.max(i + 1, run.next);
      continue;
    }

    // --- wrapper region ------------------------------------------------
    if (!t.closing) {
      res.text += pendingWs;
      pendingWs = "";
      debris = false;
      const closeIdx = findTag(pieces, i + 1, hi, (x) => isWrapperClose(x));
      const innerHi = closeIdx === -1 ? hi : closeIdx;
      const inner = processRange(src, pieces, i + 1, innerHi, hints, true);
      if (inner.changed) {
        res.changed = true;
        res.calls.push(...inner.calls);
        res.text += inner.text;
      } else {
        // Nothing recovered inside: keep wrapper + content byte-verbatim
        // (including the closing tag when the region is closed).
        res.text += closeIdx === -1 ? src.slice(t.start, rangeEnd) : src.slice(t.start, pieces[closeIdx].end);
      }
      i = closeIdx === -1 ? hi : closeIdx + 1;
      continue;
    }

    // --- orphan closer: protocol debris, absorbed together with its
    //     padding whitespace (never leaked as content) -------------------
    res.changed = true;
    debris = true;
    pendingWs = "";
    i++;
  }
  if (!debris) res.text += pendingWs;
  return res;
}

/**
 * Recover DSML tool calls from assistant content.
 *
 * `hints` come from the request (`toolHintsFromRequest`) — an empty list
 * disables everything: markup in a no-tools completion is content, not a
 * call, and must survive byte-for-byte.
 */
export function extractDsmlToolCalls(text: string, hints: DsmlToolHint[]): DsmlExtractResult {
  if (!hints.length || !MSTART.test(text)) return { text, calls: [], changed: false };
  const pieces = tokenize(text);
  const r = processRange(text, pieces, 0, pieces.length, hints);
  return { text: r.text, calls: r.calls, changed: r.changed };
}

// ---------------------------------------------------------------------------
// streaming extraction
// ---------------------------------------------------------------------------

export type DsmlEmit =
  | { text: string }
  | { call: { id: string; name: string; argsJson: string; index: number } };

/** Hard cap on the held marker tail. A pathological block force-releases
 *  (extract + keep scanning) so memory stays bounded. */
const MAX_HOLD = 512 * 1024;
/** Longest marker prefix worth holding back at a chunk boundary. */
const MAX_PREFIX = 32;

/** Could `s` still grow into `<｜DSML｜…`? (whitespace-tolerant). */
function couldBeMarkerPrefix(s: string): boolean {
  const t = s.replace(/\s+/g, "").toLowerCase();
  return /^<\/?[|｜]?d?s?m?l?[|｜]?$/.test(t);
}

function partialPrefixLen(s: string): number {
  const max = Math.min(s.length, MAX_PREFIX);
  for (let k = max; k >= 1; k--) {
    const cand = s.slice(s.length - k);
    if (cand.startsWith("<") && couldBeMarkerPrefix(cand)) return k;
  }
  return 0;
}

/** End offset of the first wrapper-ish close tag (the release point). */
function findReleaseCut(s: string): number {
  const re = new RegExp(TAG_SRC, "gi");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const name = (m[3] ?? "").toLowerCase().replace(/[_-]/g, "");
    const closing = m[1] === "/";
    if (closing && !INVOKE_NAMES.has(name) && !PARAM_NAMES.has(name)) {
      return m.index + m[0].length;
    }
  }
  return -1;
}

/**
 * Stream-side recovery: text BEFORE the first marker streams through
 * immediately; the marker tail is held until the block closes (or the
 * stream ends) so a candidate can commit or be restored as a whole —
 * partial markup is never emitted to the client.
 */
export class DsmlStreamExtractor {
  private hold = "";
  private scanTail = "";
  private holding = false;
  private nextIndex = 0;
  /** Committed tool calls so far (the translator upgrades `stop` to
   *  `tool_calls` on the terminal frame when this is > 0). */
  committed = 0;

  constructor(private hints: DsmlToolHint[]) {}

  get active(): boolean {
    return this.hints.length > 0;
  }

  feed(text: string): DsmlEmit[] {
    if (!this.active) return [{ text }];
    const out: DsmlEmit[] = [];
    if (!this.holding) {
      const s = this.scanTail + text;
      const m = MSTART.exec(s);
      if (!m) {
        const k = partialPrefixLen(s);
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
  flush(): DsmlEmit[] {
    const s = this.scanTail + this.hold;
    this.scanTail = "";
    this.hold = "";
    this.holding = false;
    if (!s) return [];
    if (!this.active) return [{ text: s }];
    return this.emit(extractDsmlToolCalls(s, this.hints));
  }

  private drain(): DsmlEmit[] {
    const out: DsmlEmit[] = [];
    for (;;) {
      if (this.hold.length > MAX_HOLD) {
        // Forced release: complete candidates commit, the rest restores
        // verbatim — then scanning continues on the following text.
        const r = extractDsmlToolCalls(this.hold, this.hints);
        this.hold = "";
        this.holding = false;
        out.push(...this.emit(r));
        return out;
      }
      const cut = findReleaseCut(this.hold);
      if (cut <= 0) break;
      const blob = this.hold.slice(0, cut);
      this.hold = this.hold.slice(cut);
      out.push(...this.emit(extractDsmlToolCalls(blob, this.hints)));
    }
    return out;
  }

  private emit(r: DsmlExtractResult): DsmlEmit[] {
    const out: DsmlEmit[] = [];
    if (r.text) out.push({ text: r.text });
    for (const c of r.calls) {
      this.committed++;
      out.push({ call: { id: c.id, name: c.name, argsJson: JSON.stringify(c.input), index: this.nextIndex++ } });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// buffered raw-body patching (same-protocol pass-through)
// ---------------------------------------------------------------------------

/**
 * Patch a raw buffered upstream body (any protocol) in place: DSML recovered
 * into native tool calls, orphan closers absorbed. Returns the new body text
 * or null when nothing changed — untouched bodies keep their exact bytes.
 */
export function patchRawResponseDsml(
  proto: "openai" | "anthropic" | "responses",
  respText: string,
  hints: DsmlToolHint[],
): string | null {
  if (!hints.length || !MSTART.test(respText)) return null;
  let j: unknown;
  try {
    j = JSON.parse(respText);
  } catch {
    return null;
  }
  const root = asRecord(j);
  if (!Object.keys(root).length) return null;

  let changed = false;
  const patchStr = (s: string, calls: DsmlRecoveredCall[]): string => {
    const r = extractDsmlToolCalls(s, hints);
    if (!r.changed) return s;
    changed = true;
    calls.push(...r.calls);
    return r.text;
  };

  if (proto === "openai") {
    for (const ch of asArr(root.choices)) {
      const choice = asRecord(ch);
      const msg = asRecord(choice.message);
      const calls: DsmlRecoveredCall[] = [];
      if (typeof msg.content === "string") {
        msg.content = patchStr(msg.content, calls);
      } else if (Array.isArray(msg.content)) {
        msg.content = asArr(msg.content)
          .map((part) => {
            const pr = asRecord(part);
            if (typeof pr.text !== "string") return part;
            const t = patchStr(pr.text, calls);
            if (t === pr.text) return part;
            return t === "" ? null : { ...pr, text: t };
          })
          .filter((part): part is Record<string, unknown> => part !== null);
      }
      if (calls.length) {
        msg.tool_calls = [
          ...asArr(msg.tool_calls),
          ...calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })),
        ];
        if (msg.content === "") msg.content = null;
        if (choice.finish_reason === "stop") choice.finish_reason = "tool_calls";
      }
    }
  } else if (proto === "anthropic") {
    const calls: DsmlRecoveredCall[] = [];
    const out: unknown[] = [];
    for (const b of asArr(root.content)) {
      const block = asRecord(b);
      if (block.type === "text" && typeof block.text === "string") {
        const t = patchStr(block.text, calls);
        if (t !== block.text) {
          if (t !== "") out.push({ ...block, text: t });
          continue;
        }
      }
      out.push(b);
    }
    if (calls.length) {
      for (const c of calls) out.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      if (root.stop_reason === "end_turn") root.stop_reason = "tool_use";
    }
    if (changed) root.content = out;
  } else {
    const calls: DsmlRecoveredCall[] = [];
    const out: unknown[] = [];
    for (const item of asArr(root.output)) {
      const r = asRecord(item);
      if (r.type === "message") {
        let touched = false;
        const parts = asArr(r.content).map((p) => {
          const pr = asRecord(p);
          if (typeof pr.text !== "string") return p;
          const t = patchStr(pr.text, calls);
          if (t === pr.text) return p;
          touched = true;
          return { ...pr, text: t };
        });
        out.push(touched ? { ...r, content: parts } : item);
        continue;
      }
      out.push(item);
    }
    if (typeof root.output_text === "string") root.output_text = patchStr(root.output_text, calls);
    if (calls.length) {
      for (const c of calls) {
        out.push({ type: "function_call", id: c.id, call_id: c.id, name: c.name, arguments: JSON.stringify(c.input), status: "completed" });
      }
    }
    if (changed) root.output = out;
  }

  return changed ? JSON.stringify(root) : null;
}
