import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import type { RemoteCodeViewCtx } from "../../viewCtx";
import { FloatMenu } from "../FloatMenu";
import { FileIcon } from "../../presentation";

export function ToolbarFiles(ctx: RemoteCodeViewCtx) {
  return (
<>
{/* Session files (stored on the daemon) */}
<Show when={(ctx.sessionFiles()[ctx.activeSessionId()] || []).length > 0}>
  <div>
    <button
      ref={ctx.filesBtn}
      data-menubtn
      onClick={(e) => {
        e.stopPropagation();
        ctx.setFilesMenuOpen(!ctx.filesMenuOpen());
        ctx.setAddContextOpen(false);
        ctx.setModelMenuOpen(false);
      }}
      class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 cursor-pointer"
      data-rc-tip="Session files" aria-label="Session files"
    >
      <Iconify icon="lucide:paperclip" size={13} />
      <span>{(ctx.sessionFiles()[ctx.activeSessionId()] || []).length}</span>
    </button>
    <FloatMenu anchor={() => ctx.filesBtn} open={ctx.filesMenuOpen()} placement="top-start" width="15rem">
        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
          Session files
        </div>
        <div class="max-h-48 overflow-y-auto [scrollbar-gutter:stable]">
          <For each={ctx.sessionFiles()[ctx.activeSessionId()] || []}>
            {(f) => (
              <button
                onClick={() => {
                  ctx.setFilesMenuOpen(false);
                  ctx.openStoredPreview(ctx.activeSessionId(), f.id);
                }}
                class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                data-rc-tip={`${f.name} (${Math.round(f.size / 1024)}KB)`} aria-label={`${f.name} (${Math.round(f.size / 1024)}KB)`}
              >
                <FileIcon path={f.name} size={13} />
                <span class="truncate flex-1">{f.name}</span>
                <span class="text-[10px] text-ink-600 shrink-0">{Math.round(f.size / 1024)}K</span>
              </button>
            )}
          </For>
        </div>
    </FloatMenu>
  </div>
</Show>
</>
  );
}
