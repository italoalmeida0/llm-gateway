import { createMemo, For, Show } from "solid-js";
import { Streamdown } from "streamdown-solid";
import { Icon as Iconify } from "../../components/icon";
import type { ChatMessage, ContentBlock, RenderBlock, RenderBlockSeries, ToolUnit, TurnEntry } from "../types";
import { isLongAssistantMessage } from "../transcript";
import { partitionToolSegs } from "../utils/toolSegs";
import type { ToolSeg } from "../utils/toolSegs";
import { groupTitle, specialTitle } from "../utils/titles";
import { useToolUnitModel } from "./tool/toolUnitModel";
import { transcriptMarkdownComponents } from "./MarkdownCode";
import { ToolUnitHeader } from "./tool/ToolUnitHeader";
import { ToolEditBodies } from "./tool/ToolEditBodies";
import { ToolSearchBodies } from "./tool/ToolSearchBodies";
import { ToolQuestionBodies } from "./tool/ToolQuestionBodies";

/** Closures da página que os blocos de transcript precisam para renderizar. */
export interface TranscriptRenderCtx {
  renderBlocks: () => RenderBlock[];
  sessionStatus: () => string;
  messages: () => ChatMessage[];
  thinkingStart: () => number | null;
  thinkingElapsed: () => number;
  expandedThinking: () => Record<string, boolean>;
  toolGroupOpen: () => Record<string, boolean>;
  toolOpen: () => Record<string, boolean>;
  toolProgress: () => Record<string, string>;
  toggleToolGroup: (id: string) => void;
  toggleToolOpen: (id: string) => void;
  elapsedLabel: (ms: number) => string;
  specialProgress: (units: ToolUnit[]) => string | undefined;
  thinkingIndex: () => number;
  setExpandedThinking: (v: Record<string, boolean> | ((p: Record<string, boolean>) => Record<string, boolean>)) => void;
  verboseChat: () => boolean;
  hideToolMessages: () => boolean;
  setPreviewFile: (v: import("../types").PreviewFile | null) => void;
  turnClock: () => number;
  toolStarts: () => Record<string, number>;
  activeSession: () => import("../types").SessionSummary | null;
  pendingApproval: () => import("../types").PendingApproval | null;
  projects: () => import("../types").Project[];
}

/** Thinking as a tool-style row: header (bot icon + timer) with a
 * Streamdown body. Open by default while the turn runs, closed after —
 * unless the user toggled it explicitly. */
export function renderThinkingRow(
  ctx: TranscriptRenderCtx,
  entry: Extract<TurnEntry, { kind: "thinking" }>,
  openByDefault: boolean,
  hidden: boolean,
  live: boolean,
) {
  const key = `${entry.msg.id}:think:${entry.nth}`;
  const open = () => ctx.expandedThinking()[key] ?? openByDefault;
  const label = () =>
    live
      ? `Thinking ${ctx.thinkingElapsed()}s`
      : entry.msg.thinkingDuration !== undefined
        ? `Thinking ${entry.msg.thinkingDuration}s`
        : open()
          ? "Hide thinking"
          : "Thinking";
  return (
    <div style={hidden ? { display: "none" } : undefined} data-thinking-row={key}>
      <div
        onClick={() => ctx.setExpandedThinking((prev) => ({ ...prev, [key]: !open() }))}
        class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
      >
        <Show
          when={!live}
          fallback={
            <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
          }
        >
          <Iconify icon="lucide:bot" size={14} class="shrink-0 text-ink-500" />
        </Show>
        <span class="text-ink-500 shrink-0">{label()}</span>
        <span class="flex-1" />
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </div>
      <Show when={open()}>
        <div class="rc-markdown w-full text-xs leading-relaxed break-words overflow-x-auto pl-1 pb-1 text-ink-400">
          <Streamdown components={transcriptMarkdownComponents}>
            {entry.block.reasoning || "(thinking…)"}
          </Streamdown>
        </div>
      </Show>
    </div>
  );
}

/** Assistant text as a tool-style row: header with a one-line preview and
 * a Streamdown body. Hidden (display:none, kept in the DOM) while the
 * hide-tool-messages rule, verbose filter, fuzzy dedup or the featured
 * final message takes it out of the card. */
export function renderTextRow(
  ctx: TranscriptRenderCtx,
  entry: Extract<TurnEntry, { kind: "text" }>,
  openByDefault: boolean,
  hidden: boolean,
) {
  const key = `${entry.msg.id}:text:${entry.nth}`;
  const open = () => ctx.toolOpen()[key] ?? openByDefault;
  const preview = () =>
    (entry.block.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return (
    <div style={hidden ? { display: "none" } : undefined} data-text-row={key}>
      <div
        onClick={() => ctx.toggleToolOpen(key)}
        class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
      >
        <Iconify icon="lucide:message-circle" size={14} class="shrink-0 text-ink-500" />
        <span class="text-ink-500 shrink-0">Message</span>
        <span class="truncate text-ink-200 font-medium min-w-0 flex-1">{preview()}</span>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </div>
      <Show when={open()}>
        <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto pl-1 pb-1">
          <Streamdown components={transcriptMarkdownComponents}>{entry.block.text}</Streamdown>
        </div>
      </Show>
    </div>
  );
}

/**
 * The turn aggregate: one card per turn with every thinking, message and
 * tool run in event order. Open by default while the turn runs (verbose no
 * longer affects this), closed once it ends — unless toggled explicitly.
 * Question-only turns keep their inline rendering, exempt from the card.
 */
export function renderTurnAggregate(
  ctx: TranscriptRenderCtx,
  series: RenderBlockSeries,
  _isLast: boolean,
) {
  // NOTE: ctx.renderBlocks() is the FULL list (window only affects the <For>);
  // the running turn is always the newest block, which is always visible.
  const running = createMemo(() => ctx.renderBlocks().at(-1)?.msg.id === series.msg.id && ctx.sessionStatus() === "running");
  const summary = createMemo(() => specialTitle(series.units));
  const key = `${series.msg.id}:turn`;
  const open = () => ctx.toolGroupOpen()[key] ?? running();
  /** The featured final renders below once idle; inside the card its rows
   * stay mounted with display:none so Solid keeps DOM identity. */
  const featured = () => series.finalMsgId != null && !running();
  const lastTurnId = () => series.extras.at(-1)?.id ?? series.msg.id;
  /** Live tail: the turn's latest call, or any call with live progress
   * (parallel in-flight). Only the tail spins/auto-opens; when a new
   * entry arrives the previous one falls back to closed on its own. */
  const tailCall = () => [...series.units].reverse().find((u) => u.call) ?? null;
  const isActive = (u: ToolUnit) =>
    running() && (u === tailCall() || (u.call?.toolId != null && ctx.toolProgress()[u.call.toolId] != null));
  const lastEntryIdx = () => series.entries.length - 1;
  /** A stale thinking timer (snapshot restart mid-tools) must not spin:
   * live only while the turn's tail is still thinking. */
  const tailIsThinking = () => series.entries[lastEntryIdx()]?.kind === "thinking";
  const lastTextIdx = () => {
    let idx = -1;
    series.entries.forEach((e, i) => { if (e.kind === "text") idx = i; });
    return idx;
  };
  const thinkingHidden = () => !ctx.verboseChat();
  const textHidden = (entry: Extract<TurnEntry, { kind: "text" }>, idx: number) => {
    if (entry.hidden) return true;
    if (featured() && entry.msg.id === series.finalMsgId) return true;
    if (!ctx.verboseChat() && idx !== lastTextIdx()) return true;
    if (
      ctx.hideToolMessages() && series.units.length > 0 &&
      !entry.msg.hasCompletion && !isLongAssistantMessage(entry.msg)
    ) return true;
    return false;
  };
  return (
    <Show when={series.units.every((u) => u.call?.toolName === "question")} fallback={
    <div class="w-full border-t border-line/60 overflow-hidden mt-1">
      <button
        onClick={() => ctx.toggleToolGroup(key)}
        class="w-full flex items-center gap-2 px-3 py-2 hover:bg-ink-900/60 transition-colors cursor-pointer text-left"
      >
        <Show
          when={!running()}
          fallback={
            <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
          }
        >
          <Iconify icon="lucide:bot" size={14} class="shrink-0 text-ink-500" />
        </Show>
        <span class="text-[13px] font-medium text-ink-300 truncate flex-1 min-w-0">
          {summary()}
        </span>
        <Show when={ctx.specialProgress(series.units)}>
          {(t) => (
            <span class="font-mono text-[11px] text-ink-600 truncate max-w-[40%] shrink-0">
              {t()}
            </span>
          )}
        </Show>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </button>
      <Show when={open()}>
        <div class="border-t border-line/60 px-2 py-1.5 space-y-0.5">
          <For each={series.entries}>
            {(entry, ei) => {
              const tail = ei() === lastEntryIdx();
              if (entry.kind === "tools") {
                return renderToolSegs(ctx, entry.msg.id, `${series.msg.id}:e${ei()}`, entry.units, running(), isActive);
              }
              if (entry.kind === "thinking") {
                // Stale snapshot restarts must not spin: live only while
                // the tail is still thinking AND the clock is actually on.
                const live = tail && tailIsThinking() && running() && entry.isNewest &&
                  entry.msg.id === lastTurnId() && ctx.thinkingStart() !== null;
                const content = (entry.block.reasoning || "").trim() !== "";
                return renderThinkingRow(ctx, entry, running() && tail && content, thinkingHidden(), live);
              }
              if (entry.kind === "text") {
                const content = (entry.block.text || "").trim() !== "";
                return renderTextRow(ctx, entry, running() && tail && content, textHidden(entry, ei()));
              }
              return renderImageBlock(ctx, entry.block);
            }}
          </For>
        </div>
      </Show>
    </div>
    }><For each={series.units}>{(unit, index) => renderToolUnit(ctx, series.msg.id, unit, index(), running(), isActive(unit))}</For></Show>
  );
}

/** Featured final message of a finished turn, rendered as a plain bubble
 * below the aggregate (the files balloon comes right after). */
export function renderFinalMsg(ctx: TranscriptRenderCtx, series: RenderBlockSeries) {
  const msg = () => [series.msg, ...series.extras].find((m) => m.id === series.finalMsgId);
  return (
    <Show when={msg()}>
      {(m) => (
        <div class="w-full space-y-2.5">
          <For each={m().blocks.filter((b) => b.type === "image" || (b.type === "text" && !!b.text?.trim()))}>
            {(block) => block.type === "image" ? renderImageBlock(ctx, block) : (
              <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
                <Streamdown components={transcriptMarkdownComponents}>{block.text}</Streamdown>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

/** Plain assistant bubble for turns with no tools and no thinking. */
export function renderSingleAssistant(ctx: TranscriptRenderCtx, msg: ChatMessage) {
  return (
    <div class="w-full space-y-2.5">
      <For each={msg.blocks.filter((b) => b.type === "image" || (b.type === "text" && !!b.text?.trim()))}>
        {(block) => block.type === "image" ? renderImageBlock(ctx, block) : (
          <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
            <Streamdown components={transcriptMarkdownComponents}>{block.text}</Streamdown>
          </div>
        )}
      </For>
    </div>
  );
}


export function renderImageBlock(ctx: TranscriptRenderCtx, block: ContentBlock) {
  const src = () =>
    block.imageData
      ? `data:${block.imageMime || "image/jpeg"};base64,${block.imageData}`
      : undefined;
  return (
    <Show
      when={src()}
      fallback={
        <div class="flex items-center gap-1.5 text-[11px] text-ink-500 border border-line/60 rounded-lg px-2 py-1">
          <Iconify icon="lucide:image" size={12} />
          <span>[attached {block.text || "image"}]</span>
        </div>
      }
    >
      <button
        onClick={() =>
          ctx.setPreviewFile({
            name: "attached image",
            mime: block.imageMime || "image/jpeg",
            dataUrl: src(),
          })
        }
        class="block rounded-lg overflow-hidden border border-line/60 hover:border-ink-500 transition-colors cursor-pointer"
        data-rc-tip="Open preview" aria-label="Open preview"
      >
        <img src={src()} class="max-h-64 max-w-full object-contain" />
      </button>
    </Show>
  );
}

/**
 * Per-run collapsible sub-groups (explore/command runs) inside the
 * aggregate card. Same grouping as before, keyed on the series card so
 * state never collides across fused messages.
 */
export function renderToolSegs(ctx: TranscriptRenderCtx, msgId: string, keySalt: string, units: ToolUnit[], running: boolean, isActive: (u: ToolUnit) => boolean = () => running) {
  // Partition consecutive explore/command runs into collapsible groups
  // (pure helper — algorithm lives in utils/toolSegs, covered by tests).
  const segs = partitionToolSegs(units);
  // Chaves estáveis por identidade (não por posição): quando uma tool nova
  // entra no fim do grupo, as chaves das anteriores não mudam e o Solid
  // reutiliza o DOM — sem remount, sem scroll jump, sem re-abrir colapsado.
  const segKey = (seg: ToolSeg) =>
    seg.kind === "unit"
      ? `u:${seg.unit.call?.toolId || seg.unit.result?.toolId || "i" + seg.idx}`
      : `g:${seg.cat}:${seg.units[0]?.call?.toolId || seg.units[0]?.result?.toolId || "0"}`;
  return (
    <div class="w-full space-y-0.5" style={{ "overflow-anchor": "none" }}>
      <For each={segs}>
        {(seg) => {
          if (seg.kind === "unit")
            return (
              <div data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
                {renderToolUnit(ctx, msgId, seg.unit, seg.idx, running, isActive(seg.unit))}
              </div>
            );
          const gkey = `${msgId}:${keySalt}:${segKey(seg)}`;
          // Sub-groups open while they hold live work; a finished group
          // (and its rows) falls back to closed on its own.
          const open = () => ctx.toolGroupOpen()[gkey] ?? (running && seg.units.some(isActive));
          return (
            <div class="w-full" data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
              <button
                onClick={() => ctx.toggleToolGroup(gkey)}
                class="w-full flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-lg hover:bg-ink-900/70 text-[13px] text-ink-400 hover:text-ink-200 cursor-pointer"
              >
                <span class="font-medium">{groupTitle(seg.cat, seg.units)}</span>
                <Iconify
                  icon="lucide:chevron-down"
                  size={12}
                  class={`text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
                />
              </button>
              <Show when={open()}>
                <div class="ml-3 border-l border-line/40 pl-1.5 space-y-0.5" style={{ "overflow-anchor": "none" }}>
                  <For each={seg.units}>
                    {(u) => {
                      // Índice global estável: posição da unit na lista completa,
                      // não no grupo — a chave da row (toolRowKey) não muda
                      // quando o grupo cresce.
                      const gi = units.indexOf(u);
                      return renderToolUnit(ctx, msgId, u, gi >= 0 ? gi : 0, running, isActive(u));
                    }}
                  </For>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// One session row, reused by the nested project groups and the flat list.

/**
 * Render blocks for the conversation (recomputed when the transcript
 * changes). Series fusing is visual only: every block keeps its lead's
 * raw index (blockRawIdx) for per-message ops.
 */
// Preserve DOM/component identity across deltas. Rebuilding <For> entries
// on every token remounted Markdown and collapsed its height before repaint.

export function renderToolUnit(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: boolean, active: boolean) {
  const m = useToolUnitModel(ctx, msgId, u, ui, running, active);
  const part = { ctx, msgId, u, m, running, active };
  return (
    <div class="w-full">
      <ToolUnitHeader {...part} />
      <Show when={m.open()}>
        <div class="mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 overflow-hidden">
          <ToolEditBodies {...part} />
          <ToolSearchBodies {...part} />
          <ToolQuestionBodies {...part} />
        </div>
      </Show>
    </div>
  );
}
