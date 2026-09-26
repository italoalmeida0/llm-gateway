/**
 * Per-model tool-call strategy.
 *
 * Some upstreams serve models whose native function calling is unreliable
 * through OpenAI-compatible stacks: calls come back as MARKUP in assistant
 * content (or are dropped). The gateway can recover that markup (see
 * server/proxy/markup-tools.ts and server/proxy/own-tools.ts) and, for the
 * worst offenders, actively move the tool schema into an in-band instruction
 * instead of the native `tools` array.
 *
 * This module is deliberately dependency-free so the registry (models.ts),
 * the admin API and the proxy can all share the vocabulary without an
 * import cycle.
 *
 *   - `native`: everything off. Native `tools` are forwarded untouched and
 *     markup recovery is disabled.
 *   - `fallback` (default): PASSIVE. Native `tools` are still forwarded, but
 *     markup found in the response is recovered from every supported dialect
 *     (xiaomi XML, MiniMax `<invoke>`, Hermes/Qwen JSON, DSML). Use it when a
 *     model sometimes leaks markup even with native calling on.
 *   - `workaround`: ACTIVE. Native `tools` are stripped and the schema is
 *     re-delivered as an in-band instruction teaching the xiaomi XML format;
 *     the response is recovered from every dialect. Auto-selected for models
 *     whose id contains "xiaomi".
 *   - `own`: ACTIVE, like `workaround`, but teaches a DIFFERENT format: a
 *     single JSON object inside a fenced ```tool_call code block. Providers
 *     that recognize and rewrite the common `<tool_call>` markup (OpenAI's
 *     own stack) leave a fenced block alone, so this is the safest workaround
 *     behind such a stack. Recovery still accepts every dialect.
 *
 * Native `tool_calls` are ALWAYS accepted in every mode: recovery only ADDS
 * calls found in content, it never removes native ones.
 */

export type ToolCallMode = "native" | "fallback" | "workaround" | "own";

export const TOOL_CALL_MODES: readonly ToolCallMode[] = ["native", "fallback", "workaround", "own"];

export function normalizeToolCallMode(v: unknown): ToolCallMode {
  return v === "fallback" || v === "workaround" || v === "own" ? v : "native";
}

/** True when the mode recovers markup calls from the response. */
export function isMarkupMode(mode: ToolCallMode): boolean {
  return mode !== "native";
}

/** True when the mode strips native tools and injects an in-band instruction. */
export function isInstructionMode(mode: ToolCallMode): boolean {
  return mode === "workaround" || mode === "own";
}

/** Auto default for an unregistered model: MiMo ids get the active
 *  workaround, the rest stay passive `fallback`. */
export function defaultToolCallModeFor(id: unknown): ToolCallMode {
  return typeof id === "string" && /xiaomi/i.test(id) ? "workaround" : "fallback";
}

/**
 * Effective mode for a request: an explicit registry row wins; otherwise fall
 * back to id-based auto-detection over the public and upstream ids (so a
 * MiMo served under a name without "xiaomi" is still covered when the
 * upstream id carries it). Unknown ids default to `fallback`.
 */
export function resolveToolCallMode(
  rowMode: string | null | undefined,
  ...ids: Array<string | null | undefined>
): ToolCallMode {
  if (rowMode !== null && rowMode !== undefined) return normalizeToolCallMode(rowMode);
  for (const id of ids) {
    if (typeof id === "string" && /xiaomi/i.test(id)) return "workaround";
  }
  return "fallback";
}
