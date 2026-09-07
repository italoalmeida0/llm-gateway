import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import { QuestionPanel } from "./QuestionModal";
import { Streamdown } from "streamdown-solid";
import { FileIcon } from "../presentation";
import { tryParseArgs } from "../utils/tools";
import { timeAgo } from "../utils/format";
import type { RemoteCodeViewCtx } from "../viewCtx";
import {
  renderAssistantSpecial, renderImageBlock, renderMessageContent, renderSeriesLead,
} from "./TranscriptBlocks";

export function TranscriptView(ctx: RemoteCodeViewCtx) {
  return (
<>
<Show when={ctx.activeHost() && ctx.connectionState() !== "connected"}>
  <div role="status" class="border-b border-line bg-elev px-4 py-2 text-center text-xs text-ink-400">
    Connection interrupted. Reconnecting to your host…
  </div>
</Show>


{/* Floating top-left: back + sidebar toggle (no topbar) */}
<div class="absolute top-2 left-2 z-20 flex items-center gap-1.5">
  <a
    href="#/"
    class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm"
    data-rc-tip="Back to LLM Gateway"
  >
    <Iconify icon="lucide:arrow-left" size={14} />
  </a>
  <button
    onClick={() => ctx.setSidebarOpen(!ctx.sidebarOpen())}
    class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm cursor-pointer"
    data-rc-tip={ctx.sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"} aria-label={ctx.sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
  >
    <Iconify
      icon={
        ctx.sidebarOpen()
          ? "lucide:panel-left-close"
          : "lucide:panel-left-open"
      }
      size={14}
    />
  </button>
</div>

{/* Chat Stream Viewport */}
<Show
  when={!ctx.historyView()}
  fallback={
    <div class="flex-1 overflow-y-auto px-4 md:px-8 py-8">
      <div class="max-w-2xl mx-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-semibold text-ink-100">Conversation History</h2>
          <button
            onClick={() => ctx.setHistoryView(false)}
            class="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
            data-rc-tip="Back to chat" aria-label="Back to chat"
          >
            <Iconify icon="lucide:x" size={15} />
          </button>
        </div>
        <div class="relative mb-4">
          <Iconify icon="lucide:search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
          <input
            type="text"
            placeholder={
              ctx.isMobile()
                ? "Search conversations and ctx.messages..."
                : "Search conversations and ctx.messages... (Ctrl+K)"
            }
            class="w-full text-[13px] bg-ink-900 border border-line/70 rounded-xl pl-9 pr-3 py-2 text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            value={ctx.sessionFilter()}
            onInput={(e) => {
              ctx.setSessionFilter(e.currentTarget.value);
              ctx.queueDaemonSearch(e.currentTarget.value);
            }}
            ref={(el) => setTimeout(() => el?.focus(), 50)}
          />
        </div>
        {/* Daemon full-text hits (message content, host-local) */}
        <Show when={ctx.searchResults().length > 0}>
          <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
            Message matches
          </div>
          <div class="space-y-1 mb-4">
            <For each={ctx.searchResults()}>
              {(r) => (
                <button
                  onClick={() => {
                    ctx.setHistoryView(false);
                    ctx.setSearchResults([]);
                    ctx.selectSession(r.sessionId);
                  }}
                  class="w-full text-left px-3 py-2.5 rounded-xl border border-line/50 hover:bg-ink-900/70 transition-colors cursor-pointer"
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-[13px] text-ink-200 truncate font-medium">{r.title}</span>
                    <span class="text-[11px] text-ink-600 shrink-0">
                      {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}{timeAgo(r.updatedAt)}
                    </span>
                  </div>
                  <p class="text-[11px] text-ink-500 mt-1 line-clamp-2 leading-relaxed">{r.snippet}</p>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
          Conversations
        </div>
        <div class="space-y-1">
          <For
            each={ctx.sortedSessions(ctx.sessions().filter(ctx.matchQuery))}
            fallback={
              <p class="text-xs text-ink-600 py-6 text-center">No conversations found.</p>
            }
          >
            {(s) => (
              <button
                onClick={() => {
                  ctx.setHistoryView(false);
                  ctx.selectSession(s.id);
                }}
                class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-ink-900/70 transition-colors group cursor-pointer"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-[13px] text-ink-200 truncate font-medium">{s.title}</span>
                  <span class="text-[11px] text-ink-600 shrink-0">{timeAgo(s.updatedAt)}</span>
                </div>
                <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-ink-500">
                  <Iconify icon="lucide:folder" size={11} />
                  <span class="truncate font-mono">{s.cwd}</span>
                </div>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  }
>
<Show when={!ctx.draftMode()}>
<div
  ref={ctx.setChatContainerRef}
  onScroll={ctx.onChatScroll}
  onWheel={(e) => { if (e.deltaY < 0) ctx.transcriptScroll.detach(); }}
  onPointerDown={() => ctx.transcriptScroll.detach()}
  onTouchMove={() => ctx.transcriptScroll.detach()}
  onKeyDown={(e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) ctx.transcriptScroll.detach(); }}
  tabindex="0"
  aria-label="Conversation"
  class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 md:px-8 select-text [overflow-anchor:none] [scrollbar-gutter:stable]"
>
<div ref={ctx.setChatContentRef} class="pt-6 pb-10 space-y-6"
>
  {/* Conversation Messages.
      buildRenderBlocks fuses consecutive assistant messages that
      are tool-only into one "series" block. Index bookkeeping
      below stays on RAW message positions: series extras are
      skipped for actions, and the lead keeps its own raw index so
      every per-message op still maps 1:1 to the daemon
      transcript — fusing is purely visual. */}
  <Show when={ctx.hiddenCount() > 0}>
    <div class="flex justify-center">
      <button
        onClick={() => ctx.growWindow()}
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-ink-900 border border-line/70 text-ink-300 shadow hover:text-ink-100 cursor-pointer"
      >
        <Iconify icon="lucide:chevron-up" size={13} />
        <span>Load {Math.min(20, ctx.hiddenCount())} older ({ctx.hiddenCount()} hidden)</span>
      </button>
    </div>
  </Show>
  <For each={ctx.visibleBlocks()}>
    {(block, bi) => {
      const msg = block.msg;
      const isLast = () => bi() === ctx.visibleBlocks().length - 1;
      const rawIdx = () => ctx.blockRawIdx(block);
      const textOf = () =>
        msg.blocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("\n");
      const isEditing = () => ctx.editingMsgIdx() === rawIdx();
      return (
        <div
          class={`group/msg flex flex-col w-full ${ctx.convWidthClass()} mx-auto ${
            msg.role === "user" && !isEditing() ? "items-end" : "items-start"
          }`}
        >
          {/* ===== SYSTEM NOTICE (e.g. auto-compaction) ===== */}
          <Show when={msg.system}>
            <div class="w-full flex justify-center">
              <div class="max-w-xl text-center px-4 py-2.5 rounded-xl border border-line/60 bg-ink-900/60">
                <div class="flex items-center justify-center gap-1.5 text-xs font-medium text-ink-300">
                  <Iconify icon="lucide:boxes" size={13} class="text-ink-500" />
                  <span>Context auto-compacted — oldest 30% summarized</span>
                </div>
                <details class="mt-1.5 text-left">
                  <summary class="text-[11px] text-ink-500 hover:text-ink-300 cursor-pointer select-none text-center">
                    View summary
                  </summary>
                  <div class="rc-markdown mt-2 text-left text-xs max-h-48 overflow-y-auto">
                    <Streamdown>{textOf().replace(/^## Context Summary \(compacted\)\n\n/, "")}</Streamdown>
                  </div>
                </details>
              </div>
            </div>
          </Show>
          <Show when={!msg.system}>
          {/* ===== USER ===== */}
          <Show when={msg.role === "user"}>
            <div class={isEditing() ? "w-full" : "flex flex-col items-end max-w-[90%] sm:max-w-[80%]"}>
              <Show when={msg.attachments && msg.attachments.length > 0}>
                <div class={`flex flex-wrap gap-1.5 mb-1.5 ${isEditing() ? "justify-start" : "justify-end"}`}>
                  <For each={msg.attachments || []}>
                    {(name) => (
                      <span class="text-[11px] bg-ink-900 border border-line/70 px-2 py-1 rounded-lg text-ink-400 flex items-center gap-1.5">
                        <FileIcon path={name} size={13} />
                        {name}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              {/* Inline edit mode (chatbot) */}
              <Show
                when={isEditing()}
                fallback={
                  <div class="bg-ink-900 border border-line/70 text-ink-100 px-3.5 py-2.5 rounded-2xl rounded-tr-md">
                    <p class="whitespace-pre-line text-sm leading-relaxed">{textOf()}</p>
                  </div>
                }
              >
                <div class="w-full bg-ink-900 p-3 rounded-2xl border border-ink-500/60 shadow-lg">
                  <textarea
                    value={ctx.editingMsgText()}
                    onInput={(e) => ctx.setEditingMsgText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        ctx.saveEditMsg(rawIdx(), msg);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        ctx.cancelEditMsg();
                      }
                    }}
                    class="w-full bg-transparent text-ink-100 text-sm outline-none resize-y min-h-[96px] leading-relaxed"
                    rows={4}
                    ref={(el) => setTimeout(() => el?.focus(), 40)}
                  />
                  <div class="flex justify-end items-center gap-2 mt-2 pt-2 border-t border-line/40">
                    <button
                      onClick={ctx.cancelEditMsg}
                      class="text-xs text-ink-400 hover:text-ink-100 px-3 py-1.5 rounded-lg hover:bg-ink-800 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => ctx.saveEditMsg(rawIdx(), msg)}
                      class="text-xs bg-ink-100 text-ink-950 px-3.5 py-1.5 rounded-lg hover:bg-accent-400 font-medium transition-colors cursor-pointer"
                    >
                      Save and Send
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={!isEditing()}>
                <div class="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                  <button onClick={() => ctx.forkMessage(block)} disabled={ctx.forking() || (block.kind === "series" ? block.extras.at(-1) || msg : msg).srcIdx == null}
                    class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-elev transition-colors cursor-pointer disabled:opacity-40"
                    data-rc-tip="Fork conversation from here" aria-label="Fork conversation from here">
                    <Iconify icon="lucide:git-branch" size={14} />
                  </button>
                  <Show when={textOf().trim() !== ""}>
                    <button
                      onClick={() => ctx.copyMsg(msg.id, textOf())}
                      class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                      data-rc-tip="Copy" aria-label="Copy"
                    >
                      <Iconify icon={ctx.copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={13} />
                    </button>
                  </Show>
                  <button
                    onClick={() => ctx.startEditMsg(rawIdx(), msg)}
                    class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                    data-rc-tip="Edit and resend" aria-label="Edit and resend"
                  >
                    <Iconify icon="lucide:pencil" size={13} />
                  </button>
                  <button
                    onClick={() => ctx.deleteMsg(rawIdx())}
                    class="p-1 rounded-md text-ink-500 hover:text-rose-400 hover:bg-ink-900 transition-colors cursor-pointer"
                    data-rc-tip="Delete" aria-label="Delete"
                  >
                    <Iconify icon="lucide:trash-2" size={13} />
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          {/* ===== ASSISTANT ===== */}
          <Show when={msg.role !== "user"}>
            <div class="w-full flex flex-col items-start overflow-hidden">
              {/* Loading dots while the first tokens arrive */}
              <Show
                when={
                  ctx.sessionStatus() === "running" &&
                  isLast() &&
                  msg.blocks.length === 0
                }
              >
                <div class="dot-typing flex items-center gap-1 px-1 py-2">
                  <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                  <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                  <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                </div>
              </Show>

              {block.kind === "series" ? <>
                {renderSeriesLead(ctx, block)}
                <Show when={block.units.length}>{renderAssistantSpecial(ctx, msg.id, block.units, isLast(), block.extras.map((e) => e.srcIdx ?? 0))}</Show>
              </> : renderMessageContent(ctx, msg, isLast())}

              {/* Hover actions (chatbot-style) */}
              <Show when={(ctx.sessionStatus() !== "running" || !isLast()) && !isEditing()}>
                <div class="flex items-center gap-0.5 mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                  <button onClick={() => ctx.forkMessage(block)} disabled={ctx.forking() || (block.kind === "series" ? block.extras.at(-1) || msg : msg).srcIdx == null}
                    class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-elev transition-colors cursor-pointer disabled:opacity-40"
                    data-rc-tip="Fork conversation from here" aria-label="Fork conversation from here">
                    <Iconify icon="lucide:git-branch" size={14} />
                  </button>
                  <Show when={textOf().trim() !== ""}>
                    <button
                      onClick={() => ctx.copyMsg(msg.id, textOf())}
                      class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                      data-rc-tip="Copy" aria-label="Copy"
                    >
                      <Iconify icon={ctx.copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={14} />
                    </button>
                  </Show>
                  <button
                    onClick={() => ctx.regenerateMsg(rawIdx())}
                    class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                    data-rc-tip="Regenerate response" aria-label="Regenerate response"
                  >
                    <Iconify icon="lucide:rotate-cw" size={14} />
                  </button>
                </div>
              </Show>
            </div>
          </Show>
          </Show>
        </div>
      );
    }}
  </For>

  {/* Pending Tool Approval (Antigravity-style, human-readable) */}
  <Show when={ctx.pendingApproval()}>
    {(pa) => {
      const args = tryParseArgs(pa().args);
      const name = pa().tool || "tool";
      return (
        <div class={`${ctx.convWidthClass()} mx-auto rounded-2xl border border-amber-500/40 bg-amber-500/[0.06] p-4 shadow-xl`}>
          <div class="flex items-center gap-2 text-[13px]">
            <Iconify icon="lucide:shield" size={15} class="text-amber-400 shrink-0" />
            <span class="font-semibold text-ink-100">Review tool call</span>
            <span class="text-[11px] text-ink-500">Safe mode — nothing ran yet</span>
          </div>
          {/* Human summary per tool (never raw JSON) */}
          <div class="mt-2.5 rounded-xl border border-line/60 bg-ink-950/70 overflow-hidden">
            <Show when={name === "bash"}>
              <div class="px-3.5 py-2.5">
                <div class="text-[11px] text-ink-500 mb-1">Run command</div>
                <pre class="font-mono text-[13px] text-ink-100 whitespace-pre-wrap break-all">{String(args.command || "")}</pre>
              </div>
            </Show>
            <Show when={name === "read"}>
              <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                <FileIcon path={String(args.path || "")} size={14} />
                <span class="text-ink-500">Read</span>
                <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                <Show when={args.limit || args.offset}>
                  <span class="font-mono text-[11px] text-ink-500 shrink-0">
                    L{Number(args.offset || 0) + 1}-{Number(args.offset || 0) + Number(args.limit || 0)}
                  </span>
                </Show>
              </div>
            </Show>
            <Show when={name === "write"}>
              <div class="px-3.5 py-2.5 text-[13px]">
                <div class="flex items-center gap-2">
                  <FileIcon path={String(args.path || "")} size={14} />
                  <span class="text-ink-500">Create</span>
                  <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                </div>
                <Show when={args.content}>
                  <pre class="mt-2 font-mono text-[11px] text-ink-400 whitespace-pre-wrap max-h-32 overflow-y-auto border-t border-line/50 pt-2">
                    {String(args.content).split("\n").slice(0, 12).join("\n")}
                    {String(args.content).split("\n").length > 12 ? "\n…" : ""}
                  </pre>
                </Show>
              </div>
            </Show>
            <Show when={name === "edit"}>
              <div class="px-3.5 py-2.5 text-[13px]">
                <div class="flex items-center gap-2">
                  <FileIcon path={String(args.path || "")} size={14} />
                  <span class="text-ink-500">Edit</span>
                  <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                  <Show when={Array.isArray(args.edits)}>
                    <span class="text-[11px] text-ink-500 shrink-0">
                      {args.edits.length} change{args.edits.length === 1 ? "" : "s"}
                    </span>
                  </Show>
                </div>
                <Show when={Array.isArray(args.edits) && args.edits.length > 0}>
                  <div class="mt-2 rounded-lg overflow-hidden border border-line/50 font-mono text-[11px]">
                    <For each={args.edits.slice(0, 2)}>
                      {(e: any) => (
                        <>
                          <div class="px-2.5 py-1 bg-rose-500/10 text-rose-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                            {(String(e.oldText || "").split("\n").slice(0, 6).join("\n"))}
                          </div>
                          <div class="px-2.5 py-1 bg-emerald-500/10 text-emerald-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                            {(String(e.newText || "").split("\n").slice(0, 6).join("\n"))}
                          </div>
                        </>
                      )}
                    </For>
                    <Show when={args.edits.length > 2}>
                      <div class="px-2.5 py-1 text-ink-600">+{args.edits.length - 2} more changes</div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={name === "glob"}>
              <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                <Iconify icon="lucide:search" size={14} class="text-ink-400 shrink-0" />
                <span class="text-ink-500">Search files</span>
                <span class="font-mono text-ink-100 truncate">{String(args.pattern || "")}</span>
              </div>
            </Show>
            <Show when={name === "todo"}>
              <div class="px-3.5 py-2.5 text-xs"><p class="font-medium text-ink-200 mb-2">Update task plan</p><ul class="space-y-1 text-ink-400"><For each={args.items || []}>{(item) => <li class="flex gap-2"><span class="text-ink-500">{String(item.status).replaceAll("_", " ")}</span><span>{item.text}</span></li>}</For></ul></div>
            </Show>
            <Show when={!["bash", "read", "write", "edit", "glob", "todo"].includes(name)}>
              <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                <Iconify icon="lucide:wrench" size={14} class="text-ink-400 shrink-0" />
                <span class="font-mono text-ink-100">{name}</span>
              </div>
            </Show>
            <details>
              <summary class="px-3.5 py-1.5 text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer select-none border-t border-line/50">
                Details
              </summary>
              <pre class="px-3.5 pb-3 font-mono text-[11px] text-ink-500 overflow-x-auto whitespace-pre-wrap max-h-40">
                {pa().args}
              </pre>
            </details>
          </div>
          <div class="mt-3 flex items-center justify-end gap-2">
            <button
              onClick={() => ctx.respondApproval(false)}
              class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer"
            >
              Reject
            </button>
            <button
              onClick={() => ctx.respondApproval(true)}
              class="px-4 py-1.5 rounded-xl bg-ink-100 text-ink-950 hover:bg-accent-400 text-xs font-semibold transition-colors cursor-pointer"
            >
              Allow once
            </button>
            <button
              onClick={() => {
                ctx.setYoloMode(true);
                ctx.respondApproval(true, true);
              }}
              class="px-3.5 py-1.5 rounded-xl bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-semibold transition-colors cursor-pointer"
              data-rc-tip="Enable Full access and allow all tool calls" aria-label="Always allow — enable Full access"
            >
              Always allow
            </button>
          </div>
        </div>
      );
    }}
  </Show>
</div>
</div>
</Show>
</Show>
</>
  );
}
