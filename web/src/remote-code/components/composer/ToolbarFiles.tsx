import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";
import { MenuItem } from "../MenuItem";
import { FileIcon } from "../../presentation";

export function ToolbarFiles() {
  const c = useComposerCtx();
  const s = useSession();
  const m = useModal();
  const ui = useUI();
  return (
<>
{/* Session files (stored on the daemon) */}
<Show when={(m.sessionFiles()[s.activeSessionId()] || []).length > 0}>
  <div>
    <button
      ref={c.filesBtn}
      data-menubtn
      onClick={(e) => {
        e.stopPropagation();
        c.setFilesMenuOpen(!c.filesMenuOpen());
        c.setAddContextOpen(false);
        ui.setModelMenuOpen(false);
      }}
      class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 cursor-pointer"
      data-rc-tip="Session files" aria-label="Session files"
    >
      <Iconify icon="lucide:paperclip" size={13} />
      <span>{(m.sessionFiles()[s.activeSessionId()] || []).length}</span>
    </button>
    <FloatMenu anchor={() => c.filesBtn} open={c.filesMenuOpen()} placement="top-start" width="15rem">
        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
          Session files
        </div>
        <div class="max-h-48 overflow-y-auto [scrollbar-gutter:stable]">
          <For each={m.sessionFiles()[s.activeSessionId()] || []}>
            {(f) => (
              <MenuItem
                tip={`${f.name} (${Math.round(f.size / 1024)}KB)`}
                onClick={() => {
                  c.setFilesMenuOpen(false);
                  m.openStoredPreview(s.activeSessionId(), f.id);
                }}
              >
                <FileIcon path={f.name} size={13} />
                <span class="truncate flex-1">{f.name}</span>
                <span class="text-[10px] text-ink-600 shrink-0">{Math.round(f.size / 1024)}K</span>
              </MenuItem>
            )}
          </For>
        </div>
    </FloatMenu>
  </div>
</Show>
</>
  );
}
