/**
 * Shared tool-call recovery contract.
 *
 * Some upstreams emit tool calls as MARKUP in assistant content instead of
 * native `tool_calls`. The gateway recovers them at the response edge, and
 * the exact markup dialect depends on the TARGET (model family), not the
 * protocol:
 *
 *   - DeepSeek V4/V4.1 wrap calls in DSML (`<｜DSML｜tool_calls>…`) — see dsml.ts;
 *   - Xiaomi MiMo emit an XML envelope (`<tool_call><function=…>…`) — see
 *     xiaomi.ts.
 *
 * Both dialects share the same three-edge wiring (stream deltas, translated
 * buffered bodies, same-protocol raw bodies) and the same conservative
 * rules (a candidate must CLOSE, names must match a declared tool, rejected
 * candidates restore byte-verbatim). This module is the single interface the
 * proxy edge talks to, so adding dialect N+1 means one factory, never a new
 * branch at every response edge.
 */

/** One recovered call, shaped like a native OpenAI tool call. */
export interface RecoveredCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RecoverResult {
  /** Text with committed regions removed (markup stripped). */
  text: string;
  calls: RecoveredCall[];
  /** True when the text differs from the input (calls and/or debris). */
  changed: boolean;
}

/** Wire protocol of a response body being patched. */
export type RecoverProto = "openai" | "anthropic" | "responses";

/** One stream-side emit: either visible text or a committed call. */
export type StreamEmit =
  | { text: string }
  | { call: { id: string; name: string; argsJson: string; index: number } };

/** Incremental (SSE) recovery: text streams through, the marker tail is
 *  held until the block closes or the stream ends (never partially emitted). */
export interface StreamRecoverer {
  readonly active: boolean;
  /** Committed calls so far — the translator upgrades a plain `stop` finish
   *  to `tool_calls` when this is > 0. */
  readonly committed: number;
  feed(text: string): StreamEmit[];
  flush(): StreamEmit[];
}

/** Per-target recovery implementation. `active` is false when the request
 *  declared no tools — markup in a no-tools completion is content, not a
 *  call, and must survive byte-for-byte. */
export interface ToolRecoverer {
  readonly active: boolean;
  extract(text: string): RecoverResult;
  /** Patch a raw buffered body in place; null when nothing changed. */
  patchRaw(proto: RecoverProto, respText: string): string | null;
  stream(): StreamRecoverer;
}
