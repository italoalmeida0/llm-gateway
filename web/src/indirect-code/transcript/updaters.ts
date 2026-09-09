import { parseContentBlocks, prettyArgs } from "../utils/wire";
import type { ChatMessage, ContentBlock, SessionUsage } from "../types";
import type { TurnActivity } from "../viewTypes";

/** Pure transcript reducers (extracted verbatim from RemoteCodePage,
 * with no Solid dependency — covered by tests). Each function receives the
 * previous list and returns the next; Solid hook/threading lives in useTranscript. */

/** Normalizes the raw daemon transcript into renderable bubbles: tool
 * results are hoisted onto the assistant carrier (with srcIdx for
 * edit/delete/regenerate ops); "tool" envelopes never become a bubble. */
export function normalizeSessionMessages(rawMsgs: any[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let carrier: ChatMessage | null = null;
  const ensureCarrier = (srcIdx: number): ChatMessage => {
    if (!carrier || carrier.role !== "assistant") {
      carrier = {
        id: `tools_${srcIdx}`,
        role: "assistant",
        blocks: [],
        time: Date.now(),
        srcIdx,
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
        id: `msg_${idx}`,
        role,
        blocks: [...reason, ...rest],
        thinkingDuration: Number(m.meta?.thinking_ms) > 0 ? Math.max(1, Math.ceil(Number(m.meta.thinking_ms) / 1000)) : undefined,
        time: Date.now(),
        srcIdx: idx,
      };
      out.push(msg);
      carrier = msg;
      return;
    }
    // user / tool envelope: split tool results away from real content.
    const rest: ContentBlock[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") ensureCarrier(idx).blocks.push(b);
      else rest.push(b);
    }
    if (role === "tool" || rest.length === 0) {
      // "tool" envelopes never become bubbles; a user envelope holding
      // only tool results must not render as an empty user bubble.
      if (rest.length > 0) ensureCarrier(idx).blocks.push(...rest);
      return;
    }
    const msg: ChatMessage = {
      id: `msg_${idx}`,
      role: "user",
      blocks: rest,
      time: Date.now(),
      srcIdx: idx,
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
      blocks: [resBlock],
      time: Date.now(),
    },
  ];
}

/** Stamps thinking duration onto the most recent assistant. */
export function stampDuration(prev: ChatMessage[], dur: number): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role === "assistant") {
      const m = { ...prev[i], thinkingDuration: dur };
      return [...prev.slice(0, i), m, ...prev.slice(i + 1)];
    }
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
    thinkingDuration: duration > 0 ? Math.max(1, Math.ceil(duration / 1000)) : last?.thinkingDuration,
  };
  return last?.role === "assistant" ? [...prev.slice(0, -1), message] : [...prev, message];
}

/** New empty carrier per model step (tool loops do not merge new
 * thinking into the previous assistant response). */
export function pushAssistantCarrier(prev: ChatMessage[]): ChatMessage[] {
  return [...prev, {
    id: `asst_${crypto.randomUUID()}`,
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
