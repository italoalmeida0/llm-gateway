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
export function normalizeSessionMessages(rawMsgs: any[], previous: ChatMessage[] = [], indexBase = 0): ChatMessage[] {
  const out: ChatMessage[] = [];
  // Paged blocks carry their raw transcript offset (history.firstIndex):
  // srcIdx must stay global so edit/delete/regenerate map back to the
  // daemon array. Full snapshots use base 0 (positions are already raw).
  const at = (idx: number) => idx + indexBase;
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
    if (!folded || !(folded.toolDetails as any)?.detached || (folded.toolDetails as any).background_job_id !== (b.toolDetails as any).background_job_id) return b;
    return {
      ...b,
      toolResult: folded.toolResult,
      toolDurationMs: folded.toolDurationMs ?? b.toolDurationMs,
      isError: folded.isError,
      toolDetails: { ...(b.toolDetails as any), detached: true, display: (folded.toolDetails as any)?.display },
    };
  };
  let carrier: ChatMessage | null = null;
  const callCarriers = new Map<string, ChatMessage>();
  const ensureCarrier = (srcIdx: number, wire: any): ChatMessage => {
    if (!carrier || carrier.role !== "assistant") {
      carrier = {
        id: typeof wire?.id === "string" ? `tools_${wire.id}` : `tools_${srcIdx}`,
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
        id: typeof m.id === "string" && m.id ? m.id : byIndex.get(at(idx))?.id ?? `msg_${at(idx)}`,
        role,
        streaming: m.streaming === true,
        blocks: [...reason, ...rest.map(carryFold)],
        thinkingDuration: Number(m.meta?.thinking_ms) > 0 ? Math.max(1, Math.ceil(Number(m.meta.thinking_ms) / 1000)) : undefined,
        turnDurationMs: Number(m.meta?.turn_ms) > 0 ? Number(m.meta.turn_ms) : undefined,
        time: Date.parse(m.time) || byIndex.get(at(idx))?.time || 0,
        srcIdx: at(idx),
        turnIndex: typeof m.turnIndex === "number" ? m.turnIndex : undefined,
      };
      out.push(msg);
      carrier = msg;
      for (const b of msg.blocks) if (b.type === "tool_call" && b.toolId) callCarriers.set(b.toolId,msg);
      return;
    }
    // user / tool envelope: split tool results away from real content.
    const rest: ContentBlock[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const owner=(b.toolId && callCarriers.get(b.toolId)) || ensureCarrier(at(idx),m);
        const existing=owner.blocks.findIndex(x=>x.type==="tool_result" && x.toolId===b.toolId);
        if(existing>=0) owner.blocks[existing]=carryFold(b); else owner.blocks.push(carryFold(b));
      }
      else rest.push(b);
    }
    if (role === "tool" || rest.length === 0) {
      // "tool" envelopes never become bubbles; a user envelope holding
      // only tool results must not render as an empty user bubble.
      if (rest.length > 0) ensureCarrier(at(idx), m).blocks.push(...rest);
      return;
    }
    if (typeof m.meta?.background_delivery === "string" && m.meta.background_delivery) {
      // Background completion notices (system-reminders, model-facing
      // only): never rendered, never a carrier — not even an empty one.
      return;
    }
    const isStart = m.isTurnStart !== undefined ? Boolean(m.isTurnStart) : !m.midTurn;
    const msg: ChatMessage = {
      id: typeof m.id === "string" && m.id ? m.id : byIndex.get(at(idx))?.id ?? `msg_${at(idx)}`,
      role: "user",
      attachments: parseMessageAttachments(m),
      blocks: typeof m.meta?.user_text === "string" ? [{ type: "text", text: m.meta.user_text }] : rest,
      time: Date.parse(m.time) || byIndex.get(at(idx))?.time || 0,
      srcIdx: at(idx),
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
export function appendTextDelta(prev: ChatMessage[], delta: string, messageId?: string): ChatMessage[] {
  if (messageId) return updateMessage(prev, messageId, m => appendTextDelta([m], delta)[0]);
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
export function appendReasoningDelta(prev: ChatMessage[], delta: string, messageId?: string): ChatMessage[] {
  if (messageId) return updateMessage(prev, messageId, m => appendReasoningDelta([m], delta)[0]);
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
export function upsertToolCall(prev: ChatMessage[], callId: string, name: string, args: any, messageId?: string): ChatMessage[] {
  if (messageId) return updateMessage(prev, messageId, m => upsertToolCall([m], callId, name, args)[0]);
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
export function appendToolArgsDelta(prev: ChatMessage[], callId: string, delta: string, messageId?: string): ChatMessage[] {
  if (messageId) return updateMessage(prev, messageId, m => appendToolArgsDelta([m], callId, delta)[0]);
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
  messageId?: string,
): ChatMessage[] {
  if (messageId) return updateMessage(prev,messageId,m=>appendToolResult([m],callId,result,isError,startedAt,durationMs,details)[0]);
  const target = prev.findLastIndex(m => m.role === "assistant" && m.blocks.some(b => b.toolId === callId));
  const index = target >= 0 ? target : prev.length - 1;
  const carrier = prev[index];
  const resBlock: ContentBlock = {
    type: "tool_result", toolId: callId, toolResult: result,
    toolStartedAt: startedAt, toolDurationMs: startedAt ? durationMs || 0 : undefined,
    isError: !!isError, toolDetails: details,
  };
  if (carrier?.role === "assistant") {
    const blocks = [...carrier.blocks];
    const existing = blocks.findIndex(b => b.type === "tool_result" && b.toolId === callId);
    if (existing >= 0) {
      // A replayed detach placeholder must not undo a terminal background fold.
      if ((blocks[existing].toolDetails as any)?.detached && !(details as any)?.detached) return prev;
      blocks[existing] = resBlock;
    } else blocks.push(resBlock);
    return [...prev.slice(0,index),{...carrier,blocks},...prev.slice(index+1)];
  }
  return [...prev,{id:`tools_${callId}`,role:"assistant",blocks:[resBlock],time:0}];
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
  const id = ev.message?.id || ev.messageId;
  const index = id ? prev.findIndex(m => m.id === id) : typeof ev.index === "number"
    ? prev.findIndex(m => m.srcIdx === ev.index)
    : prev.at(-1)?.role === "assistant" ? prev.length - 1 : -1;
  const old = prev[index];
  const blocks = parseContentBlocks(ev.message);
  const calls = new Set(blocks.filter(b => b.type === "tool_call").map(b => b.toolId));
  const results = (old?.blocks || []).filter(b => b.type === "tool_result" && calls.has(b.toolId));
  const reason = blocks.filter(b => b.type === "reasoning").reverse();
  const duration = Number(ev.message?.meta?.thinking_ms);
  const message: ChatMessage = {
    id: id || old?.id || `msg_${ev.index}`, role:"assistant",
    blocks:[...reason,...blocks.filter(b=>b.type!=="reasoning"),...results],
    time:Date.parse(ev.message?.time) || old?.time || 0,
    srcIdx:ev.index ?? old?.srcIdx, turnIndex:ev.message?.turnIndex ?? ev.turnIndex ?? old?.turnIndex,
    streaming:false,
    thinkingDuration:duration>0 ? Math.max(1,Math.ceil(duration/1000)) : old?.thinkingDuration,
    turnDurationMs:Number(ev.message?.meta?.turn_ms)>0 ? Number(ev.message.meta.turn_ms) : old?.turnDurationMs,
  };
  return index>=0 ? [...prev.slice(0,index),message,...prev.slice(index+1)] : orderedMessages([...prev,message]);
}

/** A model step has one daemon identity across deltas, commit and snapshots. */
export function pushAssistantCarrier(prev: ChatMessage[], index?: number, turnIndex?: number, messageId?: string): ChatMessage[] {
  if (messageId && prev.some(m=>m.id===messageId)) return prev;
  const kept = index == null ? prev : prev.filter(m => m.srcIdx == null || m.srcIdx < index);
  return [...kept,{id:messageId || (index==null ? `asst_${crypto.randomUUID()}` : `msg_${index}`),
    srcIdx:index,turnIndex:turnIndex ?? prev.at(-1)?.turnIndex,streaming:true,role:"assistant",blocks:[],time:0}];
}

function updateMessage(prev: ChatMessage[], id: string, update: (m: ChatMessage) => ChatMessage): ChatMessage[] {
  const index=prev.findIndex(m=>m.id===id);
  if(index<0 || prev[index].role!=="assistant") return prev;
  return [...prev.slice(0,index),update(prev[index]),...prev.slice(index+1)];
}

export function orderedMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.toSorted((a,b)=>(a.srcIdx ?? Infinity)-(b.srcIdx ?? Infinity));
}

/** A tail snapshot replaces its raw range, including removed/retried rows.
 * Older pages remain intact; snapshot order is authoritative. */
export function mergeTranscriptTail(prev: ChatMessage[], tail: ChatMessage[], firstIndex: number): ChatMessage[] {
  const ids=new Set(tail.map(m=>m.id));
  return [...prev.filter(m=>m.srcIdx!=null && m.srcIdx<firstIndex && !ids.has(m.id)),...tail];
}

/** Turn transition when becoming idle (turn end without endedAt). */
export function normalizeTurnActivity(turn: any, previous: TurnActivity | null = null, fallback?: string): TurnActivity | null {
  if (!turn || !Number.isFinite(turn.startedAt)) return null;
  const status = turn.status === "done"
    ? (previous?.startedAt === turn.startedAt && previous?.status === "cancelled" ? "cancelled" : "completed")
    : turn.status || fallback;
  if (!["running", "cancelling", "cancelled", "completed", "failed"].includes(status)) return null;
  return { ...turn, status };
}

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

/** Worker-normalized pages retain completed background projections by job ID. */
export function preserveBackgroundFolds(next: ChatMessage[], previous: ChatMessage[]): ChatMessage[] {
  const folds=new Map<string,ContentBlock>();
  for(const m of previous) for(const b of m.blocks) {
    const d=b.toolDetails as any;
    if(b.type==="tool_result" && d?.detached && d.background_job_id) folds.set(`${d.background_job_id}:${b.toolId}`,b);
  }
  return next.map(m=>{
    let changed=false;
    const blocks=m.blocks.map(b=>{
      const d=b.toolDetails as any;
      const saved=folds.get(`${d?.background_job_id}:${b.toolId}`);
      if(!saved || d?.detached || b.type!=="tool_result") return b;
      changed=true; return {...b,toolResult:saved.toolResult,isError:saved.isError,toolDurationMs:saved.toolDurationMs,
        toolDetails:{...d,...saved.toolDetails as any}};
    });
    return changed?{...m,blocks}:m;
  });
}
