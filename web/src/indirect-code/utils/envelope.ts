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
    if (key === "type") type = val === "error" ? "error" : "ok";
    else if (key) attrs[key] = val;
  }
  const end = text.indexOf(CLOSE, i);
  if (end < 0) return null;
  return { type, attrs, body: unescapeBody(text.slice(i, end)) };
}

/** Human-readable footer line for the facts the UI shows (exit/status/
 * duration/…). Empty when there is nothing worth showing. */
function envelopeFooter(e: ToolEnvelope): string {
  const parts: string[] = [];
  const a = e.attrs;
  if (a.exit !== undefined) parts.push(`[exit ${a.exit}]`);
  else if (a.status) parts.push(`[${a.status}]`);
  if (a.duration) parts.push(`Took ${a.duration}`);
  if (a.truncated === "true" && a.page) parts.push(`[${a.page} truncated]`);
  else if (a.page) parts.push(`[${a.page}]`);
  if (a.next) parts.push(`[more lines: offset ${a.next}]`);
  if (a.info) parts.push(`[${a.info}]`);
  return parts.join("  ");
}

/**
 * Strip the envelope for human display: returns the body plus a footer line
 * of the notable facts. Legacy text (no envelope) is returned unchanged.
 */
export function stripToolEnvelope(text: string): string {
  const e = parseToolEnvelope(text);
  if (!e) return text;
  const footer = envelopeFooter(e);
  if (!footer) return e.body;
  return e.body ? `${e.body}\n\n${footer}` : footer;
}

/** Strip for display but keep the envelope facts (for UI labels). */
export function stripToolEnvelopeDetailed(text: string): {
  body: string;
  attrs: Record<string, string>;
} {
  const e = parseToolEnvelope(text);
  if (!e) return { body: text, attrs: {} };
  const footer = envelopeFooter(e);
  return {
    body: footer ? (e.body ? `${e.body}\n\n${footer}` : footer) : e.body,
    attrs: e.attrs,
  };
}

/** The envelope facts as a plain record ({} for legacy text). */
export function toolEnvelopeAttrs(text: string): Record<string, string> {
  return parseToolEnvelope(text)?.attrs ?? {};
}