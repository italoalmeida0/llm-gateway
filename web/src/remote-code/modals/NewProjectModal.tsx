import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useSession } from "../ctx";

export function NewProjectModal() {
  const s = useSession();
  return (
<>
<Modal open={s.showNewProjectModal()} onClose={() => s.setShowNewProjectModal(false)} title="Select project folder" width="max-w-2xl" fullOnMobile>
  <form class="flex items-center gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); s.requestFolders(s.newProjectPath()); }}>
    <input aria-label="Folder path on host" class="flex-1 min-w-0 rounded-lg border border-line bg-elev px-3 py-2.5 text-sm font-mono text-ink-100 outline-none focus:border-ink-400" value={s.newProjectPath()} onInput={(e) => s.setNewProjectPath(e.currentTarget.value)} />
    <button type="submit" class="p-2 text-ink-400 hover:text-ink-100 cursor-pointer" aria-label="Navigate to folder"><Iconify icon="lucide:arrow-right" size={16} /></button>
    <Btn type="button" disabled={s.folderLoading() || !s.folderCurrent() || s.newProjectPath() !== s.folderCurrent()} onClick={s.createProject}>OK</Btn>
  </form>
  <Show when={s.folderError()}><div role="alert" class="mb-3 p-3 rounded-lg border border-brand-500/30 text-sm text-ink-200">{s.folderError()}</div></Show>
  <div role="group" aria-label="Host folders" class="h-[50vh] min-h-48 overflow-y-auto -mx-2 space-y-0.5 [scrollbar-gutter:stable]">
    <button disabled={s.folderLoading() || !s.folderParent() || s.folderParent() === s.folderCurrent()} onClick={() => s.requestFolders(s.folderParent())} class="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-300 hover:bg-elev disabled:opacity-40 cursor-pointer"><Iconify icon="lucide:arrow-up" size={17} /><span>..</span></button>
    <Show when={!s.folderLoading()} fallback={<p class="px-3 py-5 text-sm text-ink-500">Loading folders…</p>}>
      <For each={s.folderEntries()} fallback={<p class="px-3 py-5 text-sm text-ink-500">No subfolders. Select OK to use this folder.</p>}>{(folder) =>
        <button aria-label={`Open ${folder.name}`} onClick={() => s.requestFolders(folder.path)} class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-ink-300 hover:bg-elev focus-visible:bg-elev outline-none cursor-pointer"><Iconify icon="lucide:folder" size={18} /><span class="truncate">{folder.name}</span></button>
      }</For>
    </Show>
  </div>
</Modal>
</>
  );
}
