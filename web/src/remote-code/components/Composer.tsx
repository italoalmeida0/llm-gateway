import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Tooltip } from "../../ui";
import { compactTokens, contextDisplay } from "../context";
import { formatEffort } from "../utils/format";
import { baseNameOf } from "../transcript";
import type { RemoteCodeViewCtx } from "../viewCtx";
import { CodeBlock } from "./CodeBlock";
import { FloatMenu } from "./FloatMenu";
import { QuestionPanel } from "./QuestionModal";
import { FileIcon } from "../presentation";

export function Composer(ctx: RemoteCodeViewCtx) {
  return (
<>
{/* Composer estilo Antigravity — hidden entirely until a project
    exists: without a project there is nothing to type into. */}
<Show when={!ctx.historyView()}>
<div class={ctx.draftMode() ? "flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-10" : "px-4 pb-4 pt-2 bg-ink-950 relative z-20"}>
  {/* Floating scroll-to-bottom (chatbot FEAT-06) */}
  <Show when={!ctx.isAtBottom() && ctx.messages().length > 0}>
    <div class="flex justify-center pb-2">
      <button
        onClick={() => {
          ctx.setIsAtBottom(true);
          ctx.scrollToBottom(true);
        }}
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-ink-900 border border-line/70 text-ink-300 shadow-lg hover:text-ink-100 cursor-pointer"
      >
        <Iconify icon="lucide:arrow-down" size={13} />
        <span>Scroll to bottom</span>
      </button>
    </div>
  </Show>
  {/* Slash Command Autocomplete Menu */}
  <Show when={ctx.slashMatches().length > 0}>
    <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-full max-w-2xl rounded-xl border border-line bg-ink-900/95 shadow-2xl p-1.5 max-h-60 overflow-y-auto z-[60] backdrop-blur">
      <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-500 tracking-wider">
        Slash Commands
      </div>
      <For each={ctx.slashMatches()}>
        {(sc, idx) => (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => ctx.pickSlash(sc.cmd)}
            class={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center justify-between transition-colors ${
              idx() === ctx.slashIndex()
                ? "bg-ink-100 text-ink-950"
                : "text-ink-200 hover:bg-ink-800"
            }`}
          >
            <div class="flex items-center gap-2 font-mono font-semibold">
              <span>{sc.cmd}</span>
              <span class="text-[11px] opacity-70">{sc.args}</span>
            </div>
            <span class="text-[11px] opacity-80">{sc.desc}</span>
          </button>
        )}
      </For>
    </div>
  </Show>

  <div class="w-full max-w-2xl mx-auto">
    <Show when={ctx.draftMode()}>
      <h1 class="mb-6 text-2xl sm:text-3xl font-semibold tracking-tight text-ink-100">What would you like to work on?</h1>
      <div class="mb-3 flex justify-start" data-draft-project>
        {/* Project picker — where the next conversation starts.
            Default: project of the newest conversation (daemon). */}
        <div>
          <button
            ref={ctx.projBtn}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              ctx.setProjectMenuOpen(!ctx.projectMenuOpen());
              ctx.setModelMenuOpen(false);
              ctx.setAddContextOpen(false);
              ctx.setUsageOpen(false);
            }}
            class="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-elev border border-line text-sm text-ink-200 hover:bg-ink-800 font-medium cursor-pointer"
            data-rc-tip="Project" aria-label="Project"
          >
            <Iconify icon="lucide:folder" size={13} />
            <span class="max-w-[110px] truncate">
              {ctx.activeProject()?.name || "Select project"}
            </span>
            <Iconify icon="lucide:chevron-down" size={11} />
          </button>
          <FloatMenu anchor={() => ctx.projBtn} open={ctx.projectMenuOpen()} placement="bottom-start" width="18rem">
              <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                Project
              </div>
              <div class="max-h-56 overflow-y-auto [scrollbar-gutter:stable]">
                <For
                  each={ctx.projects()}
                  fallback={
                    <div class="px-2.5 py-2 text-[11px] text-ink-600">
                      No projects yet.
                    </div>
                  }
                >
                  {(p) => (
                    <button
                      onClick={() => {
                        ctx.pickProject(p.id);
                        ctx.setProjectMenuOpen(false);
                      }}
                      class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer ${
                        p.id === ctx.activeProject()?.id
                          ? "bg-ink-800 text-ink-100"
                          : "text-ink-300 hover:bg-ink-800/60"
                      }`}
                      data-rc-tip={p.path} aria-label={p.path}
                    >
                      <span class="flex items-center gap-1.5 min-w-0">
                        <Iconify icon="lucide:folder" size={13} class="shrink-0 text-ink-500" />
                        <span class="truncate">{p.name}</span>
                      </span>
                      <Show when={p.id === ctx.activeProject()?.id}>
                        <Iconify icon="lucide:check" size={13} />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
              <button
                onClick={() => {
                  ctx.setProjectMenuOpen(false);
                  ctx.openNewProjectModal();
                }}
                class="mt-1 w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-400 hover:bg-ink-800/60 hover:text-ink-200 flex items-center gap-2 cursor-pointer border-t border-line/60"
              >
                <Iconify icon="lucide:folder-plus" size={13} />
                <span>New project…</span>
              </button>
          </FloatMenu>
        </div>
      </div>
    </Show>
    <Show when={ctx.activeSessionId() && ctx.turnActivity()}>
      <div role="status" data-turn-status class="mb-2 flex items-center gap-2 text-xs text-ink-500">
        <Iconify icon={ctx.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:clock-3"} size={13} class={ctx.sessionStatus() === "running" ? "animate-spin" : ""} />
        <span>{ctx.turnLabel()}</span>
      </div>
    </Show>
    <Show when={ctx.activeSessionId() && ctx.pendingQuestion()?.id} keyed>{(id) =>
      <QuestionPanel request={{...ctx.pendingQuestion()!, id}} connected={ctx.connectionState() === "connected" && ctx.activeHost()?.status === "online"} submitting={ctx.questionSubmitting()} error={ctx.questionError()} onSubmit={ctx.answerQuestion} />
    }</Show>
    <Show when={ctx.activeSessionId() && ctx.todos().length && !ctx.pendingQuestion()}>
      <section aria-label="Task checklist" class="mb-3 rounded-xl border border-line bg-elev/40 text-xs">
        <button onClick={() => ctx.setTodosOpen(!ctx.todosOpen())} aria-expanded={ctx.todosOpen()} class="w-full px-3 py-2.5 flex items-center gap-2 text-ink-300 cursor-pointer">
          <Iconify icon="lucide:list-checks" size={15} /><span class="font-medium">Task plan</span>
          <span class="text-ink-500">{ctx.todos().filter((item) => item.status === "completed").length}/{ctx.todos().length}</span>
          <span class="flex-1 truncate text-left text-ink-500">{!ctx.todosOpen() ? ctx.todos().find((item) => item.status === "in_progress")?.text : ""}</span>
          <Iconify icon="lucide:chevron-down" size={13} class={ctx.todosOpen() ? "rotate-180" : ""} />
        </button>
        <Show when={ctx.todosOpen()}><ol class="px-3 pb-3 space-y-2 max-h-44 overflow-y-auto">
          <For each={ctx.todos()}>{(item) => <li class="flex items-start gap-2" data-todo-status={item.status}>
            <Iconify icon={item.status === "completed" ? "lucide:circle-check" : item.status === "in_progress" ? ctx.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:circle-dot" : "lucide:circle"} size={14} class={item.status === "in_progress" && ctx.sessionStatus() === "running" ? "animate-spin text-ink-200" : "text-ink-500"} />
            <span class={item.status === "completed" ? "text-ink-500 line-through" : "text-ink-200"}>{item.text}</span>
          </li>}</For>
        </ol></Show>
      </section>
    </Show>
    <Show when={ctx.taskReview()?.files.length && ctx.activeSessionId()}>
      <div class="mb-2 flex flex-wrap items-center justify-end gap-3 text-xs text-ink-400" data-task-changes>
        <span class="flex items-center gap-1.5"><Iconify icon="lucide:files" size={14} />{ctx.taskReview()?.files.length} file{ctx.taskReview()?.files.length === 1 ? "" : "s"} changed</span>
        <button onClick={() => ctx.undoChanges()} disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.wsOpen()} class="flex items-center gap-1 hover:text-ink-100 disabled:opacity-40 cursor-pointer"><Iconify icon="lucide:undo-2" size={13} />Undo</button>
        <button onClick={ctx.keepChanges} disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.wsOpen()} class="hover:text-ink-100 disabled:opacity-40 cursor-pointer">Keep</button>
        <button onClick={() => ctx.requestReview(true)} disabled={ctx.reviewLoading() || !ctx.wsOpen()} class="px-3 py-1.5 rounded-lg border border-line hover:bg-elev text-ink-200 disabled:opacity-40 cursor-pointer">Review</button>
      </div>
    </Show>
    <Show when={ctx.appNotice()}>{(notice) =>
      <div role={notice().kind === "err" ? "alert" : "status"} class={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${notice().kind === "err" ? "border-brand-500/30 bg-brand-500/5 text-ink-200" : "border-line bg-elev text-ink-300"}`}>
        <Iconify icon={notice().kind === "err" ? "lucide:circle-alert" : "lucide:check"} size={15} class={notice().kind === "err" ? "text-brand-500" : "text-ink-400"} />
        <span class="min-w-0 flex-1 break-words">{notice().message}</span>
        <button aria-label="Dismiss notification" onClick={() => ctx.setAppNotice(null)} class="text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:x" size={13} /></button>
      </div>
    }</Show>
    <Show when={ctx.activeHost() && (ctx.connectionState() !== "connected" || ctx.activeHost()?.status !== "online")}>
      <div role="status" class="mb-3 rounded-xl border border-line bg-elev p-3 text-xs text-ink-300 flex items-start gap-2">
        <Iconify icon="lucide:unplug" size={15} class="text-ink-500" />
        <div class="flex-1"><p class="font-medium">{ctx.connectionState() !== "connected" ? "Reconnecting to the gateway…" : `${ctx.activeHost()?.name || "Host"} is offline`}</p><p class="mt-1 text-ink-500">Your draft is kept here. Start the daemon on this host to continue.</p></div>
        <button onClick={ctx.loadHosts} class="text-ink-200 hover:underline cursor-pointer">Retry</button>
      </div>
    </Show>
    {/* Floating menus use the shared portal layer above the composer. */}
    <Show when={!ctx.workspaceBlocked()} fallback={
      <div role="status" class="rounded-2xl border border-line bg-elev px-4 py-4 text-sm text-ink-300" data-workspace-unavailable>
        <div class="flex items-center gap-2 font-medium text-ink-100"><Iconify icon="lucide:folder-x" size={17} />{ctx.workspaceState() === "missing" ? "The project folder was deleted" : "The project folder is unavailable"}</div>
        <p class="mt-2 text-xs text-ink-500">{ctx.workspaceState() === "missing" ? "Recreate this folder on the host to continue this conversation." : "Restore access to this folder on the host to continue."}</p>
        <p class="mt-2 font-mono text-xs break-all">{ctx.workspacePath()}</p>
        <div class="mt-3 flex gap-3"><button onClick={ctx.checkWorkspace} class="text-xs text-ink-200 hover:underline cursor-pointer">Check again</button><Show when={ctx.sessionStatus() === "running"}><button onClick={ctx.cancelCurrentTurn} class="text-xs text-ink-200 hover:underline cursor-pointer">Stop turn</button></Show></div>
      </div>
    }>
    <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors relative flex flex-col">
      {/* Attachment chips (chatbot-style) */}
      <Show when={ctx.pendingAttachments().length > 0}>
        <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
          <For each={ctx.pendingAttachments()}>
            {(att) => (
              <div
                onClick={() => ctx.previewPending(att)}
                class="relative group flex items-center gap-1.5 bg-ink-950 rounded-lg border border-line/70 pl-1.5 pr-2 py-1 text-xs max-w-[180px] cursor-pointer hover:border-ink-500 transition-colors"
                data-rc-tip={`${att.name} (${Math.round(att.size / 1024)}KB) — click to preview`}
              >
                <Show
                  when={att.loading}
                  fallback={
                    <Show
                      when={att.objectUrl}
                      fallback={<FileIcon path={att.name} size={20} />}
                    >
                      <img src={att.objectUrl} class="w-7 h-7 object-cover rounded shrink-0 border border-line/60" />
                    </Show>
                  }
                >
                  <span class="w-5 h-5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                </Show>
                <span class="truncate text-ink-300">{att.name}</span>
                <Show when={att.uploading}>
                  <span class="w-3 dot-spin border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                </Show>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    ctx.removePendingAttachment(att.key);
                  }}
                  class="absolute -top-1.5 -right-1.5 bg-ink-700 hover:bg-rose-500 rounded-full p-0.5 transition-colors shadow cursor-pointer"
                  data-rc-tip="Remove" aria-label="Remove"
                >
                  <Iconify icon="lucide:x" size={10} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Input row: textarea occupies remaining width, clear button takes its own size */}
      <div class="flex items-start">
        <textarea
          id="rc-composer"
          disabled={ctx.creatingSession()}
          rows={1}
          class="flex-1 min-w-0 bg-transparent text-base sm:text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none resize-none px-4 pt-3 pb-1 max-h-[160px] min-h-[48px] overflow-y-auto [scrollbar-gutter:stable]"
          placeholder={
            ctx.isMobile() ? "Ask anything…" : ctx.activeSession()
              ? `Ask anything, @ to mention, / for actions`
              : `Start a conversation in ${ctx.activeProject()?.name || "project"}...`
          }
          value={ctx.inputPrompt()}
          onInput={(e) => {
            ctx.setInputPrompt(e.currentTarget.value);
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 160) + "px";
          }}
          onPaste={(e) => {
            const files: File[] = [];
            try {
              const items = e.clipboardData?.items;
              if (items) {
                for (const it of items) {
                  if (it.kind === "file") {
                    const f = it.getAsFile();
                    if (f) files.push(f);
                  }
                }
              }
            } catch {}
            if (files.length > 0) {
              e.preventDefault();
              ctx.handleFiles(files);
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            try {
              const files = Array.from(e.dataTransfer?.files || []);
              if (files.length > 0) ctx.handleFiles(files);
            } catch {}
          }}
          onKeyDown={(e) => {
            if (ctx.slashMatches().length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                ctx.setSlashIndex((prev) =>
                  Math.min(prev + 1, ctx.slashMatches().length - 1),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                ctx.setSlashIndex((prev) => Math.max(prev - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const pick = ctx.slashMatches()[ctx.slashIndex()];
                if (pick) ctx.pickSlash(pick.cmd);
                return;
              }
            }

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ctx.sendPrompt();
            }
          }}
        />
        <Show when={ctx.inputPrompt().length > 0}>
          <button
            onClick={() => ctx.setInputPrompt("")}
            class="shrink-0 mr-2.5 mt-2.5 p-1 rounded-md text-ink-600 hover:text-ink-300 hover:bg-ink-800 transition-colors cursor-pointer"
            data-rc-tip="Clear input" aria-label="Clear input"
          >
            <Iconify icon="lucide:x" size={13} />
          </button>
        </Show>
      </div>

    <div class="flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
      <div class="flex flex-1 min-w-0 flex-wrap items-center gap-0.5 text-xs text-ink-400">
        {/* Session files (stored on the daemon) */}
        <Show when={(ctx.sessionFiles()[ctx.activeSessionId()] || []).length > 0}>
          <div>
            <button
              ref={ctx.filesBtn}
              data-menubtn
              onClick={(e) => {
                e.stopPropagation();
                ctx.setFilesMenuOpen(!ctx.filesMenuOpen());
                ctx.setAddContextOpen(false);
                ctx.setModelMenuOpen(false);
              }}
              class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 cursor-pointer"
              data-rc-tip="Session files" aria-label="Session files"
            >
              <Iconify icon="lucide:paperclip" size={13} />
              <span>{(ctx.sessionFiles()[ctx.activeSessionId()] || []).length}</span>
            </button>
            <FloatMenu anchor={() => ctx.filesBtn} open={ctx.filesMenuOpen()} placement="top-start" width="15rem">
                <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                  Session files
                </div>
                <div class="max-h-48 overflow-y-auto [scrollbar-gutter:stable]">
                  <For each={ctx.sessionFiles()[ctx.activeSessionId()] || []}>
                    {(f) => (
                      <button
                        onClick={() => {
                          ctx.setFilesMenuOpen(false);
                          ctx.openStoredPreview(ctx.activeSessionId(), f.id);
                        }}
                        class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                        data-rc-tip={`${f.name} (${Math.round(f.size / 1024)}KB)`} aria-label={`${f.name} (${Math.round(f.size / 1024)}KB)`}
                      >
                        <FileIcon path={f.name} size={13} />
                        <span class="truncate flex-1">{f.name}</span>
                        <span class="text-[10px] text-ink-600 shrink-0">{Math.round(f.size / 1024)}K</span>
                      </button>
                    )}
                  </For>
                </div>
            </FloatMenu>
          </div>
        </Show>
        {/* Add Context (+) — Antigravity-style */}
        <div>
          <button
            ref={ctx.addBtn}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              ctx.setAddContextOpen(!ctx.addContextOpen());
              ctx.setModelMenuOpen(false);
            }}
            class="w-6 h-6 rounded-full hover:bg-ink-800 flex items-center justify-center cursor-pointer"
            data-rc-tip="Add context" aria-label="Add context"
          >
            <Iconify icon="lucide:plus" size={14} />
          </button>
          <FloatMenu anchor={() => ctx.addBtn} open={ctx.addContextOpen()} placement="top-start" width="12rem">
              <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                Add context
              </div>
              <button
                onClick={() => {
                  ctx.setAddContextOpen(false);
                  document.querySelector<HTMLInputElement>("#rc-file-input")?.click();
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:paperclip" size={13} />
                <span>Attach files</span>
              </button>
              <button
                onClick={() => {
                  ctx.setAddContextOpen(false);
                  ctx.setInputPrompt((p) => p + "@");
                  try {
                    document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
                  } catch {}
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:at-sign" size={13} />
                <span>Mentions</span>
              </button>
              <button
                onClick={() => {
                  ctx.setAddContextOpen(false);
                  ctx.setInputPrompt("/");
                  try {
                    document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
                  } catch {}
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
              >
                <Iconify icon="lucide:slash" size={13} />
                <span>Actions</span>
              </button>
            </FloatMenu>
        </div>
        <div>
          <button ref={ctx.modeBtn} data-menubtn aria-label="Agent mode and skills" aria-expanded={ctx.modeMenuOpen()}
            onClick={() => { const next = !ctx.modeMenuOpen(); ctx.closeMenus(); ctx.setModeMenuOpen(next); }}
            class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-elev cursor-pointer">
            <Iconify icon={ctx.agentMode() === "plan" ? "lucide:list-checks" : ctx.agentMode() === "learning" ? "lucide:graduation-cap" : ctx.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer"} size={14} />
            <span class="capitalize">{ctx.agentMode()}</span><Show when={ctx.selectedSkills().length}><span class="text-ink-500">+{ctx.selectedSkills().length}</span></Show>
            <Iconify icon="lucide:chevron-down" size={11} />
          </button>
          <FloatMenu anchor={() => ctx.modeBtn} open={ctx.modeMenuOpen()} placement="top-start" width="20rem">
            <p class="px-2 py-1.5 font-medium text-ink-400">Mode</p>
            <For each={[{id:"build", label:"Build", description:"Implement and validate changes", icon:"lucide:hammer"}, {id:"plan", label:"Plan", description:"Explore and plan without editing files", icon:"lucide:list-checks"}, {id:"talk", label:"Talk", description:"Conversational agent with web research, no workspace access", icon:"lucide:messages-square"}, {id:"learning", label:"Learning", description:"Learn through hints and guiding questions", icon:"lucide:graduation-cap"}]}>{(mode) =>
              <button role="menuitemradio" aria-checked={ctx.agentMode() === mode.id} onClick={() => { ctx.setAgentMode(mode.id); ctx.configureSession(); }} class="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-elev cursor-pointer">
                <Iconify icon={mode.icon} size={16} /><span class="flex-1"><span class="font-medium text-ink-100">{mode.label}</span><span class="block text-[11px] text-ink-500 mt-0.5">{mode.description}</span></span><Show when={ctx.agentMode() === mode.id}><Iconify icon="lucide:check" size={14} /></Show>
              </button>
            }</For>
            <div class="mt-1 border-t border-line pt-2"><p class="px-2 pb-1 font-medium text-ink-400">Additional skills</p>
              <For each={Object.entries(ctx.skills()).filter(([,skill]) => skill.enabled)} fallback={<p class="p-2 text-ink-500">Create custom skills in Settings.</p>}>{([name, skill]) =>
                <button role="menuitemcheckbox" aria-checked={ctx.selectedSkills().includes(name)} onClick={() => { ctx.setSelectedSkills((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]); ctx.configureSession(); }} class="w-full rounded-lg px-2 py-2 flex items-center gap-2 text-left hover:bg-elev cursor-pointer">
                  <Iconify icon="lucide:puzzle" size={14} /><span class="flex-1"><span class="text-ink-200">{name}</span><span class="block text-[11px] text-ink-500">{skill.description}</span></span><Show when={ctx.selectedSkills().includes(name)}><Iconify icon="lucide:check" size={14} /></Show>
                </button>
              }</For>
            </div>
          </FloatMenu>
        </div>
        <div>
          <button ref={ctx.accessBtn} data-menubtn aria-label="Agent permissions" aria-expanded={ctx.accessMenuOpen()}
            onClick={() => { const next = !ctx.accessMenuOpen(); ctx.closeMenus(); ctx.setAccessMenuOpen(next); }}
            class={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs hover:bg-elev cursor-pointer transition-colors ${
              ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""
            }`}>
            <Iconify icon={ctx.yoloMode() ? "lucide:shield-alert" : "lucide:hand"} size={14} class={ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""} /><span class={`hidden sm:inline ${ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""}`}>{ctx.yoloMode() ? "Full access" : "Ask for approval"}</span>
          </button>
          <FloatMenu anchor={() => ctx.accessBtn} open={ctx.accessMenuOpen()} placement="top-start" width="22rem">
            <p class="px-2 py-2 text-ink-400">How should actions be approved?</p>
            <For each={[{full:false, label:"Ask for approval", description:"Ask before every tool call, including reads and commands.", icon:"lucide:hand"}, {full:true, label:"Full access", description:"Allow all tool calls without asking (YOLO).", icon:"lucide:shield-alert"}]}>{(access) =>
              <button role="menuitemradio" aria-checked={ctx.yoloMode() === access.full} onClick={() => { ctx.setYoloMode(access.full); ctx.configureSession(); ctx.setAccessMenuOpen(false); }} class="w-full flex items-center gap-3 px-2 py-3 text-left rounded-lg hover:bg-elev cursor-pointer">
                <Iconify icon={access.icon} size={19} class={access.full ? "text-amber-800 dark:text-amber-200" : ""} /><span class="flex-1"><span class={`font-medium ${access.full ? "text-amber-800 dark:text-amber-200" : "text-ink-100"}`}>{access.label}</span><span class={`block mt-1 text-[11px] ${access.full ? "text-amber-800/80 dark:text-amber-200/80" : "text-ink-500"}`}>{access.description}</span></span><Show when={ctx.yoloMode() === access.full}><Iconify icon="lucide:check" size={14} class={access.full ? "text-amber-800 dark:text-amber-200" : ""} /></Show>
              </button>
            }</For>
            <Show when={ctx.agentMode() !== "build"}>
              <div class="px-2 py-2">
                <p class="text-[11px] text-ink-500">{ctx.agentMode() === "plan" ? "Plan explores freely but never mutates. Edit, create and patch are disabled." : ctx.agentMode() === "talk" ? "Talk chats with web research. No workspace access at all." : "Learning observes read-only. Edit, create, patch and code execution are disabled."}</p>
                <div class="mt-1.5 flex flex-wrap gap-1">
                  <For each={ctx.agentMode() === "plan"
                    ? ["read", "search", "inspect", "bash", "glob", "question", "todo", "search_web", "fetch_url"]
                    : ctx.agentMode() === "talk"
                    ? ["question", "search_web", "fetch_url", "todo"]
                    : ["read", "search", "inspect", "glob", "question", "todo", "search_web", "fetch_url"]}>
                    {(cap) => <span class="rounded-md bg-ink-700/60 px-1.5 py-px font-mono text-[10px] text-ink-300">{cap}</span>}
                  </For>
                  <For each={ctx.agentMode() === "plan" ? ["write", "edit", "patch"] : ctx.agentMode() === "talk" ? ["read", "write", "edit", "patch", "search", "inspect", "bash", "python", "glob"] : ["write", "edit", "patch", "bash", "python"]}>
                    {(cap) => <span class="rounded-md border border-line/60 px-1.5 py-px font-mono text-[10px] text-ink-600 line-through">{cap}</span>}
                  </For>
                </div>
              </div>
            </Show>
          </FloatMenu>
        </div>
        {/* Model picker (moved from the removed topbar) */}
        <div>
          <button
            ref={ctx.modelBtn}
            data-menubtn
            onClick={(e) => {
              e.stopPropagation();
              ctx.setModelMenuOpen(!ctx.modelMenuOpen());
              ctx.setProjectMenuOpen(false);
              ctx.setAddContextOpen(false);
              ctx.setUsageOpen(false);
            }}
            class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium cursor-pointer"
            data-rc-tip="Switch model" aria-label="Switch model"
          >
            <span class="max-w-[120px] sm:max-w-[150px] truncate">{ctx.activeModel().split("/").pop() || "Select model"}</span>
            <span class="uppercase text-ink-500 shrink-0 text-[11px]">{formatEffort(ctx.effort())}</span>
            <Iconify icon="lucide:chevron-down" size={11} class="shrink-0" />
          </button>
          <FloatMenu anchor={() => ctx.modelBtn} open={ctx.modelMenuOpen()} placement="top-start" width="26rem">
            <div>{ctx.modelPickerBody()}</div>
          </FloatMenu>

        </div>

      </div>

      <div class="flex shrink-0 items-center">
        <Show
          when={ctx.sessionStatus() === "running"}
          fallback={
            <button
              onClick={ctx.sendPrompt}
              disabled={
                ctx.creatingSession() || !ctx.activeModel() ||
                (ctx.activeSessionId()
                  ? !ctx.inputPrompt().trim() && ctx.pendingAttachments().length === 0
                  : (!ctx.inputPrompt().trim() && ctx.pendingAttachments().length === 0) || !ctx.activeProject())
              }
              class="w-7 h-7 rounded-full bg-ink-100 text-ink-950 hover:bg-accent-400 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all cursor-pointer"
              data-rc-tip={!ctx.activeSessionId() ? "Start conversation" : "Send"}
              aria-label={!ctx.activeSessionId() ? "Start conversation" : "Send"}
            >
              <Iconify icon="lucide:arrow-right" size={14} />
            </button>
          }
        >
          <button
            onClick={ctx.cancelCurrentTurn}
            class="w-7 h-7 rounded-full bg-rose-950 text-rose-50 hover:bg-rose-900 border border-rose-800/40 flex items-center justify-center transition-colors cursor-pointer"
            data-rc-tip="Stop"
            aria-label="Stop"
          >
            <Iconify icon="lucide:square" size={13} />
          </button>
        </Show>
      </div>
    </div>
    <input
      id="rc-file-input"
      type="file"
      class="hidden"
      multiple
      onChange={(e) => {
        ctx.handleFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
     />
  </div>
    </Show>
    <Show when={ctx.activeSessionId()}>
      <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-ink-500" data-composer-footer>
        <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={ctx.currentProject()?.path}><Iconify icon="lucide:folder" size={13} /><span class="truncate">{ctx.currentProject()?.name || baseNameOf(ctx.activeSession()?.cwd) || "Project"}</span></span>
        <FloatMenu anchor={() => ctx.contextBtn} open={ctx.usageOpen()} placement="top-end" width="19rem">
          <div class="p-1.5 text-xs">
            <div class="font-semibold text-ink-200 mb-3">Conversation context</div>
            <div class="text-lg font-medium text-ink-100 tabular-nums">{ctx.activeContext().label}</div>
            <p class="text-[11px] text-ink-500 mt-1 leading-relaxed">
              {ctx.activeContext().window > 0 ? `${compactTokens(ctx.activeContext().window)} tokens configured in the gateway.` : "Context limit not configured in the gateway."}
              {" "}Measured from the latest model request and its response.
            </p>
            <Show when={ctx.activeContext().percent !== null}>
              <div class="h-1.5 rounded-full bg-elev overflow-hidden mt-3" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, ctx.activeContext().percent ?? 0)}>
                <div class="h-full rounded-full bg-accent-500" style={{ width: `${Math.min(100, ctx.activeContext().percent ?? 0)}%` }} />
              </div>
            </Show>
            <div class="font-semibold text-ink-200 mb-2 mt-4 pt-3 border-t border-line">Session usage</div>
            <Show
              when={ctx.activeUsage()}
              fallback={
                <p class="text-ink-500 text-[11px]">
                  No usage reported yet. Run the agent to see input / cache / output tokens here.
                </p>
              }
            >
              {(u) => (
                <div class="space-y-1.5 font-mono text-[11px]">
                  <div class="flex justify-between"><span class="text-ink-500">Input</span><span class="text-ink-200">{u().inTok.toLocaleString()}</span></div>
                  <div class="flex justify-between"><span class="text-ink-500">Cache</span><span class="text-ink-200">{u().cacheTok.toLocaleString()}</span></div>
                  <div class="flex justify-between"><span class="text-ink-500">Output</span><span class="text-ink-200">{u().outTok.toLocaleString()}</span></div>
                  <div class="flex justify-between"><span class="text-ink-500">Reasoning</span><span class="text-ink-200">{u().reasoningTok.toLocaleString()}</span></div>
                  <Show when={u().costUsd > 0}>
                    <div class="flex justify-between pt-1 border-t border-line/60"><span class="text-ink-500">Cost</span><span class="text-ink-200">${u().costUsd.toFixed(4)}</span></div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </FloatMenu>
        <Tooltip content="Conversation context and session usage">
          <button ref={ctx.contextBtn} data-menubtn aria-label={`Conversation context: ${ctx.activeContext().label}`} aria-expanded={ctx.usageOpen()}
            onClick={() => { const next = !ctx.usageOpen(); ctx.closeMenus(); ctx.setUsageOpen(next); }}
            class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-ink-400 hover:bg-elev hover:text-ink-200 cursor-pointer">
            <Iconify icon="lucide:chart-pie" size={12} /><span>{ctx.activeContext().label}</span>
          </button>
        </Tooltip>
      </div>
    </Show>
  </div>
</div>
</Show>
</>
  );
}
