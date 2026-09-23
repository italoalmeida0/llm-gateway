import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useSession, useTranscriptCtx, useUI } from "../ctx";
import { SessionRow, type SessionRowCtx } from "./SessionSidebar";
import { FloatMenu } from "./FloatMenu";
import { HostCard } from "./HostCard";
import { SidebarToggle } from "./SidebarToggle";
import type { SessionSummary } from "../types";

export function WorkspaceSidebar() {
  const hosts = useHost();
  const s = useSession();
  const t = useTranscriptCtx();
  const m = useModal();
  const ui = useUI();
  const rowCtx = (): SessionRowCtx => ({
    activeSessionId: s.activeSessionId,
    selectedSessions: s.selectedSessions,
    selectionMode: s.selectionMode,
    renamingId: s.renamingId,
    renameText: s.renameText,
    setRenameText: s.setRenameText,
    setRenamingId: s.setRenamingId,
    submitRename: s.submitRename,
    toggleSessionSelect: s.toggleSessionSelect,
    selectSession: s.selectSession,
    setHistoryView: ui.setHistoryView,
    closeSidebarOnMobile: ui.closeSidebarOnMobile,
    togglePin: s.togglePin,
    deleteSession: (id, e) => void s.deleteSession(id, e),
    sessionStatus: t.sessionStatus,
    turnActivity: t.turnActivity,
    cancelTurnForSession: t.cancelTurnForSession,
  });
  const renderRow = (sess: SessionSummary) => SessionRow(rowCtx(), sess);
  return (
<>
<Show when={ui.isMobile() && ui.sidebarOpen()}>
  <div
    class="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden"
    onClick={() => ui.setSidebarOpen(false)}
  />
</Show>
<aside
  class={`rc-sidebar border-r border-line flex flex-col shrink-0 transition-all duration-200 ${
    ui.sidebarOpen()
      ? ui.isMobile()
        ? "fixed inset-0 z-40 w-full shadow-2xl border-r-0"
        : "w-64"
      : "w-0 overflow-hidden border-r-0"
  }`}
>
  {/* Brand Header */}
  <div class="rc-workspace-header rc-sidebar-header flex items-center justify-between gap-2 px-3.5 shrink-0 border-b border-line select-none">
    <div class="flex items-center gap-2.5 min-w-0">
      <img
        src="/indirect-icon.svg"
        alt="Indirect"
        class="w-5 h-5 shrink-0 object-contain rounded"
      />
      <span class="text-[13px] font-semibold tracking-tight text-ink-100 truncate">
        Indirect Code
      </span>
    </div>
    <Show when={ui.sidebarOpen()}><SidebarToggle /></Show>
  </div>

  {/* New Conversation */}
  <div class="p-2">
    <a
      href="#/"
      class="w-full flex items-center gap-2 px-3 py-1.5 mb-1 rounded-lg text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-900/60 transition-colors"
      data-rc-tip="Back to LLM Gateway"
    >
      <Iconify icon="lucide:arrow-left" size={13} />
      <span>Back to Gateway</span>
    </a>
    <button
      onClick={() => {
        s.startNewConversation();
        ui.closeSidebarOnMobile();
      }}
      class="ui-button ui-button-outline w-full justify-start"
    >
      <Iconify icon="lucide:plus" size={14} />
      <span>New Conversation</span>
    </button>
    <button
      onClick={() => {
        ui.setHistoryView(true);
        ui.closeSidebarOnMobile();
      }}
      class="w-full flex items-center gap-2 px-3 py-1.5 mt-1 rounded-lg text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-900/60 transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:clock" size={13} />
      <span>Conversation History</span>
    </button>
  </div>


  {/* Projects */}
  <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-3 min-h-0 [scrollbar-gutter:stable]">
      <div class="flex items-center justify-between px-1.5 py-1 border-b border-line/50">
        <Show
          when={s.selectionMode()}
          fallback={
            <span class="text-[11px] font-medium text-ink-500">Projects</span>
          }
        >
          <span class="text-[11px] font-medium text-ink-300">
            {s.selectedSessions().size} selected
          </span>
        </Show>
        <div class="flex items-center gap-0.5">
          {/* Selection mode toggle (chatbot) */}
          <button
            onClick={() => {
              if (s.selectionMode()) s.exitSelectionMode();
              else s.setSelectionMode(true);
            }}
            class={`p-1 rounded cursor-pointer ${s.selectionMode() ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:text-ink-200 hover:bg-ink-900"}`}
            data-rc-tip={s.selectionMode() ? "Exit selection mode" : "Select conversations"} aria-label={s.selectionMode() ? "Exit selection mode" : "Select conversations"}
          >
            <Iconify icon={s.selectionMode() ? "lucide:x" : "lucide:list-todo"} size={13} />
          </button>
        <div>
          <button
            ref={s.newProjBtn}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              s.setNewProjectMenuOpen(!s.newProjectMenuOpen());
            }}
            class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
            data-rc-tip="Create new project" aria-label="Create new project"
          >
            <Iconify icon="lucide:folder-plus" size={13} />
          </button>
          <FloatMenu anchor={() => s.newProjBtn} open={s.newProjectMenuOpen()} placement="bottom-start" width="11rem">
              <button
                onClick={() => {
                  s.setNewProjectMenuOpen(false);
                  s.openNewProjectModal();
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-200 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:folder-plus" size={13} />
                <span>New Project</span>
              </button>
              <button
                onClick={() => {
                  s.setNewProjectMenuOpen(false);
                  s.quickStartProject();
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:zap" size={13} />
                <span>Quick Start</span>
              </button>
          </FloatMenu>
          </div>
        </div>
      </div>
      <Show
        when={s.projects().length > 0}
        fallback={
          <button
            onClick={s.openNewProjectModal}
            class="w-full text-left px-2.5 py-2 rounded-lg border border-dashed border-line text-xs text-ink-500 hover:text-ink-300 hover:border-ink-500 transition-colors cursor-pointer"
          >
            + Select a project folder on the host
          </button>
        }
      >
       <div class="space-y-2">
            <For each={s.projects()}>
              {(p) => {
                const list = () => s.projectSessions(p.id);
                return (
                  <div>
                    <div
                      onClick={() => {
                        s.pickProject(p.id);
                        s.toggleProjectExpanded(p.id);
                      }}
                      class={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
                        p.id === (s.activeProject()?.id || "")
                          ? "text-ink-100"
                          : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
                      }`}
                      data-rc-tip={p.path}
                    >
                      <Iconify
                        icon="lucide:chevron-right"
                        size={12}
                        class={`shrink-0 text-ink-600 transition-transform ${s.isProjectExpanded(p) ? "rotate-90" : ""}`}
                      />
                      <Iconify icon="lucide:folder" size={14} class="shrink-0 text-ink-500" />
                      <span class="truncate flex-1 font-medium">{p.name}</span>
                      <button aria-label={`New conversation in ${p.name}`} data-rc-tip="New conversation in this project" onClick={(e) => { e.stopPropagation(); s.startNewConversation(p.id); }}
                        class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 p-1 text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:plus" size={14} /></button>
                      <Show when={!p.protected}>
                        <button
                          onClick={(e) => s.deleteProject(p.id, e)}
                          class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer shrink-0"
                          data-rc-tip="Remove project" aria-label="Remove project"
                        >
                          <Iconify icon="lucide:x" size={12} />
                        </button>
                      </Show>
                    </div>
                    <Show when={s.isProjectExpanded(p)}>
                      <div class="ml-[13px] mt-0.5 space-y-0.5 border-l border-line/50 pl-1.5">
                        <For each={s.visibleSessions(p.id, list())}>
                          {(sess) => renderRow(sess)}
                        </For>
                        {s.sessionListToggle(p.id, list().length)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={s.looseSessions().length > 0}>
              <div>
                <div class="px-2 py-1.5 text-[11px] font-medium text-ink-600">
                  Not in Project
                </div>
                <div class="space-y-0.5">
                  <For each={s.visibleSessions("loose", s.looseSessions())}>
                    {(sess) => renderRow(sess)}
                  </For>
                  {s.sessionListToggle("loose", s.looseSessions().length)}
                </div>
              </div>
            </Show>
          </div>
      </Show>
    </div>
  {/* Batch bar (chatbot selection mode) */}
  <Show when={s.selectionMode() && s.selectedSessions().size > 0}>
    <div class="p-2 border-t border-line/70 bg-ink-950/95">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-ink-500 pl-1">
          {s.selectedSessions().size} selected
        </span>
        <div class="flex items-center gap-1.5">
          <button
            onClick={s.pinSelected}
            class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-ink-900 border border-line/70 text-ink-300 hover:text-ink-100 cursor-pointer"
          >
            Pin / Unpin
          </button>
          <button
            onClick={s.deleteSelected}
            class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </Show>

  <div class="p-2 border-t border-line/70 space-y-1">
    {/* Daemon update: primary rounded-full button above host selector */}
    <Show when={(() => { const i = ui.daemonUpdate.info(); return !!i && !!i.available && i.available !== i.current; })()}>{(() => {
      const i = ui.daemonUpdate.info()!;
      const busy = ui.daemonUpdate.applying() || hosts.activeHost()?.status === "updating";
      return (
        <button
          onClick={() => ui.daemonUpdate.apply()}
          disabled={busy}
          class="ui-button ui-button-primary w-full rounded-full h-[1.5rem] min-h-[1.5rem] py-0 text-xs gap-1.5"
        >
          <Iconify icon="lucide:arrow-down-to-line" size={13} />
          <span>{busy ? "Updating…" : `Update to ${i.available}`}</span>
        </button>
      );
    })()}</Show>
    <HostCard id="sidebar" />
    {/* () => … — openSettings takes an optional section id; passing it
        directly would feed the MouseEvent in as the section. */}
    <button
      onClick={() => m.openSettings()}
      class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink-500 hover:text-ink-200 hover:bg-ink-900/60 transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:settings" size={14} />
      <span>Settings</span>
    </button>
  </div>
</aside>
</>
  );
}
