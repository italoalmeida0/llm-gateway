import { parseContentBlocks, prettyArgs } from "../utils/wire";
import type { ChatMessage, ContentBlock, SessionUsage } from "../types";
import type { TurnActivity } from "../viewTypes";

/** Redutores puros do transcript (extraídos de RemoteCodePage verbatim,
 * sem dependência Solid — cobertos por testes). Cada função recebe a lista
 * anterior e devolve a próxima; o hook/threading Solid vive em useTranscript. */

const TOOLS_IMAGE_MARKER = "Tool output included the following image content:";

/** Normaliza o transcript bruto do daemon em bolhas renderizáveis: tool
 * results são içados para o carrier assistant (com srcIdx para as ops
 * edit/delete/regenerate), envelopes "tool" nunca viram bolha. */
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
    const firstText = blocks.find((b) => b.type === "text")?.text || "";
    const system =
      m?.meta?.compaction === "true" ||
      firstText.startsWith("## Context Summary (compacted)");
    const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
    if (role === "assistant") {
      const reason: ContentBlock[] = [];
      const rest: ContentBlock[] = [];
      for (const b of blocks) (b.type === "reasoning" ? reason : rest).push(b);
      // Thinkings mais novos primeiro: o último reasoning do turno fica no topo.
      reason.reverse();
      const msg: ChatMessage = {
        id: `msg_${idx}`,
        role,
        blocks: [...reason, ...rest],
        thinkingDuration: Number(m.meta?.thinking_ms) > 0 ? Math.max(1, Math.ceil(Number(m.meta.thinking_ms) / 1000)) : undefined,
        time: Date.now(),
        system,
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
    // Daemon's image mirror: the tool already shows a collapsible row with
    // its output — the mirror carries the SAME bytes, so drop it (keeping
    // a duplicate caption under the tool would just repeat the tool). The
    // image blocks here and the ones folded from tool results both die
    // together with their carrier row.
    if (
      rest.length > 0 &&
      rest[0].type === "text" &&
      (rest[0].text || "").trim().startsWith(TOOLS_IMAGE_MARKER)
    ) {
      return;
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
      system,
      srcIdx: idx,
    };
    out.push(msg);
    carrier = msg;
  });
  return out;
}

/** Acumula usage (cumulativo vence) sem perder buckets anteriores. */
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

/** Junta um delta de texto ao último bloco de texto do assistant vivo. */
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

/** Junta um delta de reasoning ao painel de thinking do assistant vivo
 * (merge no painel existente, que fica no topo; painel novo vai à frente
 * para a vista live já condizer com o refresh normalizado). */
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

/** Upsert de tool_call: tool_use_start pré-cria o cartão, tool_call finaliza. */
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

/** Junta args em streaming ao tool_call existente (sem cartão: sem-op). */
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

/** Anexa o tool_result ao assistant vivo (ou abre carrier novo). */
export function appendToolResult(
  prev: ChatMessage[],
  callId: string,
  result: string | undefined,
  isError?: boolean,
  startedAt?: number,
  durationMs?: number,
): ChatMessage[] {
  const last = prev[prev.length - 1];
  const resBlock: ContentBlock = {
    type: "tool_result",
    toolId: callId,
    toolResult: result,
    toolStartedAt: startedAt,
    toolDurationMs: startedAt ? durationMs || 0 : undefined,
    isError: !!isError,
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

/** Carimba a duração do thinking no assistant mais recente. */
export function stampDuration(prev: ChatMessage[], dur: number): ChatMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].role === "assistant") {
      const m = { ...prev[i], thinkingDuration: dur };
      return [...prev.slice(0, i), m, ...prev.slice(i + 1)];
    }
  }
  return prev;
}

/** Corte otimista da cauda renderizada (edit/regenerate): descarta
 * mensagens com srcIdx além do índice bruto mantido. */
export function cutTail(prev: ChatMessage[], keepRawIdx: number): ChatMessage[] {
  const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keepRawIdx);
  return cut < 0 ? prev : prev.slice(0, cut);
}

/** Merge de assistant_message: funde no último assistant ou abre bolha
 * (reasoning primeiro — mais novo no topo —, duração do thinking preservada). */
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

/** Novo carrier vazio por model step (loops de tools não fundem thinking
 * novo na resposta assistant anterior). */
export function pushAssistantCarrier(prev: ChatMessage[]): ChatMessage[] {
  return [...prev, {
    id: `asst_${crypto.randomUUID()}`,
    role: "assistant",
    blocks: [],
    time: Date.now(),
  }];
}

/** Transição do turn ao ficar idle (fim de turno sem endedAt). */
export function finishTurn(turn: TurnActivity | null): TurnActivity | null {
  return turn && !turn.endedAt
    ? {
        ...turn,
        endedAt: Date.now(),
        status: turn.status === "cancelling" ? "cancelled" : turn.status === "running" ? "completed" : turn.status,
      }
    : turn;
}
