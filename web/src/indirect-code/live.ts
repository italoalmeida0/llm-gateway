import type { ChatMessage, ContentBlock } from "./types";

// Read complete characters from a streamed JSON string without guessing a
// missing escape or displaying the raw JSON around the tool's file content.
function partialString(raw: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let i = start + 1;
  for (; i < raw.length; i++) {
    if (raw[i] === '"') { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return undefined; } }
    if (raw[i] === "\\") {
      if (i + 1 >= raw.length) break;
      if (raw[i + 1] === "u") { if (!/^[0-9a-f]{4}$/i.test(raw.slice(i + 2, i + 6))) break; i += 5; }
      else i++;
    }
  }
  try { return JSON.parse(raw.slice(start, i) + '"'); } catch { return undefined; }
}

export function displayToolArgs(raw?: string): Record<string, any> {
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { /* incomplete argument stream */ }
  const values: Record<string, any> = { _raw: raw };
  for (const field of ["path", "command", "content", "pattern", "oldText", "newText"]) {
    const text = partialString(raw, field);
    if (text !== undefined) values[field] = text;
  }
  if (values.oldText !== undefined || values.newText !== undefined) values.edits = [{oldText:values.oldText || "", newText:values.newText || ""}];
  return values;
}
export const SIGNAL_TOOL_NAMES = new Set(["todo", "mark_task_as_complete", "mark_plan_as_ready_to_execute", "summary"]);
export const COMPLETION_TOOL_NAMES = new Set(["mark_task_as_complete", "mark_plan_as_ready_to_execute"]);

/** Detects synthetic system prompt nudges. Transcript-real (sent to the provider)
 * but never shown as a user bubble in the chat UI. */
export function isSyntheticNudge(text: string): boolean {
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")) ||
    (trimmed.startsWith("<system_prompt>") && trimmed.endsWith("</system_prompt>")) ||
    (trimmed.startsWith("<system-warn>") && trimmed.endsWith("</system-warn>"))
  );
}

export function sanitizeUserText(text: string): string {
  let res = text;
  for (const tag of ["system-reminder", "system_prompt", "system-warn"]) {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const trimmed = res.trim();
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      res = trimmed.slice(open.length, -close.length).trim();
    } else if (res.includes(open) || res.includes(close)) {
      res = res.replaceAll(open, "").replaceAll(close, "").trim();
    }
  }
  return res;
}

/** Strips a leading <system-reminder>...</system-reminder>, <system_prompt>...</system_prompt>,
 * or <system-warn>...</system-warn> block from a user message so the chat UI displays only the user's actual text. */
export function stripLeadingSystemPrompt(text: string): string {
  const trimmed = text.trim();
  for (const tag of ["<system-reminder>", "<system_prompt>", "<system-warn>"]) {
    const closeTag = tag.replace("<", "</");
    if (trimmed.startsWith(tag)) {
      const endIdx = trimmed.indexOf(closeTag);
      if (endIdx !== -1) {
        return trimmed.slice(endIdx + closeTag.length).trim();
      }
    }
  }
  return text;
}

export function withoutContinueNudges(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => {
    if (m.role !== "user") return true;
    const text = m.blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return !isSyntheticNudge(text);
  });
}
/** Keep canonical messages untouched; signal tools (todo checklist, mark_task_as_complete, mark_plan_as_ready_to_execute, summary) are hidden or extracted as text. */
export function withoutTodoActivity(messages: ChatMessage[]): ChatMessage[] {
  const signalResults = new Map<string, ContentBlock>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_result" && block.toolId) {
        signalResults.set(block.toolId, block);
      }
    }
  }
  const ids = new Set(
    messages.flatMap((m) =>
      m.blocks
        .filter((b) => b.type === "tool_call" && b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName))
        .map((b) => b.toolId)
    )
  );
  return messages.flatMap((message) => {
    let hadCompletion = message.hasCompletion || false;
    let hadSummary = message.hasSummary || false;
    let mutated = false;
    const newBlocks: ContentBlock[] = [];
    for (const b of message.blocks) {
      if (b.type === "tool_call" && b.toolName && COMPLETION_TOOL_NAMES.has(b.toolName)) {
        const result = b.toolId ? signalResults.get(b.toolId) : undefined;
        if (!result || result.isError) {
          // Keep pending/failed completion calls visible. They must not look
          // like a successful turn, and their result carries the diagnostic.
          newBlocks.push(b);
          continue;
        }
        hadCompletion = true;
        mutated = true;
        let summaryText = "";
        try {
          const parsed = JSON.parse(b.toolArgs || "{}");
          const candidate = parsed?.comprehensive_summary || parsed?.summary || parsed?.notes;
          summaryText = typeof candidate === "string" ? candidate : "";
        } catch {}
        if (summaryText.trim()) {
          if (!newBlocks.some((existing) => existing.type === "text" && existing.text?.trim() === summaryText.trim()) &&
            !message.blocks.some((existing) => existing.type === "text" && existing.text?.trim() === summaryText.trim())) {
            newBlocks.push({ type: "text", text: summaryText.trim() });
          }
        }
        continue;
      }
      if (b.type === "tool_call" && b.toolName === "summary") {
        const result = b.toolId ? signalResults.get(b.toolId) : undefined;
        if (!result || result.isError) {
          // A progress update is user-visible only after the tool accepted it.
          newBlocks.push(b);
          continue;
        }
        hadSummary = true;
        mutated = true;
        let forUser = "";
        try {
          const parsed = JSON.parse(b.toolArgs || "{}");
          forUser = typeof parsed?.for_user === "string" ? parsed.for_user : "";
        } catch {}
        if (forUser.trim()) {
          if (!newBlocks.some((existing) => existing.type === "text" && existing.text?.trim() === forUser.trim()) &&
            !message.blocks.some((existing) => existing.type === "text" && existing.text?.trim() === forUser.trim())) {
            newBlocks.push({ type: "text", text: forUser.trim() });
          }
        }
        continue;
      }
      if (
        (b.type === "tool_call" || b.type === "tool_result") &&
        ((b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName)) || (b.toolId && ids.has(b.toolId)))
      ) {
        if (b.type === "tool_result" && b.isError) {
          newBlocks.push(b);
          continue;
        }
        mutated = true;
        continue;
      }
      newBlocks.push(b);
    }
    if (!mutated) return [message];
    if (newBlocks.length === 0 && message.blocks.length > 0) return [];
    if (newBlocks.every((b) => b.type === "text" && !b.text?.trim())) return [];
    return [{ ...message, blocks: newBlocks, hasCompletion: hadCompletion, hasSummary: hadSummary }];
  });
}
