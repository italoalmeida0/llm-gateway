import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { DiffView } from "./CodeBlock";
import { FileIcon } from "../presentation";
import type { TurnBalloon, TurnChangedFile } from "../hooks/useTurnChanges";

export interface TurnChangesBalloonProps {
  balloon: TurnBalloon;
  expanded: boolean;
  onToggle: () => void;
  undoBusy: boolean;
  onUndo: () => void;
  live?: boolean;
  /** Refresh the live view on demand (visible only while the turn runs). */
  onReview?: () => void;
}

function statusMeta(status: TurnChangedFile["status"]) {
  switch (status) {
    case "new":
      return { icon: "lucide:file-plus-2", label: "new", cls: "text-emerald-400" };
    case "modified":
      return { icon: "lucide:file-diff", label: "modified", cls: "text-amber-300" };
    case "deleted":
      return { icon: "lucide:file-minus-2", label: "deleted", cls: "text-red-400" };
    case "binary":
      return { icon: "lucide:file-warning", label: "binary", cls: "text-ink-400" };
    default:
      return { icon: "lucide:file-warning", label: "too large", cls: "text-ink-400" };
  }
}

/** One file row inside the balloon: collapsed header by default, click to
 *  reveal the highlighted diff (like edit tool results). */
function FileChangesRow(props: { f: TurnChangedFile; scrollKey: string }) {
  const [open, setOpen] = createSignal(false);
  const meta = statusMeta(props.f.status);
  const hasDiff = () => Boolean(props.f.diff);

  return (
    <div class="rounded-lg border border-line/50 overflow-hidden">
      <div
        onClick={() => setOpen(!open())}
        class={`flex items-center gap-2 px-2.5 py-1.5 bg-ink-900/60 transition-colors select-none ${
          hasDiff() ? "cursor-pointer hover:bg-ink-900" : ""
        }`}
      >
        <Show when={hasDiff()}>
          <Iconify
            icon="lucide:chevron-right"
            size={12}
            class={`shrink-0 text-ink-500 transition-transform ${open() ? "rotate-90" : ""}`}
          />
        </Show>
        <FileIcon path={props.f.rel || props.f.path} size={13} />
        <span class="text-[11px] font-mono text-ink-200 truncate" title={props.f.path}>
          {props.f.rel || props.f.path}
        </span>
        <span class={`text-[10px] uppercase tracking-wide flex items-center gap-1 shrink-0 ${meta.cls}`}>
          <Iconify icon={meta.icon} size={12} />
          {meta.label}
        </span>
        <Show when={(props.f.additions || 0) > 0 || (props.f.deletions || 0) > 0}>
          <span class="text-[10px] font-mono ml-auto shrink-0">
            <span class="text-emerald-400">+{props.f.additions || 0}</span>{" "}
            <span class="text-red-400">-{props.f.deletions || 0}</span>
          </span>
        </Show>
        <Show when={props.f.undone}>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-300 border border-line/60 shrink-0">
            undone
          </span>
        </Show>
      </div>
      <Show when={open() && hasDiff()}>
        <div class="border-t border-line/30 bg-ink-950/40">
          <DiffView text={props.f.diff || ""} name={props.f.rel || props.f.path} scrollKey={props.scrollKey} />
        </div>
      </Show>
      <Show when={open() && !hasDiff()}>
        <div class="px-2.5 py-1.5 text-[11px] text-ink-500 border-t border-line/30">
          {props.f.status === "binary" ? "Binary file — no textual diff." : "File too large for a textual diff."}
        </div>
      </Show>
    </div>
  );
}

export function TurnChangesBalloon(props: TurnChangesBalloonProps) {
  const files = () => props.balloon.files || [];
  const totalAdds = () => files().reduce((n, f) => n + (f.additions || 0), 0);
  const totalDels = () => files().reduce((n, f) => n + (f.deletions || 0), 0);
  const undoneCount = () => files().filter((f) => f.undone).length;

  return (
    <Show when={files().length > 0}>
      <div class="w-full flex justify-center my-3 select-text">
        <div class="w-full max-w-2xl rounded-xl border border-line/70 bg-card p-3 shadow-xs transition-all">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={props.onToggle}
            class="flex items-center gap-2 cursor-pointer text-left group focus:outline-none"
          >
            <Iconify
              icon={props.expanded ? "lucide:chevron-down" : "lucide:chevron-right"}
              size={14}
              class="text-ink-500 group-hover:text-ink-200 transition-colors"
            />
            <Iconify icon={props.live ? "lucide:loader-circle" : "lucide:files"} size={14} class={props.live ? "text-accent-400 animate-spin" : "text-accent-400"} />
            <span class="text-xs font-semibold text-ink-100">
              File changes
            </span>
            <span class="text-[11px] text-ink-500">
              {files().length} file{files().length === 1 ? "" : "s"}
            </span>
            <Show when={totalAdds() > 0 || totalDels() > 0}>
              <span class="text-[11px] font-mono">
                <span class="text-emerald-400">+{totalAdds()}</span>{" "}
                <span class="text-red-400">-{totalDels()}</span>
              </span>
            </Show>
            <Show when={!props.live && undoneCount() > 0}>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-300 border border-line/60">
                undone{undoneCount() < files().length ? " (partial)" : ""}
              </span>
            </Show>
          </button>
          <Show when={props.live && props.onReview}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onReview!();
              }}
              class="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border border-line/70 text-ink-300 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:refresh-cw" size={13} />
              Review changes
            </button>
          </Show>
          <Show when={!props.live}>
            <button
              type="button"
              disabled={props.undoBusy}
              onClick={(e) => {
                e.stopPropagation();
                props.onUndo();
              }}
              class="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border border-line/70 text-ink-300 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Iconify icon={props.undoBusy ? "lucide:loader-circle" : "lucide:undo-2"} size={13} class={props.undoBusy ? "animate-spin" : ""} />
              {props.undoBusy ? "Undoing…" : "Undo"}
            </button>
          </Show>
        </div>

        <Show when={props.expanded}>
          <div class="mt-2 flex flex-col gap-2">
            <For each={files()}>
              {(f) => (
                <FileChangesRow
                  f={f}
                  scrollKey={`turn-${props.balloon.turnIndex}:${f.path}`}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
    </Show>
  );
}
