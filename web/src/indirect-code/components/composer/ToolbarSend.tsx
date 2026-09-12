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
        class="ui-button ui-button-primary ui-button-sm w-8 h-8 p-0"
        data-rc-tip={!s.activeSessionId() ? "Start conversation" : "Send"}
        aria-label={!s.activeSessionId() ? "Start conversation" : "Send"}
      >
        <Iconify icon="lucide:arrow-right" size={14} />
      </button>
    }
  >
    <button
      onClick={t.cancelCurrentTurn}
      class="ui-button ui-button-danger ui-button-sm w-8 h-8 p-0"
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
