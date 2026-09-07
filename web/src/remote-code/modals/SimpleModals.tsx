import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import type { ChoiceOption, ConfirmState } from "../viewTypes";
import { copyWithToast } from "../../ui";
import type { Review } from "../viewTypes";

export { NewProjectModal } from "./NewProjectModal";
export { ReviewModal } from "./ReviewModal";

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
