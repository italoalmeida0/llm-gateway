import { createMemo, For, Show } from "solid-js";
import { Streamdown } from "streamdown-solid";
import { Icon as Iconify } from "../../components/icon";
import type { ChatMessage, ContentBlock, RenderBlock, RenderBlockSeries, ToolUnit } from "../types";
import { splitToolRuns } from "../utils/tools";
import { partitionToolSegs } from "../utils/toolSegs";
import { groupTitle, specialTitle } from "../utils/titles";
import { useToolUnitModel } from "./tool/toolUnitModel";
import { ToolUnitHeader } from "./tool/ToolUnitHeader";
import { ToolEditBodies } from "./tool/ToolEditBodies";
import { ToolSearchBodies } from "./tool/ToolSearchBodies";

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
  setPreviewFile: (v: import("../types").PreviewFile | null) => void;
  turnClock: () => number;
  toolStarts: () => Record<string, number>;
  activeSession: () => import("../types").SessionSummary | null;
  pendingApproval: () => import("../types").PendingApproval | null;
  projects: () => import("../types").Project[];
}

export function renderThinkingBlock(
  ctx: TranscriptRenderCtx,
  msg: ChatMessage,
  block: ContentBlock,
  nth: number,
) {
  const thinkKey = () => `${msg.id}:think:${nth}`;
  const openNow = () => ctx.messages().at(-1)?.id === msg.id && ctx.sessionStatus() === "running";
  const live = () =>
    openNow() && ctx.thinkingStart() !== null && ctx.thinkingIndex() === nth;
  const open = () => ctx.expandedThinking()[thinkKey()] ?? live();
  return (
    <div class="w-full">
      <button
        aria-expanded={open()}
        onClick={() => ctx.setExpandedThinking((prev) => ({ ...prev, [thinkKey()]: !open() }))}
        class={`flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
          openNow() ? "text-ink-300" : "text-ink-500 hover:text-ink-300"
        }`}
      >
        <Iconify icon="lucide:bot" size={14} />
        <span>
          {live()
            ? `Thinking ${ctx.thinkingElapsed()}s`
            : msg.thinkingDuration !== undefined
              ? `Thinking ${msg.thinkingDuration}s`
              : open()
                ? "Hide thinking"
                : "Thinking"}
        </span>
        <Show when={live()}>
          <span class="thinking-indicator">
            <span />
            <span />
            <span />
          </span>
        </Show>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </button>
      <Show when={open()}>
        <div class="mt-2 max-h-64 overflow-y-auto [scrollbar-gutter:stable] pl-3 border-l-2 border-line text-ink-400 whitespace-pre-wrap break-words text-xs leading-relaxed">
          {block.reasoning || "(thinking…)"}
        </div>
      </Show>
    </div>
  );
}

/**
 * The special aggregate balloon: one card per consecutive tool-call series
 * (possibly spanning several rendered assistant messages — see
 * buildRenderBlocks). It has its own chrome (header + collapse) and NO
 * per-message chrome of its own: the lead message's hover actions cover
 * the whole turn; the card itself carries no edit/delete/copy buttons.
 * `extraSrcIds` are the raw daemon indices fused in, used only for keys.
 */

export function renderAssistantSpecial(
  ctx: TranscriptRenderCtx,
  msgId: string,
  units: ToolUnit[],
  _isLast: boolean,
  extraSrcIds: number[] = [],
) {
  // NOTE: ctx.renderBlocks() is the FULL list (window only affects the <For>);
  // the running unit is always the newest block, which is always visible.
  const running = createMemo(() => ctx.renderBlocks().at(-1)?.msg.id === msgId && ctx.sessionStatus() === "running");
  const summary = createMemo(() => specialTitle(units));
  const key = `${msgId}:special`;
  const open = () => ctx.toolGroupOpen()[key] ?? true;
  return (
    <Show when={ctx.verboseChat()}>
      <Show when={units.every((u) => u.call?.toolName === "question")} fallback={
      <div class="w-full rounded-xl border border-line/60 bg-ink-900/40 overflow-hidden mt-1">
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
          <Show when={ctx.specialProgress(units)}>
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
            {renderToolSegs(ctx, msgId, extraSrcIds.join(",") || "lead", units, running())}
          </div>
        </Show>
      </div>
      }><For each={units}>{(unit, index) => renderToolUnit(ctx, msgId, unit, index(), running())}</For></Show>
    </Show>
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


export function renderMessageContent(ctx: TranscriptRenderCtx, msg: ChatMessage, isLast: boolean) {
  let thinkNth = 0;
  return (
    <div class="w-full space-y-2.5">
      <For each={splitToolRuns(msg.blocks)}>
        {(part) => {
          if (part.kind === "tools") {
            return renderAssistantSpecial(ctx, msg.id, part.units, isLast);
          }
          if (part.kind === "thinking") {
            return (
              <Show when={ctx.verboseChat()}>
                <div class="w-full space-y-2">
                  <For each={part.blocks}>
                    {(block) => renderThinkingBlock(ctx, msg, block, thinkNth++)}
                  </For>
                </div>
              </Show>
            );
          }
          return (
            <For each={part.blocks}>
              {(block) => {
                if (block.type === "text" && block.text) {
                  return (
                    <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
                      <Streamdown>{block.text}</Streamdown>
                    </div>
                  );
                }
                if (block.type === "image") return renderImageBlock(ctx, block);
                return null;
              }}
            </For>
          );
        }}
      </For>
    </div>
  );
}
/**
 * Renders ONE render block: either a series (lead text/thinking in wire
 * order, then the aggregate card of the whole fused run) or a single
 * message with the legacy per-bubble chrome (edit/copy/regenerate/delete
 * on its own rendered position).
 */

export function renderSeriesLead(ctx: TranscriptRenderCtx, series: RenderBlockSeries) {
  const all = () => [series.msg, ...series.extras];
  const thoughts = createMemo(() => all().flatMap((msg) => msg.blocks.filter((b) => b.type === "reasoning" && !!b.reasoning?.trim()).map((block, nth) => ({msg, block, nth}))));
  const live = () => thoughts().some((entry) => entry.msg.id === ctx.messages().at(-1)?.id && ctx.thinkingStart() !== null && ctx.sessionStatus() === "running");
  const key = `${series.msg.id}:group-thinking`;
  const open = () => ctx.expandedThinking()[key] ?? live();
  const entryDuration = (entry: { msg: ChatMessage }) => {
    if (entry.msg.id === ctx.messages().at(-1)?.id && ctx.thinkingStart() !== null) {
      return `${ctx.thinkingElapsed()}s`;
    }
    return entry.msg.thinkingDuration !== undefined ? `${entry.msg.thinkingDuration}s` : "—";
  };
  const maxDurLen = createMemo(() => Math.max(3, ...thoughts().map((e) => entryDuration(e).length)));
  return <div class="w-full space-y-2.5">
    <Show when={ctx.verboseChat() && thoughts().length}>
      <Show when={thoughts().length > 1} fallback={<For each={thoughts()}>{(entry) => renderThinkingBlock(ctx, entry.msg, entry.block, entry.nth)}</For>}>
        <div class="w-full" data-grouped-thinking>
          <button aria-expanded={open()} onClick={() => ctx.setExpandedThinking((prev) => ({...prev, [key]:!open()}))} class="flex items-center gap-1.5 text-xs text-ink-500 hover:text-ink-300 cursor-pointer">
            <Iconify icon="lucide:bot" size={14} /><span>Thinking</span><Iconify icon="lucide:chevron-down" size={12} class={open() ? "rotate-180" : ""} />
          </button>
          <Show when={open()}><ol class="mt-2 max-h-64 overflow-y-auto [scrollbar-gutter:stable] space-y-3 text-xs text-ink-400 leading-relaxed">
            <For each={thoughts()}>{(entry) => <li class="flex gap-3 items-start">
              <span class="w-10 shrink-0 text-right tabular-nums font-mono whitespace-pre text-ink-500">{entryDuration(entry).padStart(maxDurLen(), " ")}</span>
              <span class="pl-3 border-l border-line whitespace-pre-wrap break-words min-w-0">{entry.block.reasoning}</span>
            </li>}</For>
          </ol></Show>
        </div>
      </Show>
    </Show>
    <For each={all()}>{(message) => <For each={message.blocks.filter((b) => b.type === "image" || b.type === "text" && !!b.text?.trim())}>{(block) => block.type === "image" ? renderImageBlock(ctx, block) : <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto"><Streamdown>{block.text}</Streamdown></div>}</For>}</For>
  </div>;
}
/**
 * Per-series collapsible sub-groups (explore/command runs) inside the
 * special card. Same grouping as before, keyed on the series card so
 * state never collides across fused messages.
 */

export function renderToolSegs(ctx: TranscriptRenderCtx, msgId: string, keySalt: string, units: ToolUnit[], running: boolean) {
  // Partition consecutive explore/command runs into collapsible groups
  // (pure helper — algorithm lives in utils/toolSegs, covered by tests).
  const segs = partitionToolSegs(units);
  return (
    <div class="w-full space-y-0.5">
      <For each={segs}>
        {(seg, si) => {
          if (seg.kind === "unit") return renderToolUnit(ctx, msgId, seg.unit, seg.idx, running);
          const gkey = `${msgId}:${keySalt}:g${si()}`;
          const open = () => ctx.toolGroupOpen()[gkey] ?? true;
          return (
            <div class="w-full">
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
                <div class="ml-3 border-l border-line/40 pl-1.5 space-y-0.5">
                  <For each={seg.units}>
                    {(u, ui) => renderToolUnit(ctx, msgId, u, ui() + si() * 100, running)}
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

export function renderToolUnit(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: boolean) {
  const m = useToolUnitModel(ctx, msgId, u, ui, running);
  const part = { ctx, msgId, u, m, running };
  if (m.name() === "question") return <div class="flex items-center gap-2 pl-1 py-1 text-[13px]" data-question-summary><Iconify icon="lucide:message-circle" size={14} class="text-ink-500 shrink-0" /><span class="text-ink-500">{m.sum().verb}</span><span class="text-ink-200 truncate">{m.sum().target}</span></div>;
  return (
    <div class="w-full">
      <ToolUnitHeader {...part} />
      <Show when={m.open()}>
        <div class="ml-5 mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 overflow-hidden">
          <ToolEditBodies {...part} />
          <ToolSearchBodies {...part} />
        </div>
      </Show>
    </div>
  );
}
