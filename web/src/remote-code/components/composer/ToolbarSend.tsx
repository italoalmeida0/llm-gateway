import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import type { RemoteCodeViewCtx } from "../../viewCtx";

export function ToolbarSend(ctx: RemoteCodeViewCtx) {
  return (
<>
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
</>
  );
}
