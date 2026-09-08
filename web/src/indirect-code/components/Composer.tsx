import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useComposerCtx, useSession, useTranscriptCtx, useUI } from "../ctx";
import { ScrollOverlays } from "./composer/ScrollOverlays";
import { StatusBanners } from "./composer/StatusBanners";
import { ComposerInput } from "./composer/ComposerInput";
import { ToolbarFiles } from "./composer/ToolbarFiles";
import { ToolbarContext } from "./composer/ToolbarContext";
import { ToolbarModel } from "./composer/ToolbarModel";
import { ToolbarSend } from "./composer/ToolbarSend";
import { ComposerFooter } from "./composer/ComposerFooter";

export function Composer() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const ui = useUI();
  return (
<>

<Show when={!ui.historyView()}>
<div class={s.draftMode() ? "flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-10" : "px-4 pb-4 pt-2 bg-ink-950 relative z-20"}>
  <ScrollOverlays />
  <div class="w-full max-w-2xl mx-auto">
  <StatusBanners />
    <Show when={!s.workspaceBlocked()} fallback={
      <div role="status" class="rounded-2xl border border-line bg-elev px-4 py-4 text-sm text-ink-300" data-workspace-unavailable>
        <div class="flex items-center gap-2 font-medium text-ink-100"><Iconify icon="lucide:folder-x" size={17} />{s.workspaceState() === "missing" ? "The project folder was deleted" : "The project folder is unavailable"}</div>
        <p class="mt-2 text-xs text-ink-500">{s.workspaceState() === "missing" ? "Recreate this folder on the host to continue this conversation." : "Restore access to this folder on the host to continue."}</p>
        <p class="mt-2 font-mono text-xs break-all">{s.workspacePath()}</p>
        <div class="mt-3 flex gap-3"><button onClick={s.checkWorkspace} class="text-xs text-ink-200 hover:underline cursor-pointer">Check again</button><Show when={t.sessionStatus() === "running"}><button onClick={t.cancelCurrentTurn} class="text-xs text-ink-200 hover:underline cursor-pointer">Stop turn</button></Show></div>
      </div>
    }>
    <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors relative flex flex-col">
    <ComposerInput />
    <div class="flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
      <div class="flex flex-1 min-w-0 flex-wrap items-center gap-0.5 text-xs text-ink-400">
      <ToolbarFiles />
      <ToolbarContext />
      <ToolbarModel />
      </div>
      <ToolbarSend />
    </div>
    <input
      id="rc-file-input"
      type="file"
      class="hidden"
      multiple
      onChange={(e) => {
        c.handleFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
     />
  </div>
    </Show>
    <ComposerFooter />
  </div>
</div>
</Show>
</>
  );
}
