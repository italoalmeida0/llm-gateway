import type { ChatMessage } from "./types";

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
export const SIGNAL_TOOL_NAMES = new Set(["todo", "mark_task_as_complete", "mark_plan_as_ready_to_execute"]);
export const COMPLETION_TOOL_NAMES = new Set(["mark_task_as_complete", "mark_plan_as_ready_to_execute"]);

/** Detects synthetic system prompt nudges. Transcript-real (sent to the provider)
 * but never shown as a user bubble in the chat UI. */
export function isSyntheticNudge(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>");
}

export function sanitizeUserText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("<system-reminder>") && trimmed.endsWith("</system-reminder>")) {
    return trimmed.slice("<system-reminder>".length, -"</system-reminder>".length).trim();
  }
  if (text.includes("<system-reminder>") || text.includes("</system-reminder>")) {
    return text.replaceAll("<system-reminder>", "").replaceAll("</system-reminder>", "").trim();
  }
  return text;
}

/** Strips a leading <system-reminder>...</system-reminder> block (such as date or mode directives)
 * from a user message so the chat UI displays only the user's actual text. */
export function stripLeadingSystemPrompt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("<system-reminder>")) {
    const endIdx = trimmed.indexOf("</system-reminder>");
    if (endIdx !== -1) {
      return trimmed.slice(endIdx + "</system-reminder>".length).trim();
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
/** Keep canonical messages untouched; signal tools (todo checklist, mark_task_as_complete, mark_plan_as_ready_to_execute) are hidden like TODO activity. */
export function withoutTodoActivity(messages: ChatMessage[]): ChatMessage[] {
  const ids = new Set(
    messages.flatMap((m) =>
      m.blocks
        .filter((b) => b.type === "tool_call" && b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName))
        .map((b) => b.toolId)
    )
  );
  return messages.flatMap((message) => {
    const hadCompletion = message.blocks.some(
      (b) => b.type === "tool_call" && b.toolName && COMPLETION_TOOL_NAMES.has(b.toolName)
    );
    const blocks = message.blocks.filter(
      (b) =>
        !(
          (b.type === "tool_call" || b.type === "tool_result") &&
          ((b.toolName && SIGNAL_TOOL_NAMES.has(b.toolName)) || (b.toolId && ids.has(b.toolId)))
        )
    );
    if (blocks.length === message.blocks.length) return [message];
    if (blocks.every((b) => b.type === "text" && !b.text?.trim())) return [];
    return [{ ...message, blocks, hasCompletion: hadCompletion || message.hasCompletion }];
  });
}
