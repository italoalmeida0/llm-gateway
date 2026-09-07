import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import type { RemoteCodeViewCtx } from "../viewCtx";
import { ScrollOverlays } from "./composer/ScrollOverlays";
import { StatusBanners } from "./composer/StatusBanners";
import { ComposerInput } from "./composer/ComposerInput";
import { ToolbarFiles } from "./composer/ToolbarFiles";
import { ToolbarContext } from "./composer/ToolbarContext";
import { ToolbarModel } from "./composer/ToolbarModel";
import { ToolbarSend } from "./composer/ToolbarSend";
import { ComposerFooter } from "./composer/ComposerFooter";

export function Composer(ctx: RemoteCodeViewCtx) {
  return (
<>
{/* Composer estilo Antigravity — hidden entirely until a project
    exists: without a project there is nothing to type into. */}
<Show when={!ctx.historyView()}>
<div class={ctx.draftMode() ? "flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-10" : "px-4 pb-4 pt-2 bg-ink-950 relative z-20"}>
  <ScrollOverlays {...ctx} />
  <div class="w-full max-w-2xl mx-auto">
  <StatusBanners {...ctx} />
    <Show when={!ctx.workspaceBlocked()} fallback={
      <div role="status" class="rounded-2xl border border-line bg-elev px-4 py-4 text-sm text-ink-300" data-workspace-unavailable>
        <div class="flex items-center gap-2 font-medium text-ink-100"><Iconify icon="lucide:folder-x" size={17} />{ctx.workspaceState() === "missing" ? "The project folder was deleted" : "The project folder is unavailable"}</div>
        <p class="mt-2 text-xs text-ink-500">{ctx.workspaceState() === "missing" ? "Recreate this folder on the host to continue this conversation." : "Restore access to this folder on the host to continue."}</p>
        <p class="mt-2 font-mono text-xs break-all">{ctx.workspacePath()}</p>
        <div class="mt-3 flex gap-3"><button onClick={ctx.checkWorkspace} class="text-xs text-ink-200 hover:underline cursor-pointer">Check again</button><Show when={ctx.sessionStatus() === "running"}><button onClick={ctx.cancelCurrentTurn} class="text-xs text-ink-200 hover:underline cursor-pointer">Stop turn</button></Show></div>
      </div>
    }>
    <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors relative flex flex-col">
    <ComposerInput {...ctx} />
    <div class="flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
      <div class="flex flex-1 min-w-0 flex-wrap items-center gap-0.5 text-xs text-ink-400">
      <ToolbarFiles {...ctx} />
      <ToolbarContext {...ctx} />
      <ToolbarModel {...ctx} />
      </div>
      <ToolbarSend {...ctx} />
    </div>
    <input
      id="rc-file-input"
      type="file"
      class="hidden"
      multiple
      onChange={(e) => {
        ctx.handleFiles(e.currentTarget.files ?? []);
        e.currentTarget.value = "";
      }}
     />
  </div>
    </Show>
    <ComposerFooter {...ctx} />
  </div>
</div>
</Show>
</>
  );
}
