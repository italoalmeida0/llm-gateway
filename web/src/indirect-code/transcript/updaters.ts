import { parseContentBlocks, prettyArgs } from "../utils/wire";
import type { ChatMessage, ContentBlock, SessionUsage } from "../types";
import type { TurnActivity } from "../viewTypes";

/** Pure transcript reducers (extracted verbatim from RemoteCodePage,
 * with no Solid dependency — covered by tests). Each function receives the
 * previous list and returns the next; Solid hook/threading lives in useTranscript. */

/** Normalizes the raw daemon transcript into renderable bubbles: tool
 * results are hoisted onto the assistant carrier (with srcIdx for
 * edit/delete/regenerate ops); "tool" envelopes never become a bubble.
 * The daemon stamps `turnIndex` (session turn sequence) on every message;
 * it is metadata only, nothing renders from it. */
export function normalizeSessionMessages(rawMsgs: any[], previous: ChatMessage[] = []): ChatMessage[] {
  const out: ChatMessage[] = [];
  const byIndex = new Map(previous.filter((m) => m.srcIdx != null).map((m) => [m.srcIdx, m]));
  // Folds are client-side only (the server never sends detached rows): a
  // later full snapshot (turn end, fetch, reconnect) must not wipe the
  // folded result text back to the "still running" placeholder. Carry the
  // terminal fields forward by tool call id — job ids are unique per
  // detach, so a carried fold always belongs to the same logical call.
  const prevFolded = new Map<string, ContentBlock>();
  for (const m of previous) {
    for (const b of m.blocks || []) {
      if (b.type === "tool_result" && b.toolId && (b.toolDetails as any)?.detached) prevFolded.set(b.toolId, b);
    }
  }
  const carryFold = (b: ContentBlock): ContentBlock => {
    if (b.type !== "tool_result" || !b.toolId || (b.toolDetails as any)?.detached) return b;
    if (!(b.toolDetails as any)?.background_job_id) return b;
    const folded = prevFolded.get(b.toolId);
    if (!folded || !(folded.toolDetails as any)?.detached) return b;
    return {
      ...b,
      toolResult: folded.toolResult,
      toolDurationMs: folded.toolDurationMs ?? b.toolDurationMs,
      isError: folded.isError,
      toolDetails: { ...(b.toolDetails as any), detached: true, display: (folded.toolDetails as any)?.display },
    };
  };
  let carrier: ChatMessage | null = null;
  const ensureCarrier = (srcIdx: number, wire: any): ChatMessage => {
    if (!carrier || carrier.role !== "assistant") {
      carrier = {
        id: `tools_${srcIdx}`,
        role: "assistant",
        blocks: [],
        time: Date.now(),
        srcIdx,
        turnIndex: typeof wire?.turnIndex === "number" ? wire.turnIndex : undefined,
      };
      out.push(carrier);
    }
    return carrier;
  };
  (rawMsgs || []).forEach((m: any, idx: number) => {
    const blocks = parseContentBlocks(m);
    const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
    if (role === "assistant") {
      const reason: ContentBlock[] = [];
      const rest: ContentBlock[] = [];
      for (const b of blocks) (b.type === "reasoning" ? reason : rest).push(b);
      // Newest thoughts first: the turn's last reasoning stays at the top.
      reason.reverse();
      const msg: ChatMessage = {
        id: byIndex.get(idx)?.id ?? `msg_${idx}`,
        role,
        streaming: m.streaming === true,
        blocks: [...reason, ...rest.map(carryFold)],
        thinkingDuration: Number(m.meta?.thinking_ms) > 0 ? Math.max(1, Math.ceil(Number(m.meta.thinking_ms) / 1000)) : undefined,
        turnDurationMs: Number(m.meta?.turn_ms) > 0 ? Number(m.meta.turn_ms) : undefined,
        time: Date.now(),
        srcIdx: idx,
        turnIndex: typeof m.turnIndex === "number" ? m.turnIndex : undefined,
      };
      out.push(msg);
      carrier = msg;
      return;
    }
    // user / tool envelope: split tool results away from real content.
    const rest: ContentBlock[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") ensureCarrier(idx, m).blocks.push(carryFold(b));
      else rest.push(b);
    }
    if (role === "tool" || rest.length === 0) {
      // "tool" envelopes never become bubbles; a user envelope holding
      // only tool results must not render as an empty user bubble.
      if (rest.length > 0) ensureCarrier(idx, m).blocks.push(...rest);
      return;
    }
    if (typeof m.meta?.background_delivery === "string" && m.meta.background_delivery) {
      // Background completion notices (system-reminders, model-facing
      // only): never rendered, never a carrier — not even an empty one.
      return;
    }
    const isStart = m.isTurnStart !== undefined ? Boolean(m.isTurnStart) : !m.midTurn;
    const msg: ChatMessage = {
      id: byIndex.get(idx)?.id ?? `msg_${idx}`,
      role: "user",
      attachments: parseMessageAttachments(m),
      blocks: typeof m.meta?.user_text === "string" ? [{ type: "text", text: m.meta.user_text }] : rest,
      time: Date.now(),
      srcIdx: idx,
      isTurnStart: isStart,
      midTurn: Boolean(m.midTurn),
      turnIndex: typeof m.turnIndex === "number" ? m.turnIndex : undefined,
    };
    out.push(msg);
    carrier = msg;
  });
  return out;
}

/** Accumulates usage (cumulative wins) without losing previous buckets. */
export function mergeUsage(
  prev: Record<string, SessionUsage>,
  sessionId: string,
  u: any,
  cum: any,
): Record<string, SessionUsage> {
  if (!sessionId) return prev;
  const src = cum || u || {};
  return {
    ...prev,
    [sessionId]: {
      inTok: src.input_tokens ?? src.inTok ?? prev[sessionId]?.inTok ?? 0,
      outTok: src.output_tokens ?? src.outTok ?? prev[sessionId]?.outTok ?? 0,
      cacheTok:
        (src.cache_read_tokens ?? 0) + (src.cache_write_tokens ?? src.cache_creation_tokens ?? 0),
      reasoningTok: src.reasoning_tokens ?? prev[sessionId]?.reasoningTok ?? 0,
      costUsd: src.cost_usd ?? prev[sessionId]?.costUsd ?? 0,
      costInUsd: src.cost_input_usd ?? prev[sessionId]?.costInUsd ?? 0,
      costCacheUsd: src.cost_cache_usd ?? prev[sessionId]?.costCacheUsd ?? 0,
      costOutUsd: src.cost_output_usd ?? prev[sessionId]?.costOutUsd ?? 0,
    },
  };
}

/** Appends a text delta to the last text block of the active assistant. */
export function appendTextDelta(prev: ChatMessage[], delta: string): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant") {
    const blocks = [...last.blocks];
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && lastBlock.type === "text") {
      blocks[blocks.length - 1] = {
        ...lastBlock,
        text: (lastBlock.text || "") + delta,
      };
    } else {
      blocks.push({ type: "text", text: delta });
    }
    return [...prev.slice(0, -1), { ...last, blocks }];
  }
  return [
    ...prev,
    {
      id: `asst_${Date.now()}`,
      role: "assistant",
      turnIndex: last?.turnIndex,
      streaming: true,
      blocks: [{ type: "text", text: delta }],
      time: Date.now(),
    },
  ];
}

/** Appends a reasoning delta to the active assistant's thinking panel
 * (merges into the existing panel, which stays on top; new panel goes in front
 * so the live view matches the normalized refresh). */
export function appendReasoningDelta(prev: ChatMessage[], delta: string): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (last && last.role === "assistant") {
    const blocks = [...last.blocks];
    // Merge into the existing thinking panel; a fresh one goes in front
    // so the live view already matches the normalized refresh (top).
    const ri = blocks.findIndex((b) => b.type === "reasoning");
    if (ri >= 0) {
      const merged = {
        ...blocks[ri],
        reasoning: (blocks[ri].reasoning || "") + delta,
      };
      const next = [...blocks];
      // Keep the merged panel at the top so text never overtakes it.
      next.splice(ri, 1);
      next.unshift(merged);
      return [...prev.slice(0, -1), { ...last, blocks: next }];
    }
    return [
      ...prev.slice(0, -1),
      { ...last, blocks: [{ type: "reasoning", reasoning: delta }, ...blocks] },
    ];
  }
  return [
    ...prev,
    {
      id: `asst_${Date.now()}`,
      role: "assistant",
      turnIndex: last?.turnIndex,
      streaming: true,
      blocks: [{ type: "reasoning", reasoning: delta }],
      time: Date.now(),
    },
  ];
}

/** Upsert of tool_call: tool_use_start pre-creates the card, tool_call finalizes it. */
export function upsertToolCall(prev: ChatMessage[], callId: string, name: string, args: any): ChatMessage[] {
  const argsStr = prettyArgs(args);
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m.role !== "assistant") continue;
    const bi = m.blocks.findIndex(
      (b) => b.type === "tool_call" && b.toolId === callId,
    );
    if (bi >= 0) {
      const blocks = [...m.blocks];
      blocks[bi] = { ...blocks[bi], toolName: name || blocks[bi].toolName, toolArgs: argsStr || blocks[bi].toolArgs };
      return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
    }
    break;
  }
  const toolBlock: ContentBlock = {
    type: "tool_call",
    toolId: callId,
    toolName: name,
    toolArgs: argsStr,
  };

  const last = prev[prev.length - 1];
  if (last && last.role === "assistant") {
    return [
      ...prev.slice(0, -1),
      { ...last, blocks: [...last.blocks, toolBlock] },
    ];
  }
  return [
    ...prev,
    {
      id: `asst_${Date.now()}`,
      role: "assistant",
      turnIndex: last?.turnIndex,
      streaming: true,
      blocks: [toolBlock],
      time: Date.now(),
    },
  ];
}

/** Appends streaming args to the existing tool_call (without card: no-op). */
export function appendToolArgsDelta(prev: ChatMessage[], callId: string, delta: string): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const m = prev[i];
    if (m.role !== "assistant") continue;
    const bi = m.blocks.findIndex(
      (b) => b.type === "tool_call" && b.toolId === callId,
    );
    if (bi >= 0) {
      const blocks = [...m.blocks];
      blocks[bi] = { ...blocks[bi], toolArgs: (blocks[bi].toolArgs || "") + delta };
      return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
    }
    break;
  }
  return prev;
}

/** Appends tool_result to the active assistant (or opens a new carrier). */
export function appendToolResult(
  prev: ChatMessage[],
  callId: string,
  result: string | undefined,
  isError?: boolean,
  startedAt?: number,
  durationMs?: number,
  details?: any,
): ChatMessage[] {
  const last = prev[prev.length - 1];
  const resBlock: ContentBlock = {
    type: "tool_result",
    toolId: callId,
    toolResult: result,
    toolStartedAt: startedAt,
    toolDurationMs: startedAt ? durationMs || 0 : undefined,
    isError: !!isError,
    toolDetails: details,
  };

  if (last && last.role === "assistant") {
    return [
      ...prev.slice(0, -1),
      { ...last, blocks: [...last.blocks, resBlock] },
    ];
  }
  return [
    ...prev,
    {
      id: `asst_${Date.now()}`,
      role: "assistant",
      turnIndex: last?.turnIndex,
      streaming: true,
      blocks: [resBlock],
      time: Date.now(),
    },
  ];
}

/** Folds a finished background task into the originating tool row: the
 * daemon's bg_update snapshot carries the terminal result; the row that
 * still shows the detach placeholder (same background_job_id, not yet
 * folded) absorbs it — text, detached stamp and a display snapshot for
 * the terminal view. Idempotent: a second fold is a no-op. */
export function foldBackgroundResult(
  prev: ChatMessage[],
  job: { id: string; result?: string; status?: string; endedAt?: number },
): ChatMessage[] {
  if (!job || typeof job.id !== "string") return prev;
  let folded = false;
  const next = prev.map((msg) => {
    if (folded || msg.role !== "assistant") return msg;
    let changed = false;
    const blocks = msg.blocks.map((b) => {
      if (folded || b.type !== "tool_result") return b;
      const det = b.toolDetails as any;
      if (!det || det.background_job_id !== job.id || det.detached) return b;
      folded = true;
      changed = true;
      // A terminal job with empty output folds to blank text (the body
      // then reads "No output") — never keep the "still running"
      // placeholder for a job that already ended.
      const text = typeof job.result === "string" && job.result !== "" ? job.result : undefined;
      return {
        ...b,
        toolResult: text ?? "",
        isError: job.status === "error" ? true : b.isError,
        toolDurationMs: typeof job.endedAt === "number" && typeof b.toolStartedAt === "number"
          ? Math.max(0, job.endedAt - b.toolStartedAt)
          : b.toolDurationMs,
        toolDetails: {
          ...(typeof det === "object" ? det : {}),
          detached: true,
          display: text ?? (typeof det.display === "string" && det.display !== "" ? det.display : undefined),
        },
      };
    });
    return changed ? { ...msg, blocks } : msg;
  });
  return folded ? next : prev;
}

/** Stamps thinking duration onto the most recent assistant that actually
 * thought. Messages without reasoning keep no duration (a stop landing on
 * a fresh empty carrier must not mint a phantom "0s"), and sub-second
 * thinkings clamp to 1s — same convention as the persisted meta. */
export function stampDuration(prev: ChatMessage[], dur: number): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role !== "assistant") continue;
    const thought = prev[i].blocks.some((b) => b.type === "reasoning" && !!b.reasoning?.trim());
    if (!thought) continue;
    const m = { ...prev[i], thinkingDuration: Math.max(1, dur) };
    return [...prev.slice(0, i), m, ...prev.slice(i + 1)];
  }
  return prev;
}

/** Optimistic cut of the rendered tail (edit/regenerate): discards
 * messages with srcIdx beyond the retained raw index. */
export function cutTail(prev: ChatMessage[], keepRawIdx: number): ChatMessage[] {
  const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keepRawIdx);
  return cut < 0 ? prev : prev.slice(0, cut);
}

/** Merges assistant_message: merges into the last assistant or opens a bubble
 * (reasoning first — newest on top —, thinking duration preserved). */
export function mergeAssistantMessage(prev: ChatMessage[], ev: any): ChatMessage[] {
  const blocks = parseContentBlocks(ev.message);
  const reason = blocks.filter((b) => b.type === "reasoning").reverse();
  const normalized = [...reason, ...blocks.filter((b) => b.type !== "reasoning")];
  const duration = Number(ev.message?.meta?.thinking_ms);
  const last = prev[prev.length - 1];
  const message: ChatMessage = {
    id: last?.role === "assistant" ? last.id : `msg_${ev.index}`,
    role: "assistant",
    blocks: normalized,
    time: Date.now(),
    srcIdx: ev.index,
    turnIndex: ev.message?.turnIndex || ev.turnIndex || last?.turnIndex,
    streaming: false,
    thinkingDuration: duration > 0 ? Math.max(1, Math.ceil(duration / 1000)) : last?.thinkingDuration,
    turnDurationMs: Number(ev.message?.meta?.turn_ms) > 0 ? Number(ev.message.meta.turn_ms) : last?.turnDurationMs,
  };
  return last?.role === "assistant" ? [...prev.slice(0, -1), message] : [...prev, message];
}

/** New empty carrier per model step (tool loops do not merge new
 * thinking into the previous assistant response). */
export function pushAssistantCarrier(prev: ChatMessage[], index?: number, turnIndex?: number): ChatMessage[] {
  // Retries replace an uncommitted response at the same raw position.
  const kept = index == null ? prev : prev.filter((m) => m.srcIdx == null || m.srcIdx < index);
  return [...kept, {
    id: index == null ? `asst_${crypto.randomUUID()}` : `msg_${index}`,
    srcIdx: index,
    turnIndex: turnIndex || prev.at(-1)?.turnIndex,
    streaming: true,
    role: "assistant",
    blocks: [],
    time: Date.now(),
  }];
}

/** Turn transition when becoming idle (turn end without endedAt). */
export function finishTurn(turn: TurnActivity | null): TurnActivity | null {
  return turn && !turn.endedAt
    ? {
        ...turn,
        endedAt: Date.now(),
        status: turn.status === "cancelling" ? "cancelled" : turn.status === "running" ? "completed" : turn.status,
      }
    : turn;
}

/** Message-local references, never guessed from filenames shared across turns. */
export function parseMessageAttachments(message: any): import("../viewTypes").StoredAttachment[] {
  try {
    const refs = JSON.parse(message.meta?.attachments || "[]");
    return Array.isArray(refs) ? refs.filter((a) => a && typeof a.id === "string" && typeof a.name === "string") : [];
  } catch { return []; }
}
