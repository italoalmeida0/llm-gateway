import { createSignal, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { timeAgo } from "../utils/format";
import type { SessionSummary } from "../types";

export function SessionStopButton(props: {
  sessionId: string;
  isCancelling: boolean;
  onCancel: (e: MouseEvent | KeyboardEvent) => void;
}) {
  const [hovered, setHovered] = createSignal(false);
  return (
    <button
      type="button"
      onClick={(e) => props.onCancel(e)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      disabled={props.isCancelling}
      class={`w-4.5 h-4.5 rounded flex items-center justify-center shrink-0 border border-transparent transition-colors ${
        props.isCancelling
          ? "text-ink-500 opacity-60 cursor-default"
          : hovered()
            ? "text-rose-400 bg-rose-950/60 border-rose-800/40 cursor-pointer"
            : "text-emerald-400 cursor-pointer"
      } focus-visible:ring-1 focus-visible:ring-rose-500 focus:outline-none`}
      data-rc-tip={props.isCancelling ? "Stopping…" : "Stop"}
      aria-label={props.isCancelling ? "Stopping turn" : "Stop turn"}
    >
      <Show
        when={!props.isCancelling && hovered()}
        fallback={
          <Iconify
            icon="lucide:loader-2"
            size={12}
            class={`animate-spin ${props.isCancelling ? "text-ink-500" : "text-emerald-400"}`}
          />
        }
      >
        <Iconify
          icon="lucide:square"
          size={9}
          class="text-rose-400 fill-current"
        />
      </Show>
    </button>
  );
}

/** Linha de sessão da sidebar (row completa com rename inline + hover actions). */
export interface SessionRowCtx {
  activeSessionId: () => string | null;
  selectedSessions: () => Set<string>;
  selectionMode: () => boolean;
  renamingId: () => string | null;
  renameText: () => string;
  setRenameText: (v: string) => void;
  setRenamingId: (v: string | null) => void;
  submitRename: (id: string) => void;
  toggleSessionSelect: (id: string) => void;
  selectSession: (id: string) => void;
  setHistoryView: (v: boolean) => void;
  closeSidebarOnMobile: () => void;
  togglePin: (id: string, e: MouseEvent) => void;
  deleteSession: (id: string, e: MouseEvent) => void;
  sessionStatus: () => string;
  turnActivity: () => { status: string } | null;
  cancelTurnForSession: (id: string, e: MouseEvent | KeyboardEvent) => void;
}

export function SessionRow(ctx: SessionRowCtx, s: SessionSummary) {
  const isActive = () => s.id === ctx.activeSessionId();
  const selected = () => ctx.selectedSessions().has(s.id);
  return (
    <div
      onClick={() => {
        if (ctx.selectionMode()) {
          ctx.toggleSessionSelect(s.id);
          return;
        }
        ctx.setHistoryView(false);
        ctx.selectSession(s.id);
        ctx.closeSidebarOnMobile();
      }}
      onDblClick={() => {
        if (ctx.selectionMode()) return;
        ctx.setRenamingId(s.id);
        ctx.setRenameText(s.title);
      }}
      class={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
        isActive() && !ctx.selectionMode()
          ? "bg-ink-800 text-ink-50"
          : selected()
            ? "bg-ink-900 text-ink-100 ring-1 ring-ink-500/50"
            : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
      }`}
      data-rc-tip={`${s.title}\n${s.cwd}`}
    >
      <Show when={ctx.selectionMode()}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleSessionSelect(s.id);
          }}
          class={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
            selected() ? "bg-ink-100 border-ink-100" : "border-line bg-ink-950"
          }`}
          data-rc-tip="Select" aria-label="Select"
        >
          <Show when={selected()}>
            <Iconify icon="lucide:check" size={11} class="text-ink-950" />
          </Show>
        </button>
      </Show>
      <Show when={s.pinned && !ctx.selectionMode()}>
        <Iconify icon="lucide:pin" size={11} class="text-ink-500 shrink-0" />
      </Show>
      <Show
        when={ctx.renamingId() === s.id}
        fallback={
          <>
            <span class="truncate flex-1 min-w-0">{s.title}</span>
            <Show when={s.status === "running" || (s.id === ctx.activeSessionId() && ctx.sessionStatus() === "running")}>
              <SessionStopButton
                sessionId={s.id}
                isCancelling={s.id === ctx.activeSessionId() && ctx.turnActivity()?.status === "cancelling"}
                onCancel={(e) => ctx.cancelTurnForSession(s.id, e)}
              />
            </Show>
            <div class="relative flex items-center justify-end shrink-0 min-w-[34px]">
              <span class="text-[10px] text-ink-600 transition-opacity group-hover:opacity-0 group-hover:pointer-events-none">
                {timeAgo(s.updatedAt)}
              </span>
              <Show when={!ctx.selectionMode()}>
                <div class="absolute right-0 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => ctx.togglePin(s.id, e)}
                    class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
                    data-rc-tip={s.pinned ? "Unpin" : "Pin"} aria-label={s.pinned ? "Unpin" : "Pin"}
                  >
                    <Iconify icon={s.pinned ? "lucide:pin-off" : "lucide:pin"} size={11} />
                  </button>
                  <button
                    onClick={(e) => ctx.deleteSession(s.id, e)}
                    class="p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer"
                    data-rc-tip="Delete" aria-label="Delete"
                  >
                    <Iconify icon="lucide:trash-2" size={11} />
                  </button>
                </div>
              </Show>
            </div>
          </>
        }
      >
        <input
          type="text"
          class="flex-1 min-w-0 bg-ink-950 border border-ink-500 rounded px-1.5 py-0.5 text-[13px] text-ink-100 focus:outline-none"
          value={ctx.renameText()}
          onInput={(e) => ctx.setRenameText(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") ctx.submitRename(s.id);
            if (e.key === "Escape") ctx.setRenamingId(null);
          }}
          onClick={(e) => e.stopPropagation()}
          ref={(el) => setTimeout(() => el?.select(), 30)}
        />
      </Show>
    </div>
  );
}
