import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import type { SimpleModalsCtx } from "./SimpleModals";

export function NewProjectModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal open={ctx.showNewProjectModal()} onClose={() => ctx.setShowNewProjectModal(false)} title="Select project folder" width="max-w-2xl" fullOnMobile>
  <form class="flex items-center gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); ctx.requestFolders(ctx.newProjectPath()); }}>
    <input aria-label="Folder path on host" class="flex-1 min-w-0 rounded-lg border border-line bg-elev px-3 py-2.5 text-sm font-mono text-ink-100 outline-none focus:border-ink-400" value={ctx.newProjectPath()} onInput={(e) => ctx.setNewProjectPath(e.currentTarget.value)} />
    <button type="submit" class="p-2 text-ink-400 hover:text-ink-100 cursor-pointer" aria-label="Navigate to folder"><Iconify icon="lucide:arrow-right" size={16} /></button>
    <Btn type="button" disabled={ctx.folderLoading() || !ctx.folderCurrent() || ctx.newProjectPath() !== ctx.folderCurrent()} onClick={ctx.createProject}>OK</Btn>
  </form>
  <Show when={ctx.folderError()}><div role="alert" class="mb-3 p-3 rounded-lg border border-brand-500/30 text-sm text-ink-200">{ctx.folderError()}</div></Show>
  <div role="group" aria-label="Host folders" class="h-[50vh] min-h-48 overflow-y-auto -mx-2 space-y-0.5 [scrollbar-gutter:stable]">
    <button disabled={ctx.folderLoading() || !ctx.folderParent() || ctx.folderParent() === ctx.folderCurrent()} onClick={() => ctx.requestFolders(ctx.folderParent())} class="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-300 hover:bg-elev disabled:opacity-40 cursor-pointer"><Iconify icon="lucide:arrow-up" size={17} /><span>..</span></button>
    <Show when={!ctx.folderLoading()} fallback={<p class="px-3 py-5 text-sm text-ink-500">Loading folders…</p>}>
      <For each={ctx.folderEntries()} fallback={<p class="px-3 py-5 text-sm text-ink-500">No subfolders. Select OK to use this folder.</p>}>{(folder) =>
        <button aria-label={`Open ${folder.name}`} onClick={() => ctx.requestFolders(folder.path)} class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-ink-300 hover:bg-elev focus-visible:bg-elev outline-none cursor-pointer"><Iconify icon="lucide:folder" size={18} /><span class="truncate">{folder.name}</span></button>
      }</For>
    </Show>
  </div>
</Modal>
</>
  );
}
