import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { useBackground, useUI } from "../ctx";
import type { SessionBgTask } from "../hooks/useBackground";
import { elapsedLabel } from "../utils/format";
import { Icon as Iconify } from "../../components/icon";
import { CodeBlock, ShellCmd } from "./CodeBlock";

/** Middle-truncated one-line command for the card row. */
function shortLabel(cmd: string, max = 64) {
  const one = cmd.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const head = Math.ceil((max - 3) / 2);
  const tail = max - 3 - head;
  return `${one.slice(0, head)}...${one.slice(one.length - tail)}`;
}

function taskState(status: string) {
  switch (status) {
    case "running": return { label: "Running", icon: "lucide:loader-circle", color: "text-ink-400" };
    case "done": return { label: "Completed", icon: "lucide:circle-check", color: "text-emerald-400" };
    case "error": return { label: "Failed", icon: "lucide:circle-x", color: "text-rose-400" };
    case "cancelled": return { label: "Cancelled", icon: "lucide:circle-slash", color: "text-ink-500" };
    default: return { label: "Stopped", icon: "lucide:circle-stop", color: "text-ink-500" };
  }
}

/**
 * Background tasks card (below the transcript, above the queue).
 *
 * Session-global tasks (daemon BgTasks): one row per bash/python task of
 * the open session. The daemon status determines the running/archive split
 * on every client; archiving never changes or deletes a task. Both views
 * start with the three newest tasks and retain access to their logs.
 */
export function BackgroundCard(props: { contextKey?: string }) {
  const bg = useBackground();
  const ui = useUI();
  const [showArchived, setShowArchived] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [open, setOpen] = createSignal<Record<string, boolean>>({});
  const tasks = createMemo(() => bg.sessionJobs()
    .filter((j) => j.kind === "bash" || j.kind === "python")
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)));
  const running = createMemo(() => tasks().filter((j) => j.status === "running"));
  const archived = createMemo(() => tasks().filter((j) => j.status !== "running"));
  const selected = createMemo(() => showArchived() ? archived() : running());
  const visible = createMemo(() => expanded() ? selected() : selected().slice(0, 3));

  createEffect(on(() => props.contextKey, () => {
    setShowArchived(false);
    setExpanded(false);
    setOpen({});
  }));

  function toggleArchive() {
    setShowArchived((value) => !value);
    setExpanded(false);
  }

  function duration(job: SessionBgTask) {
    if (!Number.isFinite(job.startedAt) || job.startedAt <= 0) return "—";
    const end = job.status === "running" ? bg.clock() : job.endedAt;
    return typeof end === "number" && end > 0
      ? elapsedLabel(Math.max(0, end - job.startedAt)) : "—";
  }

  const isOpen = (id: string) => open()[id] === true;
  const toggle = (id: string) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  const logText = (job: SessionBgTask) => {
    // Session tail (authoritative) + live output not covered by the snapshot.
    const sess = typeof job.content === "string" ? job.content : bg.sessionContent(job.id) || "";
    const live = bg.liveTail(job.id);
    if (!live) return sess;
    if (!sess) return live;
    return sess.endsWith("\n") ? sess + live : sess + "\n" + live;
  };
  return (
    <Show when={tasks().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto border-t border-line/60 px-3 py-2`} data-bg-card>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 pb-2">
          <span class="text-[11px] uppercase tracking-wide text-ink-500">Background tasks</span>
          <button
            type="button"
            class={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${showArchived()
              ? "border-brand-500/30 bg-brand-500/10 text-brand-400"
              : "border-line/60 text-ink-500 hover:bg-elev hover:text-ink-200"}`}
            aria-pressed={showArchived()}
            aria-label={`Archived tasks (${archived().length})`}
            title={showArchived() ? "Show running tasks" : "Show archived tasks"}
            onClick={toggleArchive}
            data-bg-archive-toggle
          >
            <Iconify icon="lucide:archive" size={12} />
            <span class="tabular-nums opacity-80">{archived().length}</span>
          </button>
          <span class="ml-auto text-[10px] uppercase tracking-wide text-ink-500 tabular-nums whitespace-nowrap" data-bg-running-count>
            {running().length} running
          </span>
        </div>
        <Show when={selected().length > 0}>
        <div class="flex flex-col gap-1.5">
          <For each={visible()}>
            {(job) => (
              <div class="rounded-lg bg-card" data-bg-row={job.id}>
                <div class="flex items-center gap-2 px-2.5 py-1.5">
                  <span
                    class={`inline-flex shrink-0 ${taskState(job.status).color}`}
                    role="img"
                    aria-label={taskState(job.status).label}
                    title={taskState(job.status).label}
                    data-bg-status={job.status}
                  >
                    <Iconify icon={taskState(job.status).icon} size={14} class={job.status === "running" ? "animate-spin" : ""} />
                  </span>
                  <Iconify
                    icon={job.kind === "python" ? "mdi:language-python" : "lucide:terminal"}
                    size={14}
                    class="shrink-0 text-ink-500"
                  />
                  <span class="truncate text-ink-200 min-w-0 flex-1 text-[12.5px]" title={job.label || job.id}>
                    <ShellCmd text={shortLabel(job.label || job.id)} />
                  </span>
                  <span class="text-[11px] text-ink-500 tabular-nums shrink-0" title={job.status === "running" ? "Elapsed time" : "Total duration"} data-bg-duration>
                    {duration(job)}
                  </span>
                  <Show when={job.status === "running"}>
                    <button
                      type="button"
                      class="shrink-0 inline-flex items-center justify-center rounded p-1 text-ink-500 hover:text-ink-100 hover:bg-elev cursor-pointer"
                      onClick={() => bg.stop(job.id)}
                      aria-label="Stop task"
                      title="Stop task"
                      data-bg-stop={job.id}
                    >
                      <Iconify icon="lucide:square" size={12} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="shrink-0 inline-flex items-center justify-center rounded p-1 text-ink-500 hover:text-ink-100 hover:bg-elev cursor-pointer"
                    onClick={() => toggle(job.id)}
                    aria-expanded={isOpen(job.id)}
                    aria-label={isOpen(job.id) ? "Hide logs" : "Show logs"}
                    title={isOpen(job.id) ? "Hide logs" : "Show logs"}
                  >
                    <Iconify icon="lucide:chevron-down" size={14} class={`transition-transform ${isOpen(job.id) ? "rotate-180" : ""}`} />
                  </button>
                </div>
                <Show when={isOpen(job.id)}>
                  <div class="border-t border-line/50 rounded-b-lg overflow-hidden">
                    <CodeBlock text={logText(job) || "No output yet."} language={undefined} scrollKey={`bg:${job.id}`} />
                    <Show when={(job.droppedLines || 0) > 0}>
                      <p class="px-3 pb-1.5 text-[10px] text-ink-600">
                        {job.droppedLines} earlier lines discarded by the tail cap — use bg_check for full paging.
                      </p>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
          <Show when={selected().length > 3}>
            <button
              type="button"
              class="self-start px-3 py-2 text-xs text-ink-500 hover:text-ink-200 cursor-pointer"
              aria-expanded={expanded()}
              onClick={() => setExpanded((value) => !value)}
              data-bg-list-toggle
            >
              {expanded() ? "Show less" : `See all (${selected().length})`}
            </button>
          </Show>
        </div>
        </Show>
      </div>
    </Show>
  );
}
