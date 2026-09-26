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
  /** Anti-duplicate guard: a native `tool_calls` delta arrived, so markup in
   *  the SAME message must not be recovered. Releases any held tail as plain
   *  text and makes every later feed() pass through untouched. */
  disable(): StreamEmit[];
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

/**
 * Pipeline several recoverers so a body is passed through each in order
 * (e.g. DSML + markup): the first strips what it recognizes, the next sees
 * the remainder. Idle recoverers are dropped; a single survivor is returned
 * as-is (no wrapper overhead).
 */
export function combineRecoverers(...rs: ToolRecoverer[]): ToolRecoverer {
  const list = rs.filter((r) => r.active);
  if (list.length === 1) return list[0]!;
  if (list.length === 0) {
    const idle = rs[0];
    return idle ?? { active: false, extract: (t) => ({ text: t, calls: [], changed: false }), patchRaw: () => null, stream: () => idleStream() };
  }
  return {
    active: true,
    extract(text: string): RecoverResult {
      let cur = text;
      let changed = false;
      const calls: RecoveredCall[] = [];
      for (const r of list) {
        const res = r.extract(cur);
        if (res.changed) {
          changed = true;
          cur = res.text;
          calls.push(...res.calls);
        }
      }
      return { text: cur, calls, changed };
    },
    patchRaw(proto: RecoverProto, respText: string): string | null {
      let cur = respText;
      let changed = false;
      for (const r of list) {
        const out = r.patchRaw(proto, cur);
        if (out !== null) {
          cur = out;
          changed = true;
        }
      }
      return changed ? cur : null;
    },
    stream: () => combineStreams(list.map((r) => r.stream())),
  };
}

function idleStream(): StreamRecoverer {
  return {
    active: false,
    committed: 0,
    feed: (text) => [{ text }],
    flush: () => [],
    disable: () => [],
  };
}

/**
 * Chain stream recoverers: text flows through each in order (a recoverer's
 * emitted text feeds the next), so each holds its own marker tail and a
 * committed call from either is emitted once. `committed` sums the stages so
 * the translator can upgrade a plain `stop` finish to `tool_calls`.
 */
export function combineStreams(streams: StreamRecoverer[]): StreamRecoverer {
  const list = streams.filter((s) => s.active);
  if (list.length === 1) return list[0]!;
  if (list.length === 0) return idleStream();
  const route = (emits: StreamEmit[], from: number): StreamEmit[] => {
    let cur = emits;
    for (let j = from; j < list.length; j++) {
      const next: StreamEmit[] = [];
      for (const e of cur) {
        if ("text" in e) next.push(...list[j]!.feed(e.text));
        else next.push(e);
      }
      cur = next;
    }
    return cur;
  };
  return {
    active: true,
    get committed() {
      return list.reduce((n, s) => n + s.committed, 0);
    },
    feed: (text) => route([{ text }], 0),
    flush: () => {
      const out: StreamEmit[] = [];
      for (let i = 0; i < list.length; i++) out.push(...route(list[i]!.flush(), i + 1));
      return out;
    },
    disable: () => {
      // Disable EVERY stage first, then release each held tail, so an
      // upstream tail can never be re-recovered by a not-yet-disabled stage.
      const releases = list.map((s) => s.disable());
      const out: StreamEmit[] = [];
      for (let i = 0; i < releases.length; i++) out.push(...route(releases[i]!, i + 1));
      return out;
    },
  };
}
