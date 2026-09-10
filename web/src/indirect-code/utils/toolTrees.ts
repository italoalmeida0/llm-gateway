/** Pure parsers for the transcript mini-UIs (question/inspect/glob).
 * Framework-free so bun:test can cover them directly. */

export interface QAOption {
  label: string;
  description?: string;
}

export interface QAItem {
  header: string;
  question: string;
  options: QAOption[];
  multiple: boolean;
  /** Selected labels (custom answers included), in question order. */
  answers: string[];
}

function asQArray(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if ((t.startsWith("[") || t.startsWith("{")) && t.length > 1) {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return p;
        if (p && typeof p === "object") return [p];
      } catch {
        return [{ question: t }];
      }
    }
    return [{ question: t }];
  }
  if (typeof raw === "object") {
    if (Array.isArray((raw as any).questions)) return (raw as any).questions;
    if (Array.isArray((raw as any).question)) return (raw as any).question;
    return [raw];
  }
  return [];
}

function normQ(q: any): { header: string; question: string; options: QAOption[]; multiple: boolean } {
  if (typeof q === "string") return { header: "", question: q, options: [], multiple: false };
  const o = q && typeof q === "object" ? q : {};
  const opts = Array.isArray(o.options)
    ? o.options
        .map((x: any) => (typeof x === "string" ? { label: x } : { label: String(x?.label ?? ""), description: x?.description ? String(x.description) : undefined }))
        .filter((x: QAOption) => x.label)
    : [];
  return {
    header: typeof o.header === "string" ? o.header : "",
    question: typeof o.question === "string" ? o.question : "",
    options: opts,
    multiple: o.multiple === true,
  };
}

function asAnswers(details: any, resultText: string, n: number): string[][] {
  let raw: any = details && Array.isArray((details as any).answers) ? (details as any).answers : undefined;
  if (raw === undefined && resultText) {
    try {
      const p = JSON.parse(resultText);
      if (p && Array.isArray(p.answers)) raw = p.answers;
    } catch {
      /* not JSON — unanswered */
    }
  }
  const out: string[][] = [];
  for (let i = 0; i < n; i++) {
    const a = Array.isArray(raw) ? raw[i] : undefined;
    out.push(Array.isArray(a) ? a.map(String) : []);
  }
  return out;
}

/** Join daemon question args with the recorded answers (question order). */
export function parseQuestionQA(args: any, resultText: string, details: any): QAItem[] {
  const qs = asQArray(args?.questions ?? args?.question).map(normQ);
  const answers = asAnswers(details, resultText || "", qs.length);
  return qs.map((q, i) => ({ ...q, answers: answers[i] }));
}

export interface InspectEntry {
  depth: number;
  name: string;
  isDir: boolean;
  /** Git flag as printed: M, A, D, R, ??, • or "". */
  flag: string;
  size?: string;
  lines?: number;
}

export interface InspectTree {
  /** Scope as printed in the header ("" for single-file results). */
  scope: string;
  count: number;
  capped?: number;
  entries: InspectEntry[];
}

const inspectMeta = /^([^,()]+?)(?:,\s*(\d+)\s*lines?)?$/;

function parseEntryLine(line: string, forceDepthZero: boolean): InspectEntry | null {
  const m = line.match(/^( *)(?:\[([^\]]*)\] ?)?(.*)$/);
  if (!m) return null;
  const leading = m[1].length;
  const hasFlag = m[2] !== undefined;
  const rest = m[3].trim();
  if (!rest) return null;
  // Daemon prints indent BEFORE the flag; an empty flag still occupies 4
  // columns ("    "). Single-file results carry no indent at all.
  const depth = forceDepthZero ? 0 : hasFlag ? Math.floor(leading / 2) : Math.max(0, Math.floor((leading - 4) / 2));
  const b = rest.match(/^(.*?)(\/)?(?: \((.*)\))?$/);
  if (!b) return null;
  const name = b[1].trim();
  if (!name) return null;
  const entry: InspectEntry = {
    depth,
    name,
    isDir: b[2] === "/",
    flag: (m[2] || "").trim(),
  };
  if (b[3] !== undefined) {
    const mm = b[3].trim().match(inspectMeta);
    if (mm) {
      entry.size = mm[1].trim();
      if (mm[2] !== undefined) entry.lines = parseInt(mm[2], 10);
    } else {
      entry.size = b[3].trim();
    }
  }
  return entry;
}

/** Parse the AI-visible inspect tree text. Null when unparseable. */
export function parseInspectTree(raw: string): InspectTree | null {
  const text = (raw || "").replace(/\n+$/, "");
  if (!text) return null;
  const lines = text.split("\n");
  const head = lines[0].match(/^(.*) \((\d+) entr(?:y|ies)(.*)\)$/);
  if (head) {
    const cap = head[3].match(/capped at (\d+)/);
    const entries: InspectEntry[] = [];
    for (const ln of lines.slice(1)) {
      if (!ln.trim()) continue;
      const e = parseEntryLine(ln, false);
      if (e) entries.push(e);
    }
    if (entries.length === 0) return null;
    return {
      scope: head[1],
      count: parseInt(head[2], 10),
      capped: cap ? parseInt(cap[1], 10) : undefined,
      entries,
    };
  }
  // Single-file form: one line with a size meta, no header.
  if (lines.length === 1) {
    const e = parseEntryLine(lines[0], true);
    if (!e || e.size === undefined) return null;
    return { scope: "", count: 1, entries: [e] };
  }
  return null;
}

export interface GlobList {
  none: boolean;
  files: string[];
  truncated: boolean;
}

/** Parse the AI-visible glob result text. Null when unparseable. */
export function parseGlobList(raw: string): GlobList | null {
  const text = (raw || "").trim();
  if (!text) return null;
  if (text === "No files matched the pattern.") return { none: true, files: [], truncated: false };
  const lines = text.split("\n");
  let truncated = false;
  const last = lines[lines.length - 1].trim();
  if (/^\(Truncated: showing first \d+ matches\)$/.test(last)) {
    truncated = true;
    lines.pop();
  }
  const files = lines.map((l) => l.trim()).filter(Boolean);
  if (files.length === 0) return null;
  if (files.some((f) => f.includes("\n") || f.startsWith("("))) return null;
  return { none: false, files, truncated };
}
