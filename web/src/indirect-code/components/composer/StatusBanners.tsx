import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useHost, useSession, useTranscriptCtx, useUI } from "../../ctx";
import { IndirectBrand } from "../IndirectBrand";

export function StatusBanners() {
  const s = useSession();
  const t = useTranscriptCtx();
  const h = useHost();
  const ui = useUI();
  return (
<>
<Show when={s.draftMode()}>
  <div class="mb-6">
    <IndirectBrand />
  </div>
</Show>
<Show when={s.activeSessionId() && t.turnActivity()}>
  <div role="status" data-turn-status class="mb-2 flex items-center gap-2 text-xs text-ink-500 min-w-0">
    <Iconify icon={t.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:clock-3"} size={13} class={t.sessionStatus() === "running" ? "animate-spin shrink-0" : "shrink-0"} />
    <span class="shrink-0">{t.turnLabel()}</span>
    <Show when={t.turnHint()}>{(hint) =>
      <span class="min-w-0 flex-1 truncate whitespace-nowrap overflow-hidden" title={hint()}>{hint()}</span>
    }</Show>
  </div>
</Show>
<Show when={s.activeSessionId() && t.todos().length}>
  <section aria-label="Task checklist" class="mb-2 rounded-xl border border-line bg-elev/40 text-xs">
    <button onClick={() => t.toggleTodosOpen()} aria-expanded={t.todosOpen()} class="w-full px-3 py-2.5 flex items-center gap-2 text-ink-300 cursor-pointer">
      <Iconify icon="lucide:list-checks" size={15} /><span class="font-medium">Task plan</span>
      <span class="text-ink-500">{t.todos().filter((item) => item.status === "completed").length}/{t.todos().length}</span>
      <span class="flex-1 truncate text-left text-ink-500">{!t.todosOpen() ? t.todos().find((item) => item.status === "in_progress")?.text : ""}</span>
      <Iconify icon="lucide:chevron-down" size={13} class={t.todosOpen() ? "rotate-180" : ""} />
    </button>
    <Show when={t.todosOpen()}><ol class="px-3 pb-3 space-y-2 max-h-44 overflow-y-auto">
      <For each={t.todos()}>{(item) => <li class="flex items-start gap-2" data-todo-status={item.status}>
        <Iconify icon={item.status === "completed" ? "lucide:circle-check" : item.status === "in_progress" ? t.sessionStatus() === "running" ? "lucide:loader-circle" : "lucide:circle-dot" : "lucide:circle"} size={14} class={item.status === "in_progress" && t.sessionStatus() === "running" ? "animate-spin text-ink-200" : "text-ink-500"} />
        <span class={item.status === "completed" ? "text-ink-500 line-through" : "text-ink-200"}>{item.text}</span>
      </li>}</For>
    </ol></Show>
  </section>
</Show>
<Show when={ui.appNotice()}>{(notice) =>
  <div role={notice().kind === "err" ? "alert" : "status"} class={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${notice().kind === "err" ? "border-brand-500/30 bg-brand-500/5 text-ink-200" : "border-line bg-elev text-ink-300"}`}>
    <Iconify icon={notice().kind === "err" ? "lucide:circle-alert" : "lucide:check"} size={15} class={notice().kind === "err" ? "text-brand-500" : "text-ink-400"} />
    <span class="min-w-0 flex-1 break-words">{notice().message}</span>
    <button aria-label="Dismiss notification" onClick={() => ui.setAppNotice(null)} class="text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:x" size={13} /></button>
  </div>
}</Show>
<Show when={h.activeHost() && (h.connectionState() !== "connected" || h.activeHost()?.status !== "online")}>
  <div class="rc-delayed-banner">
    <div role="status" class="rounded-xl border border-line bg-elev p-3 text-xs text-ink-300 flex items-start gap-2">
      <Iconify icon="lucide:unplug" size={15} class="text-ink-500" />
      <div class="flex-1"><p class="font-medium">{h.connectionState() !== "connected" ? "Reconnecting to the gateway…" : `${h.activeHost()?.name || "Host"} is offline`}</p><p class="mt-1 text-ink-500">Your draft is kept here. Start the daemon on this host to continue.</p></div>
      <button onClick={h.loadHosts} class="text-ink-200 hover:underline cursor-pointer">Retry</button>
    </div>
  </div>
</Show>
</>
  );
}
