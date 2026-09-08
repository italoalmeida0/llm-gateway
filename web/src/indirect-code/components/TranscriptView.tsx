import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Streamdown } from "streamdown-solid";
import { FileIcon } from "../presentation";
import { elapsedLabel } from "../utils/format";
import type { TranscriptRenderCtx } from "./TranscriptBlocks";
import {
  renderAssistantSpecial, renderMessageContent, renderSeriesLead,
} from "./TranscriptBlocks";
import { HistoryView } from "./HistoryView";
import { ApprovalCard } from "./ApprovalCard";
import { AssistantMsgActions, UserMsgActions } from "./MsgActions";
import { useComposerCtx, useHost, useSession, useTranscriptCtx, useModal, useUI } from "../ctx";

export function TranscriptView() {
  const t = useTranscriptCtx();
  const s = useSession();
  const h = useHost();
  const c = useComposerCtx();
  const m = useModal();
  const ui = useUI();
  const renderCtx = (): TranscriptRenderCtx => ({
    renderBlocks: t.renderBlocks,
    sessionStatus: t.sessionStatus,
    messages: t.messages,
    thinkingStart: t.thinkingStart,
    thinkingElapsed: t.thinkingElapsed,
    expandedThinking: t.expandedThinking,
    toolGroupOpen: t.toolGroupOpen,
    toolOpen: t.toolOpen,
    toolProgress: t.toolProgress,
    toggleToolGroup: t.toggleToolGroup,
    toggleToolOpen: t.toggleToolOpen,
    elapsedLabel,
    specialProgress: t.specialProgress,
    thinkingIndex: t.thinkingIndex,
    setExpandedThinking: t.setExpandedThinking,
    verboseChat: ui.verboseChat,
    setPreviewFile: m.setPreviewFile,
    turnClock: t.turnClock,
    toolStarts: t.toolStarts,
    activeSession: s.activeSession,
    pendingApproval: t.pendingApproval,
    projects: s.projects,
  });
  return (
<>
<Show when={h.activeHost() && h.connectionState() !== "connected"}>
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
    onClick={() => ui.setSidebarOpen(!ui.sidebarOpen())}
    class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm cursor-pointer"
    data-rc-tip={ui.sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"} aria-label={ui.sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
  >
    <Iconify
      icon={
        ui.sidebarOpen()
          ? "lucide:panel-left-close"
          : "lucide:panel-left-open"
      }
      size={14}
    />
  </button>
</div>

{/* Chat Stream Viewport */}
<Show
  when={!ui.historyView()}
  fallback={
    <HistoryView
      sessionFilter={s.sessionFilter}
      setSessionFilter={s.setSessionFilter}
      queueDaemonSearch={s.queueDaemonSearch}
      searchResults={s.searchResults}
      setSearchResults={s.setSearchResults}
      setHistoryView={ui.setHistoryView}
      selectSession={s.selectSession}
      sessions={s.sessions}
      matchQuery={s.matchQuery}
      sortedSessions={s.sortedSessions}
      isMobile={ui.isMobile}
    />
  }
>
<Show when={!s.draftMode()}>
<div
  ref={t.setChatContainerRef}
  onScroll={t.onChatScroll}
  onWheel={(e) => { if (e.deltaY < 0) t.transcriptScroll.detach(); }}
  onPointerDown={() => t.transcriptScroll.detach()}
  onTouchMove={() => t.transcriptScroll.detach()}
  onKeyDown={(e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) t.transcriptScroll.detach(); }}
  tabindex="0"
  aria-label="Conversation"
  class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 md:px-8 select-text [overflow-anchor:none] [scrollbar-gutter:stable]"
>
<div ref={t.setChatContentRef} class="pt-6 pb-10 space-y-6"
>
  {/* Conversation Messages.
      buildRenderBlocks fuses consecutive assistant messages that
      are tool-only into one "series" block. Index bookkeeping
      below stays on RAW message positions: series extras are
      skipped for actions, and the lead keeps its own raw index so
      every per-message op still maps 1:1 to the daemon
      transcript — fusing is purely visual. */}
  <Show when={t.hiddenCount() > 0}>
    <div class="flex justify-center">
      <button
        onClick={() => t.growWindow()}
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-ink-900 border border-line/70 text-ink-300 shadow hover:text-ink-100 cursor-pointer"
      >
        <Iconify icon="lucide:chevron-up" size={13} />
        <span>Load {Math.min(20, t.hiddenCount())} older ({t.hiddenCount()} hidden)</span>
      </button>
    </div>
  </Show>
  <For each={t.visibleBlocks()}>
    {(block, bi) => {
      const msg = block.msg;
      const isLast = () => bi() === t.visibleBlocks().length - 1;
      const rawIdx = () => t.blockRawIdx(block);
      const textOf = () =>
        msg.blocks
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text as string)
          .join("\n");
      const isEditing = () => t.editingMsgIdx() === rawIdx();
      const rctx = renderCtx();
      return (
        <div
          class={`group/msg flex flex-col w-full ${ui.convWidthClass()} mx-auto ${
            msg.role === "user" && !isEditing() ? "items-end" : "items-start"
          }`}
        >
          {/* ===== SYSTEM NOTICE (e.g. auto-compaction) ===== */}
          <Show when={msg.system}>
            <div class="w-full flex justify-center">
              <div class="max-w-xl text-center px-4 py-2.5 rounded-xl border border-line/60 bg-ink-900/60">
                <div class="flex items-center justify-center gap-1.5 text-xs font-medium text-ink-300">
                  <Iconify icon="lucide:boxes" size={13} class="text-ink-500" />
                  <span>Context auto-compacted</span>
                </div>
                <details class="mt-1.5 text-left">
                  <summary class="text-[11px] text-ink-500 hover:text-ink-300 cursor-pointer select-none text-center">
                    View summary
                  </summary>
                  <div class="rc-markdown mt-2 text-left text-xs max-h-48 overflow-y-auto">
                    <Streamdown class="text-xs">{textOf().replace(/^## Context Summary \(compacted\)\n\n/, "")}</Streamdown>
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
                  <div class="flex items-center gap-1.5 text-xs text-accent-400 font-medium mb-2 select-none">
                    <Iconify icon="lucide:pencil" size={13} />
                    <span>Editing message</span>
                  </div>
                  <textarea
                    value={t.editingMsgText()}
                    onInput={(e) => t.updateEditingMsgText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                        e.preventDefault();
                        t.saveEditMsg(rawIdx(), msg);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        t.cancelEditMsg();
                      }
                    }}
                    class="w-full bg-transparent text-ink-100 text-sm outline-none resize-y min-h-[96px] leading-relaxed"
                    rows={4}
                    ref={(el) => {
                      const active = document.activeElement;
                      if (!active || active === document.body || active === el) {
                        setTimeout(() => el?.focus(), 40);
                      }
                    }}
                  />
                  <div class="flex justify-end items-center gap-2 mt-2 pt-2 border-t border-line/40">
                    <button
                      onClick={t.cancelEditMsg}
                      class="text-xs text-ink-400 hover:text-ink-100 px-3 py-1.5 rounded-lg hover:bg-ink-800 transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => t.saveEditMsg(rawIdx(), msg)}
                      class="text-xs bg-ink-100 text-ink-950 px-3.5 py-1.5 rounded-lg hover:bg-accent-400 font-medium transition-colors cursor-pointer"
                    >
                      Save and Send
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={!isEditing()}>
                <UserMsgActions
                  forking={t.forking()}
                  canFork={(block.kind === "series" ? block.extras.at(-1) || msg : msg).srcIdx != null}
                  showCopy={textOf().trim() !== ""}
                  copied={t.copiedMsgId() === msg.id}
                  onFork={() => t.forkMessage(block)}
                  onCopy={() => t.copyMsg(msg.id, textOf())}
                  onEdit={() => t.startEditMsg(rawIdx(), msg)}
                  onDelete={() => t.deleteMsg(rawIdx())}
                />
              </Show>
            </div>
          </Show>

          {/* ===== ASSISTANT ===== */}
          <Show when={msg.role !== "user"}>
            <div class="w-full flex flex-col items-start overflow-hidden">
              {/* Loading dots while the first tokens arrive */}
              <Show
                when={
                  t.sessionStatus() === "running" &&
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
                {renderSeriesLead(rctx, block)}
                <Show when={block.units.length}>{renderAssistantSpecial(rctx, msg.id, block.units, isLast(), block.extras.map((e) => e.srcIdx ?? 0))}</Show>
              </> : renderMessageContent(rctx, msg, isLast())}

              {/* Hover actions (chatbot-style) */}
              <Show when={(t.sessionStatus() !== "running" || !isLast()) && !isEditing()}>
                <AssistantMsgActions
                  forking={t.forking()}
                  canFork={(block.kind === "series" ? block.extras.at(-1) || msg : msg).srcIdx != null}
                  showCopy={textOf().trim() !== ""}
                  copied={t.copiedMsgId() === msg.id}
                  onFork={() => t.forkMessage(block)}
                  onCopy={() => t.copyMsg(msg.id, textOf())}
                  onRegenerate={() => t.regenerateMsg(rawIdx())}
                />
              </Show>
            </div>
          </Show>
          </Show>
        </div>
      );
    }}
  </For>

  <ApprovalCard
    pendingApproval={t.pendingApproval}
    convWidthClass={ui.convWidthClass}
    respondApproval={t.respondApproval}
    setYoloMode={c.setYoloMode}
  />
</div>
</div>
</Show>
</Show>
</>
  );
}
