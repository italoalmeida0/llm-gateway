import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import type { RemoteCodeViewCtx } from "../../viewCtx";
import { FloatMenu } from "../FloatMenu";
import { QuestionPanel } from "../QuestionModal";

export function StatusBanners(ctx: RemoteCodeViewCtx) {
  return (
<>
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
</>
  );
}
