import type { ContentBlock } from "../types";

export function prettyArgs(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function toolResultText(c: any): string {
  const content = c.content ?? c.result;
  if (typeof content === "string") return content;
  const partText = (p: any): string => {
    if (typeof p === "string") return p;
    if (typeof p?.text === "string") return p.text;
    if (p && typeof p.mime_type === "string") {
      return `[image${p.mime_type ? ` ${p.mime_type}` : ""}]`;
    }
    return prettyArgs(p);
  };
  if (Array.isArray(content)) {
    return content.map(partText).join("\n");
  }
  return prettyArgs(content);
}

export function parseToolDetails(d: any): any {
  if (d == null) return undefined;
  if (typeof d === "object") return d;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseContentBlocks(m: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const pushBlock = (c: any) => {
    if (c == null) return;
    if (typeof c === "string") {
      blocks.push({ type: "text", text: c });
      return;
    }
    // Reasoning / thinking (Go ReasoningBlock has no `type`).
    if (
      c.type === "reasoning" ||
      c.type === "thinking" ||
      typeof c.summary === "string" ||
      typeof c.reasoning_id === "string" ||
      typeof c.encrypted_content === "string"
    ) {
      // Encrypted-only blobs (redacted_thinking) have no readable text and
      // stay in daemon history for replay — nothing to display.
      if (typeof c.encrypted_content === "string" && !c.summary && !c.thinking && !c.reasoning && !c.text && !c.reasoning_id) {
        return;
      }
      const txt = c.summary || c.thinking || c.reasoning || c.text || "";
      if (txt || typeof c.reasoning_id === "string" || typeof c.encrypted_content === "string") {
        blocks.push({ type: "reasoning", reasoning: txt });
      }
      return;
    }
    // Tool call: Anthropic {type:"tool_use",id,name,input} or Go {id,name,arguments}.
    if (c.type === "tool_use" || (typeof c.name === "string" && typeof c.id === "string")) {
      blocks.push({
        type: "tool_call",
        toolId: c.id,
        toolName: c.name,
        toolArgs: prettyArgs(c.input ?? c.arguments ?? c.args),
      });
      return;
    }
    // Tool result: Anthropic {type:"tool_result",tool_use_id/content/is_error}
    // or Go {call_id, content:[{text}], is_error} or flat {id,result,isError}.
    if (
      c.type === "tool_result" ||
      typeof c.call_id === "string" ||
      (typeof c.tool_use_id === "string" && c.content !== undefined)
    ) {
      blocks.push({
        type: "tool_result",
        toolId: c.tool_use_id || c.call_id || c.id,
        toolResult: toolResultText(c),
        toolStartedAt:c.started_at, toolDurationMs:c.started_at ? (c.duration_ms || 0) : undefined,
        isError: !!(c.is_error ?? c.isError ?? c.is_error === true),
        toolDetails: parseToolDetails(c.details),
      });
      return;
    }
    // Image (Go ImageBlock {mime_type, data}) — render the real bytes.
    if (typeof c.mime_type === "string" || c.type === "image") {
      blocks.push({
        type: "image",
        text: c.mime_type || "image",
        imageMime: c.mime_type,
        imageData: typeof c.data === "string" ? c.data : undefined,
      });
      return;
    }
    // Plain text (both dialects).
    if (c.type === "text" || typeof c.text === "string") {
      blocks.push({ type: "text", text: c.text });
      return;
    }
  };
  if (Array.isArray(m.content)) {
    for (const c of m.content) pushBlock(c);
  } else if (typeof m.content === "string") {
    blocks.push({ type: "text", text: m.content });
  }
  return blocks;
}
