import { For, Show, createSignal } from "solid-js";
import { useBackground, useUI } from "../ctx";
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

function statusBadge(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "running") return null;
  const color =
    s === "done"
      ? "bg-emerald-500/15 text-emerald-300"
      : s === "error"
        ? "bg-rose-500/15 text-rose-300"
        : "bg-ink-800 text-ink-300";
  return (
    <span class={`shrink-0 rounded px-1.5 py-px font-mono text-[10px] ${color}`}>
      {s || "done"}
    </span>
  );
}

/**
 * Background tasks card (below the transcript, above the queue).
 *
 * Session-global tasks (daemon BgTasks): one row per bash/python task of
 * the open session — running AND finished. Finished tasks stay rendered
 * forever (like a tool call), with a collapsible log view fed by the
 * session tail (content) + live stream (output). Running rows show a
 * live elapsed counter and a stop button.
 */
export function BackgroundCard() {
  const bg = useBackground();
  const ui = useUI();
  const tasks = () => bg.sessionJobs().filter((j) => j.kind === "bash" || j.kind === "python");
  const running = () => tasks().filter((j) => j.status === "running");
  const [open, setOpen] = createSignal<Record<string, boolean>>({});
  const isOpen = (id: string) => open()[id] === true;
  const toggle = (id: string) => setOpen((prev) => ({ ...prev, [id]: !prev[id] }));
  const logText = (job: any) => {
    // Session tail (authoritative) + live stream glued after it.
    const sess = typeof job.content === "string" ? job.content : bg.sessionContent(job.id) || "";
    const live = bg.output()[job.id] || "";
    if (sess && live && !sess.endsWith(live.slice(0, 64))) return sess + live;
    return sess + live;
  };
  return (
    <Show when={tasks().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto border-t border-line/60 px-3 py-2`}>
        <div class="text-[11px] uppercase tracking-wide text-ink-500 pb-1.5">
          Background tasks · {running().length > 0 ? `${running().length} running` : "all finished"}
        </div>
        <div class="flex flex-col gap-1.5">
          <For each={tasks()}>
            {(job) => (
              <div class="rounded-lg border border-line/60 bg-ink-900/40">
                <div class="flex items-center gap-2 px-2.5 py-1.5">
                  <Show
                    when={job.status === "running"}
                    fallback={<Iconify icon={job.status === "error" ? "lucide:circle-x" : "lucide:circle-check"} size={14} class={`shrink-0 ${job.status === "error" ? "text-rose-400" : "text-emerald-400"}`} />}
                  >
                    <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  </Show>
                  <Iconify
                    icon={job.kind === "python" ? "mdi:language-python" : "lucide:terminal"}
                    size={14}
                    class="shrink-0 text-ink-500"
                  />
                  <span class="truncate text-ink-200 min-w-0 flex-1 text-[12.5px]">
                    <ShellCmd text={shortLabel(job.label || job.id)} />
                  </span>
                  {statusBadge(job.status)}
                  <Show when={job.status === "running"}>
                    <span class="text-[11px] text-ink-500 tabular-nums shrink-0">
                      {elapsedLabel(Math.max(0, bg.clock() - ((job as any).startedAt || bg.clock())))}
                    </span>
                    <button
                      class="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-400 hover:text-ink-100 hover:border-ink-500"
                      onClick={() => bg.stop(job.id)}
                      data-bg-stop={job.id}
                    >
                      Stop
                    </button>
                  </Show>
                  <button
                    class="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-400 hover:text-ink-100 hover:border-ink-500"
                    onClick={() => toggle(job.id)}
                  >
                    {isOpen(job.id) ? "Hide logs" : "Logs"}
                  </button>
                </div>
                <Show when={isOpen(job.id)}>
                  <div class="border-t border-line/50">
                    <CodeBlock text={logText(job) || "No output yet."} language={undefined} scrollKey={`bg:${job.id}`} />
                    <Show when={(job as any).droppedLines > 0}>
                      <p class="px-3 pb-1.5 text-[10px] text-ink-600">
                        {(job as any).droppedLines} earlier lines discarded by the tail cap — use bg_check for full paging.
                      </p>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
