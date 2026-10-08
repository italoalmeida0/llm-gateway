/**
 * Pseudo-XML tool-result envelope (mirror of the daemon's
 * packages/core/envelope.go). The daemon wraps every tool result as:
 *
 *   <tool_result type="ok" exit="0">pure tool output</tool_result>
 *   <tool_result type="error">permission denied: …</tool_result>
 *
 * The body is ONLY tool content; system metadata lives in attributes
 * (exit, status, page, next, truncated, job_id, info, ...). The frontend
 * strips the envelope for display and surfaces the facts as a footer line,
 * so the human transcript never shows raw XML.
 */

export type ToolEnvelope = {
  type: "ok" | "error";
  attrs: Record<string, string>;
  body: string;
};

const OPEN = "<tool_result";
const CLOSE = "</tool_result>";

function unescapeAttr(v: string): string {
  return v
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function unescapeBody(s: string): string {
  return s.replace(/&lt;\/tool_result/g, "</tool_result").replace(/&lt;tool_result/g, "<tool_result");
}

/** Parse one envelope. Returns null when text is not an envelope (legacy
 * transcripts predate the format and pass through unchanged). */
export function parseToolEnvelope(text: string): ToolEnvelope | null {
  if (typeof text !== "string" || !text.startsWith(OPEN)) return null;
  let i = OPEN.length;
  let type: ToolEnvelope["type"] = "ok";
  const attrs: Record<string, string> = {};
  while (i < text.length) {
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (i < text.length && text[i] === ">") {
      i++;
      break;
    }
    const keyStart = i;
    while (i < text.length && text[i] !== "=" && text[i] !== " " && text[i] !== ">") i++;
    const key = text.slice(keyStart, i);
    if (i >= text.length || text[i] !== "=" || text[i + 1] !== '"') return null;
    i += 2;
    const valStart = i;
    while (i < text.length && text[i] !== '"') i++;
    if (i >= text.length) return null;
    const val = unescapeAttr(text.slice(valStart, i));
    i++;
    // Unknown attributes (duration, started_at, ...) are kept for toolDetails
    // but never break parsing: a stray attr must not leak the envelope text
    // into the rendered body.
    if (key === "type") type = val === "error" ? "error" : "ok";
    else if (key) attrs[key] = val;
  }
  const end = text.indexOf(CLOSE, i);
  if (end < 0) return null;
  return { type, attrs, body: unescapeBody(text.slice(i, end)) };
}

/** One fact about the tool call (exit code, page range, …) for the footer. */
export interface FooterFact {
  label: string;
  tone?: "ok" | "fail" | "muted";
}

/** Structured footer facts for the facts the UI shows (exit/status/
 * duration/…). Empty when there is nothing worth showing. */
export function footerFromAttrs(a: Record<string, string>): FooterFact[] {
  const parts: FooterFact[] = [];
  if (a.exit !== undefined) parts.push({ label: `exit ${a.exit}`, tone: a.exit === "0" ? "muted" : "fail" });
  else if (a.status) parts.push({ label: a.status, tone: a.status === "running" ? "ok" : "muted" });
  if (a.duration) parts.push({ label: `Took ${a.duration}`, tone: "muted" });
  if (a.truncated === "true" && a.page) parts.push({ label: `${a.page} truncated`, tone: "muted" });
  else if (a.page) parts.push({ label: a.page, tone: "muted" });
  if (a.next) parts.push({ label: `more lines: offset ${a.next}`, tone: "muted" });
  if (a.info) parts.push({ label: a.info, tone: "muted" });
  return parts;
}

function envelopeFooter(e: ToolEnvelope): FooterFact[] {
  return footerFromAttrs(e.attrs);
}

/**
 * Strip the envelope for human display: returns the body plus a footer line
 * of the notable facts. Legacy text (no envelope) is returned unchanged.
 */
/** Strip for display but keep the envelope facts (for UI labels). */
export function stripToolEnvelopeDetailed(text: string): {
  body: string;
  attrs: Record<string, string>;
  footer: FooterFact[];
} {
  const e = parseToolEnvelope(text);
  if (!e) return { body: text, attrs: {}, footer: [] };
  return { body: e.body, attrs: e.attrs, footer: envelopeFooter(e) };
}

/** Body without a trailing footer line: the tool's own output only. Older
 * transcripts appended "[exit 0]  [page …]" to the body; that line is stripped
 * so it never renders as output. */
export function bodyWithoutFooter(text: string): string {
  // Only footer-shaped facts (exit/status/duration/page/…) are stripped: a
  // legitimate last output line like "[done]" must survive.
  const fact = String.raw`\[(?:exit \d+|running|ok|error|canceled|completed|Took [^\]]+|[\d.\-–/]+ truncated|[\d.\-–/]+|more lines: offset \d+|No output yet\.)\]`;
  const m = new RegExp(`(?:\\n|^)(${fact}(?:  ${fact})*)\\s*$`).exec(text);
  return m ? text.slice(0, m.index + (m.index > 0 ? 1 : 0)) : text;
}

/** Compact footer text (used by tests and legacy callers). */
export function footerText(facts: FooterFact[]): string {
  return facts.map((f) => `[${f.label}]`).join("  ");
}
