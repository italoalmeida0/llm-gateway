import { For, Show } from "solid-js";
import { Btn, Modal, ModalNotice } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useSession } from "../ctx";

export function NewProjectModal() {
  const s = useSession();

  const isCurrentValid = () =>
    !s.folderLoading() && !!s.folderCurrent() && s.newProjectPath() === s.folderCurrent();

  return (
    <Modal
      open={s.showNewProjectModal()}
      onClose={() => s.setShowNewProjectModal(false)}
      title="Select project folder"
      subtitle="Browse the host filesystem to choose or initialize a workspace for your agent sessions."
      width="max-w-2xl"
      footer={
        <>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => s.setShowNewProjectModal(false)}
          >
            Cancel
          </Btn>
          <Btn
            size="sm"
            disabled={!isCurrentValid()}
            onClick={s.createProject}
          >
            Open Project
          </Btn>
        </>
      }
    >
      <div class="space-y-4">
        {/* Navigation / Path input bar */}
        <form
          class="flex items-center gap-2 p-1.5 rounded-xl border border-line bg-ink-950/70 focus-within:border-brand-500 transition-all"
          onSubmit={(e) => {
            e.preventDefault();
            s.requestFolders(s.newProjectPath());
          }}
        >
          <div class="pl-2.5 text-ink-400 shrink-0">
            <Iconify icon="lucide:terminal" size={15} />
          </div>
          <input
            aria-label="Folder path on host"
            class="flex-1 min-w-0 bg-transparent px-2 py-1.5 text-xs sm:text-sm font-mono text-ink-100 placeholder:text-ink-500 outline-none"
            value={s.newProjectPath()}
            placeholder="/home/user/my-project"
            onInput={(e) => s.setNewProjectPath(e.currentTarget.value)}
          />
          <button
            type="submit"
            class="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-ink-800 transition-colors flex items-center gap-1 cursor-pointer shrink-0 border border-line/60"
            title="Navigate to path"
          >
            <span>Go</span>
            <Iconify icon="lucide:arrow-right" size={13} />
          </button>
        </form>

        <Show when={s.folderError()}>
          <ModalNotice tone="danger" title="Filesystem error">
            {s.folderError()}
          </ModalNotice>
        </Show>

        {/* Directory browser container */}
        <div class="rounded-xl border border-line bg-ink-950/60 overflow-hidden">
          <div class="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line bg-ink-900/50">
            <div class="flex items-center gap-2 text-xs font-medium text-ink-200 min-w-0 truncate">
              <Iconify icon="lucide:folder-tree" size={14} class="text-ink-400 shrink-0" />
              <span class="truncate font-mono text-xs">{s.folderCurrent() || "Host Root"}</span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Show when={!s.folderLoading() && s.folderEntries()}>
                <span class="text-[11px] text-ink-500 font-mono">
                  {s.folderEntries().length} folders
                </span>
              </Show>
              <button
                type="button"
                disabled={
                  s.folderLoading() ||
                  !s.folderParent() ||
                  s.folderParent() === s.folderCurrent()
                }
                onClick={() => s.requestFolders(s.folderParent())}
                class="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-ink-300 hover:text-ink-100 hover:bg-ink-800 border border-line/60 transition-colors disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                title="Go to parent directory"
              >
                <Iconify icon="lucide:arrow-up" size={13} />
                <span>Parent</span>
              </button>
            </div>
          </div>

          <div
            role="group"
            aria-label="Host folders"
            class="h-[45vh] sm:h-64 min-h-44 overflow-y-auto p-2 space-y-0.5 [scrollbar-gutter:stable]"
          >
            <Show
              when={!s.folderLoading()}
              fallback={
                <div class="flex items-center justify-center h-full text-xs text-ink-500 gap-2">
                  <Iconify icon="lucide:loader-2" size={16} class="animate-spin text-ink-400" />
                  <span>Scanning folders…</span>
                </div>
              }
            >
              <For
                each={s.folderEntries()}
                fallback={
                  <div class="flex flex-col items-center justify-center h-full py-8 text-center text-xs text-ink-500">
                    <Iconify icon="lucide:folder-open" size={24} class="text-ink-600 mb-2" />
                    <p>No subfolders found in this directory.</p>
                    <p class="text-[11px] text-ink-500 mt-0.5">Click "Open Project" below to select this folder.</p>
                  </div>
                }
              >
                {(folder) => (
                  <button
                    type="button"
                    aria-label={`Open ${folder.name}`}
                    onClick={() => s.requestFolders(folder.path)}
                    class="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-xs sm:text-sm text-ink-300 hover:text-ink-100 hover:bg-ink-900/80 focus-visible:bg-ink-900 outline-none transition-all cursor-pointer group"
                  >
                    <span class="flex items-center gap-2.5 min-w-0 truncate">
                      <Iconify
                        icon="lucide:folder"
                        size={15}
                        class="shrink-0 text-ink-500 group-hover:text-brand-400 transition-colors"
                      />
                      <span class="truncate font-mono text-xs">{folder.name}</span>
                    </span>
                    <Iconify
                      icon="lucide:chevron-right"
                      size={14}
                      class="shrink-0 text-ink-600 group-hover:text-ink-300 transition-transform group-hover:translate-x-0.5"
                    />
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Modal>
  );
}
