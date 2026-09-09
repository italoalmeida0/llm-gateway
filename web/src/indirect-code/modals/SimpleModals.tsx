import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import { useModal } from "../ctx";
import { indirectInstallCommands } from "../install";

export { NewProjectModal } from "./NewProjectModal";

export function ChoiceModal() {
  const m = useModal();
  return (
<>
<Modal open={!!m.choiceState()} title={m.choiceState()?.title || "Choose"} onClose={() => m.choiceState()?.resolve(null)}>
  <p class="text-sm text-ink-400 whitespace-pre-line leading-relaxed">{m.choiceState()?.message}</p>
  <div class="mt-4 flex flex-col gap-2">
    <For each={m.choiceState()?.options || []}>{(opt) =>
      <button
        onClick={() => m.choiceState()?.resolve(opt.id)}
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
    <button onClick={() => m.choiceState()?.resolve(null)} class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer">Cancel</button>
  </div>
</Modal>
</>
  );
}

export function ConfirmModal() {
  const m = useModal();
  return (
<>
<Modal open={!!m.confirmState()} title={m.confirmState()?.title || "Confirm"}
  onClose={() => { m.confirmState()?.resolve(false); m.setConfirmState(null); }}
  footer={<>
    <Btn variant="ghost" onClick={() => { m.confirmState()?.resolve(false); m.setConfirmState(null); }}>{m.confirmState()?.cancelText || "Cancel"}</Btn>
    <Btn variant={m.confirmState()?.danger ? "danger" : "primary"} onClick={() => { m.confirmState()?.resolve(true); m.setConfirmState(null); }}>{m.confirmState()?.confirmText || "Confirm"}</Btn>
  </>}>
  <p class="text-sm text-ink-400 whitespace-pre-line leading-relaxed">{m.confirmState()?.message}</p>
</Modal>
</>
  );
}

export function PairModal() {
  const m = useModal();
  return (
<>
<Modal
  open={m.showPairModal()}
  title="Pair Indirect Code Host"
  onClose={() => m.setShowPairModal(false)}
>
    <div class="space-y-4 text-xs">
      <p class="text-ink-400">
        Run the following command on your target machine to pair it with your
        LLM Gateway account:
      </p>

      <Show when={m.pairingData()}>
        {(p) => {
          const cmds = () => indirectInstallCommands(p().connectUrl);
          return (
            <div class="space-y-3">
              <div class="grid grid-cols-2 gap-2">
                <button
                  onClick={() => copyWithToast(cmds().unix)}
                  class="flex items-center justify-between gap-2 p-3 rounded-xl bg-ink-950 border border-line hover:border-brand-500/40 transition-colors cursor-pointer group"
                >
                  <span class="text-[11px] text-ink-200 font-medium">Linux e macOS</span>
                  <Iconify icon="lucide:copy" size={14} class="text-ink-500 group-hover:text-brand-300" />
                </button>
                <button
                  onClick={() => copyWithToast(cmds().windows)}
                  class="flex items-center justify-between gap-2 p-3 rounded-xl bg-ink-950 border border-line hover:border-brand-500/40 transition-colors cursor-pointer group"
                >
                  <span class="text-[11px] text-ink-200 font-medium">Windows</span>
                  <Iconify icon="lucide:copy" size={14} class="text-ink-500 group-hover:text-brand-300" />
                </button>
              </div>

              <div class="p-3 rounded-xl bg-ink-900 border border-line/60 text-ink-400 space-y-1 text-[11px]">
                <div class="font-semibold text-ink-200">Quick steps:</div>
                <div>1. Copy the command for your system and run it once — it downloads the latest build, pairs and stays in background.</div>
                <div>2. The host connects and appears online immediately.</div>
                <div>3. Removing the host here shuts the background process down; if it was offline it exits on next reconnect (revoked token).</div>
              </div>
            </div>
          );
        }}
      </Show>

      <div class="flex justify-end pt-2">
        <button
          onClick={() => m.setShowPairModal(false)}
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
