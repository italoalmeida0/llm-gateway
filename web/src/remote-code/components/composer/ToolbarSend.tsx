import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useSession, useTranscriptCtx } from "../../ctx";

export function ToolbarSend() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  return (
<>
<div class="flex shrink-0 items-center">
  <Show
    when={t.sessionStatus() === "running"}
    fallback={
      <button
        onClick={c.sendPrompt}
        disabled={
          s.creatingSession() || !c.activeModel() ||
          (s.activeSessionId()
            ? !c.inputPrompt().trim() && c.pendingAttachments().length === 0
            : (!c.inputPrompt().trim() && c.pendingAttachments().length === 0) || !s.activeProject())
        }
        class="w-7 h-7 rounded-full bg-ink-100 text-ink-950 hover:bg-accent-400 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all cursor-pointer"
        data-rc-tip={!s.activeSessionId() ? "Start conversation" : "Send"}
        aria-label={!s.activeSessionId() ? "Start conversation" : "Send"}
      >
        <Iconify icon="lucide:arrow-right" size={14} />
      </button>
    }
  >
    <button
      onClick={t.cancelCurrentTurn}
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
