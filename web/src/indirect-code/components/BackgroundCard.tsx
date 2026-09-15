import { For, Show } from "solid-js";
import { useBackground, useUI } from "../ctx";
import { elapsedLabel } from "../utils/format";
import { Icon as Iconify } from "../../components/icon";
import { ShellCmd } from "./CodeBlock";

/** Middle-truncated one-line command for the card row. */
function shortLabel(cmd: string, max = 64) {
  const one = cmd.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const head = Math.ceil((max - 3) / 2);
  const tail = max - 3 - head;
  return `${one.slice(0, head)}...${one.slice(one.length - tail)}`;
}

/**
 * Background tasks card (below the transcript, above the queue).
 *
 * One row per RUNNING bash/python job of the open session: the detached
 * command (same highlighted rendering as the tool row header), a live
 * elapsed counter and a stop button. No logs here — output streams into
 * the originating tool row and the .log file. Finished jobs disappear:
 * their result is folded into the tool row instead.
 */
export function BackgroundCard() {
  const bg = useBackground();
  const ui = useUI();
  const running = () => bg.sessionJobs().filter((j) => j.status === "running" && (j.kind === "bash" || j.kind === "python"));
  return (
    <Show when={running().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto border-t border-line/60 px-3 py-2`}>
        <div class="text-[11px] uppercase tracking-wide text-ink-500 pb-1.5">
          Background tasks · {running().length} running
        </div>
        <div class="flex flex-col gap-1.5">
          <For each={running()}>
            {(job) => (
              <div class="flex items-center gap-2 rounded-lg border border-line/60 bg-ink-900/40 px-2.5 py-1.5">
                <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                <Iconify
                  icon={job.kind === "python" ? "mdi:language-python" : "lucide:terminal"}
                  size={14}
                  class="shrink-0 text-ink-500"
                />
                <span class="truncate text-ink-200 min-w-0 flex-1 text-[12.5px]">
                  <ShellCmd text={shortLabel(job.label || job.id)} />
                </span>
                <span class="text-[11px] text-ink-500 tabular-nums shrink-0">
                  {elapsedLabel(Math.max(0, bg.clock() - (job.startedAt || bg.clock())))}
                </span>
                <button
                  class="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-400 hover:text-ink-100 hover:border-ink-500"
                  onClick={() => bg.stop(job.id)}
                  title="Stop this background task"
                  data-bg-stop={job.id}
                >
                  Stop
                </button>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
