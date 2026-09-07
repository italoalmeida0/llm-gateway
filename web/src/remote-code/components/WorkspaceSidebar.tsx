import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { ThemeToggle } from "../../ui";
import type { RemoteCodeViewCtx } from "../viewCtx";
import { SessionRow } from "./SessionSidebar";
import { FloatMenu } from "./FloatMenu";

export function WorkspaceSidebar(ctx: RemoteCodeViewCtx) {
  return (
<>
<Show when={ctx.isMobile() && ctx.sidebarOpen()}>
  <div
    class="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden"
    onClick={() => ctx.setSidebarOpen(false)}
  />
</Show>
<aside
  class={`border-r border-line/70 bg-ink-950 flex flex-col shrink-0 transition-all duration-200 ${
    ctx.sidebarOpen()
      ? ctx.isMobile()
        ? "fixed inset-y-0 left-0 z-40 w-72 shadow-2xl"
        : "w-64"
      : "w-0 overflow-hidden border-r-0"
  }`}
>
  {/* New Conversation */}
  <div class="p-2">
    <button
      onClick={() => {
        ctx.startNewConversation();
        ctx.closeSidebarOnMobile();
      }}
      class="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-ink-900 hover:bg-ink-800 border border-line/60 text-[13px] font-medium text-ink-200 transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:plus" size={14} />
      <span>New Conversation</span>
    </button>
    <button
      onClick={() => {
        ctx.setHistoryView(true);
        ctx.closeSidebarOnMobile();
      }}
      class="w-full flex items-center gap-2 px-3 py-1.5 mt-1 rounded-lg text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-900/60 transition-colors cursor-pointer"
    >
      <Iconify icon="lucide:clock" size={13} />
      <span>Conversation History</span>
    </button>
  </div>


  {/* Projects */}
  <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-3 min-h-0 [scrollbar-gutter:stable]">
      <div class="flex items-center justify-between px-1.5 py-1 bg-ink-950 border-b border-line/50">
        <Show
          when={ctx.selectionMode()}
          fallback={
            <span class="text-[11px] font-medium text-ink-500">Projects</span>
          }
        >
          <span class="text-[11px] font-medium text-ink-300">
            {ctx.selectedSessions().size} selected
          </span>
        </Show>
        <div class="flex items-center gap-0.5">
          {/* Selection mode toggle (chatbot) */}
          <button
            onClick={() => {
              if (ctx.selectionMode()) ctx.exitSelectionMode();
              else ctx.setSelectionMode(true);
            }}
            class={`p-1 rounded cursor-pointer ${ctx.selectionMode() ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:text-ink-200 hover:bg-ink-900"}`}
            data-rc-tip={ctx.selectionMode() ? "Exit selection mode" : "Select conversations"} aria-label={ctx.selectionMode() ? "Exit selection mode" : "Select conversations"}
          >
            <Iconify icon={ctx.selectionMode() ? "lucide:x" : "lucide:list-todo"} size={13} />
          </button>
          {/* New Project split button (Antigravity: New Project / Quick Start) */}
        <div>
          <button
            ref={ctx.newProjBtn}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              ctx.setNewProjectMenuOpen(!ctx.newProjectMenuOpen());
            }}
            class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
            data-rc-tip="Create new project" aria-label="Create new project"
          >
            <Iconify icon="lucide:folder-plus" size={13} />
          </button>
          <FloatMenu anchor={() => ctx.newProjBtn} open={ctx.newProjectMenuOpen()} placement="bottom-start" width="11rem">
              <button
                onClick={() => {
                  ctx.setNewProjectMenuOpen(false);
                  ctx.openNewProjectModal();
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-200 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:folder-plus" size={13} />
                <span>New Project</span>
              </button>
              <button
                onClick={() => {
                  ctx.setNewProjectMenuOpen(false);
                  ctx.quickStartProject();
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
        when={ctx.projects().length > 0}
        fallback={
          <button
            onClick={ctx.openNewProjectModal}
            class="w-full text-left px-2.5 py-2 rounded-lg border border-dashed border-line text-xs text-ink-500 hover:text-ink-300 hover:border-ink-500 transition-colors cursor-pointer"
          >
            + Select a project folder on the host
          </button>
        }
      >
        {/* Nested view (Antigravity): sessions live under their project */}
          <div class="space-y-2">
            <For each={ctx.projects()}>
              {(p) => {
                const list = () => ctx.projectSessions(p.id);
                return (
                  <div>
                    <div
                      onClick={() => {
                        ctx.pickProject(p.id);
                        ctx.toggleProjectExpanded(p.id);
                      }}
                      class={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
                        p.id === (ctx.activeProject()?.id || "")
                          ? "text-ink-100"
                          : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
                      }`}
                      data-rc-tip={p.path}
                    >
                      <Iconify
                        icon="lucide:chevron-right"
                        size={12}
                        class={`shrink-0 text-ink-600 transition-transform ${ctx.isProjectExpanded(p) ? "rotate-90" : ""}`}
                      />
                      <Iconify icon="lucide:folder" size={14} class="shrink-0 text-ink-500" />
                      <span class="truncate flex-1 font-medium">{p.name}</span>
                      <button aria-label={`New conversation in ${p.name}`} data-rc-tip="New conversation in this project" onClick={(e) => { e.stopPropagation(); ctx.startNewConversation(p.id); }}
                        class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 p-1 text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:plus" size={14} /></button>
                      <Show when={!p.protected}>
                        <button
                          onClick={(e) => ctx.deleteProject(p.id, e)}
                          class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer shrink-0"
                          data-rc-tip="Remove project" aria-label="Remove project"
                        >
                          <Iconify icon="lucide:x" size={12} />
                        </button>
                      </Show>
                    </div>
                    <Show when={ctx.isProjectExpanded(p)}>
                      <div class="ml-[13px] mt-0.5 space-y-0.5 border-l border-line/50 pl-1.5">
                        <For each={ctx.visibleSessions(p.id, list())}>
                          {(s) => SessionRow(ctx, s)}
                        </For>
                        {ctx.sessionListToggle(p.id, list().length)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={ctx.looseSessions().length > 0}>
              <div>
                <div class="px-2 py-1.5 text-[11px] font-medium text-ink-600">
                  Not in Project
                </div>
                <div class="space-y-0.5">
                  <For each={ctx.visibleSessions("loose", ctx.looseSessions())}>
                    {(s) => SessionRow(ctx, s)}
                  </For>
                  {ctx.sessionListToggle("loose", ctx.looseSessions().length)}
                </div>
              </div>
            </Show>
          </div>
      </Show>
    </div>
  {/* Batch bar (chatbot selection mode) */}
  <Show when={ctx.selectionMode() && ctx.selectedSessions().size > 0}>
    <div class="p-2 border-t border-line/70 bg-ink-950/95">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] text-ink-500 pl-1">
          {ctx.selectedSessions().size} selected
        </span>
        <div class="flex items-center gap-1.5">
          <button
            onClick={ctx.pinSelected}
            class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-ink-900 border border-line/70 text-ink-300 hover:text-ink-100 cursor-pointer"
          >
            Pin / Unpin
          </button>
          <button
            onClick={ctx.deleteSelected}
            class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </Show>

  {/* Sidebar Footer: host switcher + settings (Antigravity) */}
  <div class="p-2 border-t border-line/70 space-y-1">
    <button
      ref={ctx.hostBtn}
      data-menubtn
      aria-label="Select host"
      aria-haspopup="menu"
      aria-expanded={ctx.hostMenuOpen()}
      onClick={() => { const next = !ctx.hostMenuOpen(); ctx.closeMenus(); ctx.setHostMenuOpen(next); }}
      class="w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-elev transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 cursor-pointer"
    >
      <span class="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-ink-400 shrink-0">
        <Iconify icon="lucide:monitor" size={16} />
      </span>
      <span class="flex-1 min-w-0">
        <span class="block truncate text-xs font-medium text-ink-200">{ctx.activeHost()?.name || ctx.activeHost()?.hostname || "Select host"}</span>
        <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
          <span class={`h-1.5 w-1.5 rounded-full ${ctx.connectionState() === "connected" && ctx.activeHost()?.status === "online" ? "bg-accent-500" : "bg-ink-600"}`} />
          {ctx.connectionState() !== "connected" ? "Reconnecting…" : ctx.activeHost()?.status === "online" ? "Connected" : "Offline"}
        </span>
      </span>
      <Iconify icon="lucide:chevrons-up-down" size={13} class="text-ink-500 shrink-0" />
    </button>
    <FloatMenu anchor={() => ctx.hostBtn} open={ctx.hostMenuOpen()} placement="top-start" width="18rem">
      <div class="px-2.5 py-2 text-[10px] uppercase tracking-wider font-semibold text-ink-500">Your hosts</div>
      <div role="menu" aria-label="Hosts" class="space-y-0.5">
        <For each={ctx.hosts()}>{(host) => (
          <button role="menuitemradio" aria-checked={host.id === ctx.activeHostId()}
            class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-elev focus-visible:bg-elev cursor-pointer"
            onClick={() => { ctx.setHostMenuOpen(false); ctx.setActiveHostId(host.id); }}>
            <Iconify icon="lucide:monitor" size={15} class="text-ink-500 shrink-0" />
            <span class="flex-1 min-w-0"><span class="block truncate text-xs text-ink-200">{host.name || host.hostname || host.id}</span>
              <span class="block text-[11px] text-ink-500">{host.status === "online" ? "Online" : "Offline"}{host.os ? ` · ${host.os}` : ""}</span></span>
            <Show when={host.id === ctx.activeHostId()}><Iconify icon="lucide:check" size={14} /></Show>
          </button>
        )}</For>
      </div>
      <div class="mt-1 border-t border-line pt-1 space-y-0.5">
        <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-400 hover:bg-elev cursor-pointer"
          onClick={() => { ctx.setHostMenuOpen(false); void ctx.loadHosts(); }}><Iconify icon="lucide:refresh-cw" size={13} />Refresh hosts</button>
        <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-200 hover:bg-elev cursor-pointer"
          onClick={() => { ctx.setHostMenuOpen(false); void ctx.generatePairingToken(); }}><Iconify icon="lucide:plus" size={13} />Connect another host</button>
        <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-brand-500 hover:bg-elev cursor-pointer" onClick={() => void ctx.removeHost()}>
          <Iconify icon="lucide:trash-2" size={13} />Remove current host
        </button>
      </div>
    </FloatMenu>
    {/* () => … — openSettings takes an optional section id; passing it
        directly would feed the MouseEvent in as the section. */}
    <button
      onClick={() => ctx.openSettings()}
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
