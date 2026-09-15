import { createEffect, createMemo, For, Show, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { createDisclosure, DisclosureBody } from "./Disclosure";
import { Streamdown } from "streamdown-solid";
import { followTail } from "../utils/scrollMemory";
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

/** Reactive transcript state shared by aggregate rows. */
export interface TranscriptRenderCtx {
  renderBlocks: () => RenderBlock[];
  sessionStatus: () => string;
  messages: () => ChatMessage[];
  thinkingStart: () => number | null;
  thinkingElapsed: () => number;
  toolProgress: () => Record<string, string>;
  elapsedLabel: (ms: number) => string;
  specialProgress: (units: ToolUnit[]) => string | undefined;
  thinkingIndex: () => number;
  verboseChat: () => boolean;
  hideToolMessages: () => boolean;
  setPreviewFile: (v: import("../types").PreviewFile | null) => void;
  turnClock: () => number;
  toolStarts: () => Record<string, number>;
  activeSession: () => import("../types").SessionSummary | null;
  pendingApproval: () => import("../types").PendingApproval | null;
  projects: () => import("../types").Project[];
  /** Live background job registry — lets bash/python rows keep spinning
   * and streaming after their detach, independent of the turn. */
  backgroundJobs: () => import("../hooks/useBackground").BgTask[];
  /** Per-job streamed output (bg_output chunks + bg_tail seed). */
  bgOutput: () => Record<string, string>;
  /** 1s ticker while any job runs, for elapsed labels. */
  bgClock: () => number;
}

/** Thinking as a tool-style row: header (bot icon + timer) with a
 * Streamdown body. Open by default while the turn runs, closed after —
 * unless the user toggled it explicitly. */
function renderThinkingRow(
  ctx: TranscriptRenderCtx,
  entry: Extract<TurnEntry, { kind: "thinking" }>,
  openByDefault: () => boolean,
  hidden: () => boolean,
  live: () => boolean,
  streaming: () => boolean,
  running: () => boolean,
) {
  const key = `${entry.msg.id}:think:${entry.nth}`;
  const { open, toggle } = createDisclosure(() => `${running()}:${live()}`, openByDefault);
  const label = () =>
    live()
      ? `Thinking ${ctx.thinkingElapsed()}s`
      : entry.msg.thinkingDuration !== undefined
        ? `Thinking ${entry.msg.thinkingDuration}s`
        : open()
          ? "Hide thinking"
          : "Thinking";
  return (
    <div style={hidden() ? { display: "none" } : undefined} data-thinking-row={key}>
      <div
        onClick={toggle}
        class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
      >
        <Show
          when={!live()}
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
      <DisclosureBody open={open()}>
        <div
          ref={(el) => onCleanup(followTail(el, () => open() && streaming()))}
          class="rc-markdown w-full text-xs leading-relaxed break-words overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] max-h-64 pl-1 pb-1 text-ink-400"
        >
          <Streamdown components={transcriptMarkdownComponents}>
            {entry.block.reasoning || "(thinking…)"}
          </Streamdown>
        </div>
      </DisclosureBody>
    </div>
  );
}

/** Assistant text as a tool-style row: header with a one-line preview and
 * a Streamdown body. Hidden (display:none, kept in the DOM) while the
 * hide-tool-messages rule, verbose filter, fuzzy dedup or the featured
 * final message takes it out of the card. */
function renderTextRow(
  entry: Extract<TurnEntry, { kind: "text" }>,
  openByDefault: () => boolean,
  hidden: () => boolean,
  streaming: () => boolean,
  running: () => boolean,
) {
  const key = `${entry.msg.id}:text:${entry.nth}`;
  const { open, toggle } = createDisclosure(() => `${running()}:${streaming()}`, openByDefault);
  const preview = () =>
    (entry.block.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return (
    <div style={hidden() ? { display: "none" } : undefined} data-text-row={key}>
      <div
        onClick={toggle}
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
      <DisclosureBody open={open()}>
        <div
          ref={(el) => onCleanup(followTail(el, () => open() && streaming()))}
          class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] max-h-96 pl-1 pb-1"
        >
          <Streamdown components={transcriptMarkdownComponents}>{entry.block.text}</Streamdown>
        </div>
      </DisclosureBody>
    </div>
  );
}

/**
 * The turn aggregate: one card per turn with every thinking, message and
 * tool run in event order. Open by default while the turn runs (verbose no
 * longer affects this), closed once it ends — unless toggled explicitly.
 * Questions stay collapsed here; the questionnaire renders separately.
 */
function renderTurnAggregate(
  ctx: TranscriptRenderCtx,
  series: RenderBlockSeries,
) {
  // NOTE: ctx.renderBlocks() is the FULL list (window only affects the <For>);
  // the running turn is always the newest block, which is always visible.
  const running = createMemo(() => ctx.renderBlocks().at(-1)?.msg.id === series.msg.id && ctx.sessionStatus() === "running");
  const summary = createMemo(() => specialTitle(series.units, {
    texts: series.entries.filter((e) => e.kind === "text").length,
    thoughts: series.entries.filter((e) => e.kind === "thinking").length,
  }));
  const { open, toggle } = createDisclosure(() => String(running()), running);
  /** The featured final renders below once idle; inside the card its rows
   * stay mounted with display:none so Solid keeps DOM identity. */
  const featured = () => series.finalMsgId != null && !running();
  const lastTurnId = () => series.extras.at(-1)?.id ?? series.msg.id;
  /** Live tail: the turn's latest call, or any call with live progress
   * (parallel in-flight). Only the tail spins/auto-opens; when a new
   * entry arrives the previous one falls back to closed on its own. */
  const tailCall = () => [...series.units].reverse().find((u) => u.call) ?? null;
  const isActive = (u: ToolUnit) =>
    running() && !u.result && !!u.call?.toolId && (
      ctx.toolStarts()[u.call.toolId] != null || ctx.toolProgress()[u.call.toolId] != null ||
      ctx.pendingApproval()?.callId === u.call.toolId ||
      ((series.extras.at(-1) ?? series.msg).streaming === true &&
        (series.extras.at(-1) ?? series.msg).blocks.some((b) => b.toolId === u.call?.toolId) &&
        u.call.toolId === tailCall()?.call?.toolId));
  const isPending = (u: ToolUnit) => running() && !u.result && !!u.call?.toolId &&
    (series.extras.at(-1) ?? series.msg).blocks.some((b) => b.type === "tool_call" && b.toolId === u.call?.toolId);
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
  // Invisible notes must not split a visible command/exploration run. Keep
  // those rows mounted; attach merged units to the first tool entry's key.
  const visibleRuns = createMemo(() => {
    const runs = new Map<string | undefined, ToolUnit[]>();
    let run: ToolUnit[] | undefined;
    series.entries.forEach((entry, idx) => {
      if (entry.kind === "tools") {
        if (!run) { run = []; runs.set(entry.id, run); }
        run.push(...entry.units);
      } else if (!(entry.kind === "thinking" && thinkingHidden()) &&
        !(entry.kind === "text" && textHidden(entry, idx))) {
        run = undefined;
      }
    });
    return runs;
  });
  return (
    <div class="w-full border-t border-line/60 overflow-hidden mt-1">
      <button
        onClick={toggle}
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
      <DisclosureBody open={open()}>
        <div class="border-t border-line/60 px-2 py-1.5 space-y-0.5">
          <For each={series.entries}>
            {(entry, ei) => {
              const tail = () => ei() === lastEntryIdx();
              if (entry.kind === "tools") {
                return renderToolSegs(ctx, entry.msg.id, () => visibleRuns().get(entry.id) ?? [], running, isActive, isPending);
              }
              if (entry.kind === "thinking") {
                // Stale snapshot restarts must not spin: live only while
                // the tail is still thinking AND the clock is actually on.
                const live = () => tail() && tailIsThinking() && running() && entry.isNewest &&
                  entry.msg.id === lastTurnId() && ctx.thinkingStart() !== null;
                const content = () => (entry.block.reasoning || "").trim() !== "";
                return renderThinkingRow(ctx, entry, () => live() && content(), thinkingHidden, live, live, running);
              }
              if (entry.kind === "text") {
                const content = () => (entry.block.text || "").trim() !== "";
                const streaming = () => running() && tail() && entry.msg.streaming === true;
                return renderTextRow(entry, () => streaming() && content(), () => textHidden(entry, ei()), streaming, running);
              }
              return renderImageBlock(ctx, entry.block);
            }}
          </For>
        </div>
      </DisclosureBody>
    </div>
  );
}

/** The same carrier can acquire reasoning/tools after its first text delta. */
export function AssistantTurnContent(props: { ctx: TranscriptRenderCtx; block: RenderBlock; finished: boolean }) {
  return <Show when={props.block.kind === "series" ? props.block : undefined}
    fallback={renderSingleAssistant(props.ctx, props.block.msg)}>
    {(series) => <>
      {renderTurnAggregate(props.ctx, series())}
      <Show when={props.finished && series().finalMsgId != null}>
        <div class="w-full mt-2.5" data-turn-final>{renderFinalMsg(props.ctx, series())}</div>
      </Show>
    </>}
  </Show>;
}

/** Featured final message of a finished turn, rendered as a plain bubble
 * below the aggregate (the files balloon comes right after). */
function renderFinalMsg(ctx: TranscriptRenderCtx, series: RenderBlockSeries) {
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
function renderSingleAssistant(ctx: TranscriptRenderCtx, msg: ChatMessage) {
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


function renderImageBlock(ctx: TranscriptRenderCtx, block: ContentBlock) {
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
function renderToolSegs(ctx: TranscriptRenderCtx, msgId: string, units: () => ToolUnit[], running: () => boolean, isActive: (u: ToolUnit) => boolean = running, isPending = isActive) {
  // Partition consecutive explore/command runs into collapsible groups
  // (pure helper — algorithm lives in utils/toolSegs, covered by tests).
  const [state, setState] = createStore<{ segs: (ToolSeg & { id: string })[] }>({ segs: [] });
  createEffect(() => setState("segs", reconcile(
    partitionToolSegs(units(), true).map((seg) => ({ ...seg, id: segKey(seg) })), { merge: true },
  )));
  // Key by the first call so a growing subgroup retains its DOM and scroll.
  const segKey = (seg: ToolSeg) =>
    seg.kind === "unit"
      ? `u:${seg.unit.call?.toolId || seg.unit.result?.toolId || "i" + seg.idx}`
      : `g:${seg.cat}:${seg.units[0]?.call?.toolId || seg.units[0]?.result?.toolId || "0"}`;
  return (
    <div class="w-full space-y-0.5" style={{ "overflow-anchor": "none" }}>
      <For each={state.segs}>
        {(seg) => {
          if (seg.kind === "unit")
            return (
              <div data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
                {renderToolUnit(ctx, msgId, seg.unit, seg.idx, running, () => isActive(seg.unit))}
              </div>
            );
          const active = () => running() && seg.units.some(isPending);
          // Sub-groups open while they hold live work; a finished group
          // (and its rows) falls back to closed on its own.
          const { open, toggle } = createDisclosure(() => `${running()}:${active()}`, active);
          return (
            <div class="w-full" data-toolseg={segKey(seg)} style={{ "overflow-anchor": "none" }}>
              <Show when={seg.units.length > 1}><button
                onClick={toggle}
                class="w-full flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-lg hover:bg-ink-900/70 text-[13px] text-ink-400 hover:text-ink-200 cursor-pointer"
              >
                <span class="font-medium">{groupTitle(seg.cat, seg.units)}</span>
                <Iconify
                  icon="lucide:chevron-down"
                  size={12}
                  class={`text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
                />
              </button></Show>
              <DisclosureBody open={seg.units.length === 1 || open()}>
                <div class={seg.units.length > 1 ? "ml-3 border-l border-line/40 pl-1.5 space-y-0.5" : "space-y-0.5"} style={{ "overflow-anchor": "none" }}>
                  <For each={seg.units}>
                    {(u) => {
                      // Keep fallback keys relative to the complete tool run.
                      const gi = units().findIndex((item) => item.call?.toolId === u.call?.toolId);
                      return renderToolUnit(ctx, msgId, u, gi >= 0 ? gi : 0, running, () => isActive(u));
                    }}
                  </For>
                </div>
              </DisclosureBody>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function renderToolUnit(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: () => boolean, active: () => boolean) {
  const m = useToolUnitModel(ctx, msgId, u, ui, running, active);
  const part = { ctx, msgId, u, m, get running() { return running(); }, get active() { return active(); } };
  return (
    <div class="w-full">
      <ToolUnitHeader {...part} />
      <DisclosureBody open={m.open()}>
        <div class="mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 max-h-96 overflow-auto overscroll-contain [scrollbar-gutter:stable]">
          <ToolEditBodies {...part} />
          <ToolSearchBodies {...part} />
          <ToolQuestionBodies {...part} />
        </div>
      </DisclosureBody>
    </div>
  );
}
