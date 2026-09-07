import { createMemo, For, Show, type JSX } from "solid-js";
import { Streamdown } from "streamdown-solid";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import type { ChatMessage, ContentBlock, RenderBlock, RenderBlockSeries, ToolUnit } from "../types";
import { msgIsEmpty, splitToolRuns, toolCatOf, tryParseArgs } from "../utils/tools";
import { elapsedLabel } from "../utils/format";
import { absoluteRemotePath } from "../paths";
import { groupTitle, specialTitle, toolRowKey } from "../utils/titles";
import { toolSummary, terminalPresentation } from "../transcript";
import { CodeBlock, DiffView, ShellCmd } from "./CodeBlock";
import { FileIcon } from "../presentation";
import { languageForPath } from "../utils/lang";

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
  // Partition consecutive explore/command runs into collapsible groups.
  const segs: Array<{ kind: "group"; cat: "explore" | "command"; units: ToolUnit[] } | { kind: "unit"; unit: ToolUnit; idx: number }> = [];
  let run: ToolUnit[] = [];
  let runIdx: number[] = [];
  let runCat: "explore" | "command" | null = null;
  const flush = () => {
    if (run.length >= 2 && runCat) segs.push({ kind: "group", cat: runCat, units: run });
    else run.forEach((unit, k) => segs.push({ kind: "unit", unit, idx: runIdx[k] }));
    run = [];
    runIdx = [];
    runCat = null;
  };
  units.forEach((unit, i) => {
    const cat = toolCatOf(unit.call?.toolName);
    if ((cat === "explore" || cat === "command") && (runCat === null || runCat === cat)) {
      runCat = cat;
      run.push(unit);
      runIdx.push(i);
    } else {
      flush();
      if (cat === "explore" || cat === "command") {
        runCat = cat;
        run.push(unit);
        runIdx.push(i);
      } else {
        segs.push({ kind: "unit", unit, idx: i });
      }
    }
  });
  flush();
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
  const key = () => toolRowKey(msgId, u, ui);
  const open = () => ctx.toolOpen()[key()] ?? (running && !u.result);
  const sum = createMemo(() => toolSummary(u));
  const prog = () => (u.call?.toolId ? ctx.toolProgress()[u.call.toolId] : undefined);
  const args = createMemo(() => tryParseArgs(u.call?.toolArgs));
  const name = () => u.call?.toolName || "tool";
  // Full shell command for the highlighted header: commands[] joined with
  // the effective joiner (&& or ;), else the single command. Python rows
  // show script + args or the first code line (same as the summary).
  const bashHeaderCmd = () => {
    if (name() === "python") return sum().target || "";
    const a: any = args();
    if (Array.isArray(a.commands) && a.commands.length > 0) {
      return a.commands.map(String).join(a.stopOnError === false ? " ; " : " && ");
    }
    return String(a.command || sum().target || "");
  };
  const terminal = createMemo(() => terminalPresentation(u.result?.toolResult || ""));
  const webDetails = () => {
    const d: any = u.result?.toolDetails;
    if (!d || !Array.isArray(d.results)) return undefined;
    return d as { query?: string; cached?: boolean; results: { title?: string; url?: string; snippet?: string }[] };
  };
  const fetchDetails = () => {
    const d: any = u.result?.toolDetails;
    if (!d || typeof d.url !== "string") return undefined;
    return d as { url: string; host?: string; title?: string; content?: string; truncated?: boolean };
  };
  const elapsed = () => {
    if (name() !== "bash" && name() !== "python") return "";
    const duration = u.result?.toolDurationMs ?? terminal().durationMs;
    if (duration !== undefined) return ctx.elapsedLabel(duration);
    const start = ctx.toolStarts()[u.call?.toolId || ""];
    return start ? ctx.elapsedLabel(ctx.turnClock() - start) : "";
  };
  if (name() === "question") return <div class="flex items-center gap-2 pl-1 py-1 text-[13px]" data-question-summary><Iconify icon="lucide:message-circle" size={14} class="text-ink-500 shrink-0" /><span class="text-ink-500">{sum().verb}</span><span class="text-ink-200 truncate">{sum().target}</span></div>;
  return (
    <div class="w-full">
      <div
        onClick={() => ctx.toggleToolOpen(key())}
        class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
      >
        <Show
          when={!(running && !u.result)}
          fallback={
            <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
          }
        >
          <Iconify
            icon={sum().icon}
            size={14}
            class="shrink-0 text-ink-500"
          />
        </Show>
        <span class="text-ink-500 shrink-0">{sum().verb}</span>
        <span class="flex items-center gap-2 min-w-0 flex-1">
          <span class="inline-flex items-center gap-2 min-w-0" data-rc-tip={args().path ? absoluteRemotePath(String(args().path), ctx.activeSession()?.cwd || "", ctx.projects().find((p) => p.protected)?.path) : undefined}>
            <Show when={args().path}><FileIcon path={String(args().path)} /></Show>
            <Show when={name() === "bash" || name() === "python"} fallback={
              <span class="truncate text-ink-200 font-medium min-w-0">{sum().target}</span>
            }>
              <span class="truncate text-ink-200 min-w-0 text-[12.5px]"><ShellCmd text={bashHeaderCmd()} /></span>
            </Show>
          </span>
        </span>
        <Show when={sum().statAdd != null || sum().statDel != null}>
          <span class="font-mono text-[11px] shrink-0">
            <Show when={(sum().statAdd || 0) > 0}>
              <span class="text-emerald-400">+{sum().statAdd}</span>
            </Show>
            <Show when={(sum().statAdd || 0) > 0 && (sum().statDel || 0) > 0}>
              <span class="text-ink-600"> </span>
            </Show>
            <Show when={(sum().statDel || 0) > 0}>
              <span class="text-rose-400">-{sum().statDel}</span>
            </Show>
          </span>
        </Show>
        <Show when={sum().stat && sum().statAdd == null}>
          <span class="text-[11px] text-ink-600 shrink-0">{sum().stat}</span>
        </Show>
        <Show when={elapsed()}><span data-tool-duration class="text-[11px] text-ink-500 tabular-nums shrink-0">{elapsed()}</span></Show>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </div>
      <Show when={open()}>
        <div class="ml-5 mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 overflow-hidden">
          {/* Context body per tool kind (scrollable, always inline — the
              collapsible rows already are the "open file/diff" view). */}
          <Show when={name() === "edit" && u.result?.toolResult}>
            <DiffView
              text={u.result?.toolResult || ""}
              max={40}
              name={String(args().path || "")}
            />
            <div class="flex items-center gap-2 px-3 py-1.5 border-t border-line/50">
              <button
                onClick={() => copyWithToast(u.result?.toolResult || "")}
                class="text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer"
              >
                Copy
              </button>
            </div>
          </Show>
          <Show when={name() === "edit" && !u.result}>
            <For each={args().edits || []}>{(edit) => <DiffView text={`${String(edit.oldText || "").split("\n").map((s) => "-" + s).join("\n")}\n${String(edit.newText || "").split("\n").map((s) => "+" + s).join("\n")}`} name={String(args().path || "")} />}</For>
          </Show>
          <Show when={name() === "read"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Reading file…</div>}
            >
              <CodeBlock
                text={u.result?.toolResult || prog() || ""}
                language={languageForPath(String(args().path || ""))}
              />
            </Show>
          </Show>
          <Show when={name() === "write"}>
            <CodeBlock
              text={String(args().content || u.result?.toolResult || "")}
              language={languageForPath(String(args().path || ""))}
            />
          </Show>
          <Show when={name() === "python"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Running Python…</div>}
            >
              <Show when={args().script}>
                <div class="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-ink-500">
                  <FileIcon path={String(args().script || "")} />
                  <span class="font-mono truncate">{String(args().script || "")}{Array.isArray(args().args) && args().args.length > 0 ? ` ${args().args.map(String).join(" ")}` : ""}</span>
                </div>
              </Show>
              <Show when={args().code}>
                <CodeBlock text={String(args().code || "")} language="python" />
              </Show>
              <div class="border-t border-line/50">
                <CodeBlock text={terminal().output || "No output"} language={undefined} />
              </div>
            </Show>
          </Show>
          <Show when={name() === "search"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Searching…</div>}
            >
              <div class="px-3 py-1.5 text-[11px] text-ink-500 font-mono">
                <span class="text-ink-300">/{String(args().pattern || "")}/</span>
                {args().isRegex ? <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">regex</span> : null}
                {args().path && String(args().path) !== "." ? <span class="ml-1.5">in {String(args().path)}</span> : null}
              </div>
              <CodeBlock text={terminal().output || u.result?.toolResult || prog() || ""} language={undefined} />
            </Show>
          </Show>
          <Show when={name() === "inspect"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Listing…</div>}
            >
              <CodeBlock text={terminal().output || u.result?.toolResult || prog() || ""} language={undefined} />
            </Show>
          </Show>
          <Show when={name() === "patch"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Previewing…</div>}
            >
              <Show when={args().dryRun !== false}>
                <div class="mx-3 mt-2 mb-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                  <Iconify icon="lucide:eye" size={12} /> Dry run — no files written
                </div>
              </Show>
              <DiffView text={terminal().output || u.result?.toolResult || prog() || ""} max={60} />
            </Show>
          </Show>
          <Show when={name() === "search_web"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Searching the web…</div>}
            >
              <div class="px-3 pt-2 pb-1 text-[11px] text-ink-500">
                <span class="font-mono text-ink-300">“{String(args().query || webDetails()?.query || "")}”</span>
                <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">DuckDuckGo</span>
                <Show when={webDetails()?.cached}><span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">cached</span></Show>
              </div>
              <Show when={(webDetails()?.results || []).length > 0} fallback={
                <CodeBlock text={terminal().output || u.result?.toolResult || prog() || ""} language={undefined} />
              }>
                <ol class="px-3 pb-2 space-y-1.5">
                  <For each={(webDetails()?.results || []).slice(0, 10)}>{(r: any, i: () => number) =>
                    <li class="group rounded-lg border border-line/60 bg-elev/50 px-2.5 py-1.5 transition-colors hover:border-ink-500">
                      <a href={String(r.url || "")} target="_blank" rel="noreferrer"
                         class="flex items-baseline gap-1.5 text-[12px] leading-snug">
                        <span class="shrink-0 font-mono text-[10px] text-ink-600">{i() + 1}.</span>
                        <span class="font-medium text-ink-100 group-hover:text-accent-300 group-hover:underline line-clamp-1">{String(r.title || r.url || "")}</span>
                      </a>
                      <div class="mt-0.5 truncate font-mono text-[10px] text-ink-600">{String(r.url || "")}</div>
                      <Show when={r.snippet}><p class="mt-0.5 text-[11px] leading-snug text-ink-400 line-clamp-2">{String(r.snippet)}</p></Show>
                    </li>
                  }</For>
                </ol>
                <Show when={(webDetails()?.results || []).length > 10}>
                  <p class="px-3 pb-2 text-[10px] text-ink-600">+{(webDetails()?.results || []).length - 10} more in raw output below</p>
                </Show>
                <details class="border-t border-line/50">
                  <summary class="px-3 py-1 text-[10px] text-ink-600 hover:text-ink-300 cursor-pointer select-none">Raw output</summary>
                  <CodeBlock text={terminal().output || u.result?.toolResult || ""} language={undefined} />
                </details>
              </Show>
            </Show>
          </Show>
          <Show when={name() === "fetch_url"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Fetching {String(args().url || "URL")}…</div>}
            >
              <a href={String(fetchDetails()?.url || args().url || "")} target="_blank" rel="noreferrer"
                 class="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-line/60 bg-elev/50 px-2.5 py-2 transition-colors hover:border-ink-500">
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-500/15 font-mono text-[11px] font-bold text-accent-300">
                  {(fetchDetails()?.host || "?").slice(0, 1).toUpperCase()}
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-[12px] font-medium text-ink-100">{String(fetchDetails()?.title || fetchDetails()?.host || args().url || "Article")}</span>
                  <span class="block truncate font-mono text-[10px] text-ink-500">{String(fetchDetails()?.host || "")}</span>
                </span>
                <Iconify icon="lucide:external-link" size={12} class="ml-auto shrink-0 text-ink-500" />
              </a>
              <Show when={fetchDetails()?.content} fallback={
                <div class="border-t border-line/50 mt-2">
                  <CodeBlock text={terminal().output || u.result?.toolResult || prog() || ""} language="markdown" />
                </div>
              }>
                <div class="px-3 py-2 max-h-96 overflow-y-auto text-[12.5px] leading-relaxed text-ink-200 article-body">
                  <Streamdown>{String(fetchDetails()?.content || "")}</Streamdown>
                </div>
                <Show when={fetchDetails()?.truncated}>
                  <p class="px-3 pb-1 text-[10px] text-ink-600">Truncated — full text in raw output below</p>
                </Show>
                <details class="border-t border-line/50">
                  <summary class="px-3 py-1 text-[10px] text-ink-600 hover:text-ink-300 cursor-pointer select-none">Raw output</summary>
                  <CodeBlock text={terminal().output || u.result?.toolResult || ""} language="markdown" />
                </details>
              </Show>
            </Show>
          </Show>
          <Show when={name() !== "edit" && name() !== "read" && name() !== "write" && name() !== "python" && name() !== "search" && name() !== "inspect" && name() !== "patch" && name() !== "search_web" && name() !== "fetch_url"}>
            <Show
              when={u.result?.toolResult || prog()}
              fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{name() === "question" ? "Waiting for your answers…" : ctx.pendingApproval()?.callId === u.call?.toolId ? "Waiting for approval…" : "Running…"}</div>}
            >
              <pre class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap">
                {name() === "bash" && u.result ? terminal().output || "No output" : u.result?.toolResult || prog() || ""}
              </pre>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}


