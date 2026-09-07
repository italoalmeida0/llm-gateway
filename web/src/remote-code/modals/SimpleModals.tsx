import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import type { ChoiceOption, ConfirmState } from "../viewTypes";
import { FileIcon } from "../presentation";
import { DiffView } from "../components/CodeBlock";
import { copyWithToast } from "../../ui";
import type { Review } from "../viewTypes";

/** Props partilhadas dos modais simples (getters + ações vindos da página). */
export interface SimpleModalsCtx {
  showNewProjectModal: () => boolean;
  setShowNewProjectModal: (v: boolean) => void;
  newProjectPath: () => string;
  folderCurrent: () => string | null;
  folderParent: () => string;
  folderEntries: () => Array<{ name: string; path: string }>;
  createProject: () => void;
  setNewProjectPath: (v: string) => void;
  folderLoading: () => boolean;
  folderError: () => string | null;
  requestFolders: (path: string) => void;
  reviewOpen: () => boolean;
  setReviewOpen: (v: boolean) => void;
  reviewLoading: () => boolean;
  reviewError: () => string | null;
  taskReview: () => Review | null;
  sessionStatus: () => string;
  wsOpen: () => boolean;
  undoChanges: (path?: string) => Promise<void>;
  keepChanges: () => void;
  choiceState: () => { title: string; message: string; options: ChoiceOption[]; resolve: (id: string | null) => void } | null;
  confirmState: () => ConfirmState | null;
  setConfirmState: (v: null) => void;
  showPairModal: () => boolean;
  setShowPairModal: (v: boolean) => void;
  pairingData: () => { token: string; expiresAt: number; connectUrl: string } | null;
}

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

export function ReviewModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal open={ctx.reviewOpen()} onClose={() => ctx.setReviewOpen(false)} title="Review changes" description="Pending changes accumulate across turns. Keep accepts them; Undo restores the captured originals while preserving later manual edits." width="max-w-5xl" fullOnMobile
  footer={<><Btn variant="ghost" onClick={() => ctx.setReviewOpen(false)}>Close</Btn><Btn variant="ghost" disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.taskReview()?.files.length || !ctx.wsOpen()} onClick={() => ctx.undoChanges()}>Undo all changes</Btn><Btn disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.taskReview()?.files.length || !ctx.wsOpen()} onClick={ctx.keepChanges}>Keep changes</Btn></>}>
  <Show when={ctx.sessionStatus() === "running"}><p class="mb-3 text-xs text-ink-500">Live preview · updates as tools finish. Keep and Undo are available when the turn stops.</p></Show>
  <Show when={ctx.taskReview()?.checkedAt && ctx.sessionStatus() !== "running"}><p class="mb-3 text-xs text-ink-500">Files checked after the turn. Their current state is shown below.</p></Show>
  <Show when={ctx.reviewError()}><div role="alert" class="mb-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-sm text-ink-200">{ctx.reviewError()}</div></Show>
  <Show when={ctx.taskReview()?.notice}><p class="mb-3 text-xs text-ink-500">{ctx.taskReview()?.notice}</p></Show>
  <Show when={!ctx.reviewLoading()} fallback={<p class="p-4 text-sm text-ink-500">Loading changes…</p>}>
    <For each={ctx.taskReview()?.files || []} fallback={<p class="p-4 text-sm text-ink-500">No pending changes.</p>}>{(file) =>
      <details open class="mb-3 rounded-xl border border-line overflow-hidden">
        <summary class="flex flex-wrap items-center gap-2 px-4 py-3 bg-elev/50 text-xs text-ink-200 cursor-pointer"><FileIcon path={file.path} /><span class="flex-1 min-w-0 break-all font-mono">{file.path}</span><span class="text-ink-500 capitalize">{file.kind}</span><Show when={file.state}><span class="rounded-md border border-line px-2 py-0.5 text-ink-400">{file.state === "exists" ? "On disk" : file.state === "deleted" ? "No longer on disk" : "Could not verify"}</span></Show></summary>
        <Show when={file.truncated}><p class="px-3 py-2 text-xs text-ink-500">Preview truncated. Undo uses the complete backup.</p></Show>
        <Show when={!file.binary} fallback={<p class="p-4 text-xs text-ink-500">Binary file changed.</p>}>
          <Show when={file.diff} fallback={<p class="p-4 text-xs text-ink-500">{file.kind === "created then deleted" ? "This file was created and removed. Nothing remains on disk." : file.kind === "restored to original" ? "This file is back to its original contents." : "No text changes (file metadata changed)."}</p>}><DiffView text={file.diff!} name={file.path} max={160} /></Show>
        </Show>
        <div class="flex justify-end border-t border-line px-3 py-2"><button disabled={file.canUndo === false || ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.wsOpen()} onClick={() => ctx.undoChanges(file.path)} class="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-40 cursor-pointer">Undo file</button></div>
      </details>
    }</For>
  </Show>
</Modal>

{/* Modal: File Preview (chatbot FilePreviewModal) */}
</>
  );
}

export function ChoiceModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal open={!!ctx.choiceState()} title={ctx.choiceState()?.title || "Choose"} onClose={() => ctx.choiceState()?.resolve(null)}>
  <p class="text-sm text-ink-400 whitespace-pre-line leading-relaxed">{ctx.choiceState()?.message}</p>
  <div class="mt-4 flex flex-col gap-2">
    <For each={ctx.choiceState()?.options || []}>{(opt) =>
      <button
        onClick={() => ctx.choiceState()?.resolve(opt.id)}
        class={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors cursor-pointer ${opt.primary ? "border-accent-500/50 bg-accent-500/10 hover:bg-accent-500/20" : "border-line hover:bg-ink-800"}`}
      >
        <span>
          <span class={`block text-[13px] font-medium ${opt.primary ? "text-ink-50" : "text-ink-200"}`}>{opt.label}</span>
          <Show when={opt.hint}><span class="block text-[11px] text-ink-500">{opt.hint}</span></Show>
        </span>
        <Show when={opt.primary}><span class="rounded bg-accent-500/20 px-1.5 py-0.5 text-[10px] font-medium text-accent-300">default</span></Show>
      </button>
    }</For>
  </div>
  <div class="mt-3 flex items-center justify-end gap-2">
    <button onClick={() => ctx.choiceState()?.resolve(null)} class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer">Cancel</button>
  </div>
</Modal>
</>
  );
}

export function ConfirmModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal open={!!ctx.confirmState()} title={ctx.confirmState()?.title || "Confirm"}
  onClose={() => { ctx.confirmState()?.resolve(false); ctx.setConfirmState(null); }}
  footer={<>
    <Btn variant="ghost" onClick={() => { ctx.confirmState()?.resolve(false); ctx.setConfirmState(null); }}>{ctx.confirmState()?.cancelText || "Cancel"}</Btn>
    <Btn variant={ctx.confirmState()?.danger ? "danger" : "primary"} onClick={() => { ctx.confirmState()?.resolve(true); ctx.setConfirmState(null); }}>{ctx.confirmState()?.confirmText || "Confirm"}</Btn>
  </>}>
  <p class="text-sm text-ink-400 whitespace-pre-line leading-relaxed">{ctx.confirmState()?.message}</p>
</Modal>
</>
  );
}

export function PairModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal
  open={ctx.showPairModal()}
  title="Pair Remote Daemon Host"
  onClose={() => ctx.setShowPairModal(false)}
>
    <div class="space-y-4 text-xs">
      <p class="text-ink-400">
        Run the following command on your target machine to pair it with your
        LLM Gateway account:
      </p>

      <Show when={ctx.pairingData()}>
        {(p) => {
          const cmd = `./llmgw-daemon -connect "${p().connectUrl}"`;
          return (
            <div class="space-y-3">
              <div class="space-y-1">
                <div class="text-[11px] text-ink-300 font-medium">1. Run daemon with connection flag:</div>
                <div class="p-3 bg-ink-950 rounded-xl border border-line font-mono text-[11px] text-ink-200 flex items-center justify-between gap-2">
                  <span class="truncate">{cmd}</span>
                  <button
                    onClick={() => copyWithToast(cmd)}
                    class="p-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 shrink-0 cursor-pointer"
                    data-rc-tip="Copy command" aria-label="Copy command"
                  >
                    <Iconify icon="lucide:copy" size={14} />
                  </button>
                </div>
              </div>

              <div class="space-y-1">
                <div class="text-[11px] text-ink-300 font-medium">Or paste Connection URL when prompted:</div>
                <div class="p-2.5 bg-ink-950 rounded-xl border border-line font-mono text-[11px] text-ink-200 flex items-center justify-between gap-2">
                  <span class="truncate">{p().connectUrl}</span>
                  <button
                    onClick={() => copyWithToast(p().connectUrl)}
                    class="p-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 shrink-0 cursor-pointer"
                    data-rc-tip="Copy URL" aria-label="Copy URL"
                  >
                    <Iconify icon="lucide:copy" size={14} />
                  </button>
                </div>
              </div>

              <div class="p-3 rounded-xl bg-ink-900 border border-line/60 text-ink-400 space-y-1 text-[11px]">
                <div class="font-semibold text-ink-200">Quick steps:</div>
                <div>1. Run the command or paste the URL into your daemon.</div>
                <div>2. The daemon pairs with your account and obtains host credentials.</div>
                <div>3. The host connects via WebSocket and appears online immediately.</div>
              </div>
            </div>
          );
        }}
      </Show>

      <div class="flex justify-end pt-2">
        <button
          onClick={() => ctx.setShowPairModal(false)}
          class="px-4 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-accent-400 cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  </Modal>

{/* Modal: Settings (chatbot-style sections) */}
</>
  );
}
