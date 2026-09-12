import { For, Show } from "solid-js";
import { Modal, ModalNotice } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import { useModal } from "../ctx";
import { indirectInstallCommands } from "../install";

export { NewProjectModal } from "./NewProjectModal";

export function ChoiceModal() {
  const m = useModal();
  const state = () => m.choiceState();

  return (
    <Modal
      open={!!state()}
      title={state()?.title || "Choose Option"}
      subtitle="Select one of the choices below to continue with this action."
      onClose={() => state()?.resolve(null)}
      footer={
        <button
          type="button"
          onClick={() => state()?.resolve(null)}
          class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
        >
          Cancel
        </button>
      }
    >
      <div class="space-y-4">
        <Show when={state()?.message}>
          <p class="text-xs sm:text-sm text-ink-300 whitespace-pre-line leading-relaxed">
            {state()?.message}
          </p>
        </Show>
        <div class="flex flex-col gap-2.5">
          <For each={state()?.options || []}>
            {(opt) => (
              <button
                type="button"
                onClick={() => state()?.resolve(opt.id)}
                class={`flex items-center justify-between gap-3 rounded-xl border p-3.5 text-left transition-all cursor-pointer group ${
                  opt.primary
                    ? "border-blue-500 bg-blue-600/10 hover:bg-blue-600/20 shadow-sm"
                    : "border-line bg-ink-950/60 hover:bg-ink-900 hover:border-ink-500"
                }`}
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class={`text-xs sm:text-sm font-semibold ${
                        opt.primary ? "text-ink-100" : "text-ink-200"
                      }`}
                    >
                      {opt.label}
                    </span>
                    <Show when={opt.primary}>
                      <span class="bg-blue-600 text-white text-[10px] font-medium px-2 py-0.5 rounded-full">
                        Recommended
                      </span>
                    </Show>
                  </div>
                  <Show when={opt.hint}>
                    <p class="text-xs text-ink-400 mt-0.5 leading-relaxed">
                      {opt.hint}
                    </p>
                  </Show>
                </div>
                <Iconify
                  icon="lucide:arrow-right"
                  size={15}
                  class={`shrink-0 transition-transform group-hover:translate-x-0.5 ${
                    opt.primary ? "text-blue-400" : "text-ink-500"
                  }`}
                />
              </button>
            )}
          </For>
        </div>
      </div>
    </Modal>
  );
}

export function ConfirmModal() {
  const m = useModal();
  const state = () => m.confirmState();

  return (
    <Modal
      open={!!state()}
      title={state()?.title || "Confirm action"}
      subtitle="Please review the notice below before confirming."
      onClose={() => {
        state()?.resolve(false);
        m.setConfirmState(null);
      }}
      footerLeft={
        <Show when={state()?.danger}>
          <div class="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-rose-500" />
            <span>Irreversible</span>
          </div>
        </Show>
      }
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              state()?.resolve(false);
              m.setConfirmState(null);
            }}
            class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
          >
            {state()?.cancelText || "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => {
              state()?.resolve(true);
              m.setConfirmState(null);
            }}
            class={`${
              state()?.danger
                ? "bg-rose-600 hover:bg-rose-500"
                : "bg-blue-600 hover:bg-blue-500"
            } text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer`}
          >
            {state()?.confirmText || "Confirm"}
          </button>
        </>
      }
    >
      <div class="space-y-4">
        <ModalNotice
          tone={state()?.danger ? "danger" : "info"}
          title={state()?.danger ? "Action Notice" : undefined}
        >
          <span class="whitespace-pre-line leading-relaxed">{state()?.message}</span>
        </ModalNotice>
      </div>
    </Modal>
  );
}

export function PairModal() {
  const m = useModal();
  return (
    <Modal
      open={m.showPairModal()}
      title="Pair Indirect Code Host"
      subtitle="Run a one-time terminal command on your target machine to connect its daemon with your account."
      width="max-w-xl"
      onClose={() => m.setShowPairModal(false)}
      footerLeft={
        <div class="flex items-center gap-1.5 text-xs text-ink-400">
          <Iconify icon="lucide:shield-check" size={14} class="text-blue-400" />
          <span>Encrypted relay channel</span>
        </div>
      }
      footer={
        <button
          type="button"
          onClick={() => m.setShowPairModal(false)}
          class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
        >
          Done
        </button>
      }
    >
      <div class="space-y-5 text-xs">
        <Show when={m.pairingData()}>
          {(p) => {
            const cmds = () => indirectInstallCommands(p().connectUrl);
            return (
              <div class="space-y-4">
                <div class="space-y-2">
                  <div class="text-xs font-semibold text-ink-100">
                    Pairing Commands
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => copyWithToast(cmds().unix)}
                      class="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-ink-950/70 border border-line hover:border-blue-500 transition-all cursor-pointer group text-left"
                    >
                      <div>
                        <div class="text-xs font-semibold text-ink-100 flex items-center gap-1.5">
                          <Iconify icon="lucide:terminal" size={13} class="text-ink-400" />
                          <span>Linux & macOS</span>
                        </div>
                        <div class="text-[11px] text-ink-500 mt-0.5 font-mono truncate max-w-[180px]">
                          curl -fsSL … | bash
                        </div>
                      </div>
                      <div class="p-1.5 rounded-lg bg-ink-900 border border-line group-hover:text-blue-400 transition-colors">
                        <Iconify icon="lucide:copy" size={14} />
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => copyWithToast(cmds().windows)}
                      class="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-ink-950/70 border border-line hover:border-blue-500 transition-all cursor-pointer group text-left"
                    >
                      <div>
                        <div class="text-xs font-semibold text-ink-100 flex items-center gap-1.5">
                          <Iconify icon="lucide:terminal" size={13} class="text-ink-400" />
                          <span>Windows PowerShell</span>
                        </div>
                        <div class="text-[11px] text-ink-500 mt-0.5 font-mono truncate max-w-[180px]">
                          irm … | iex
                        </div>
                      </div>
                      <div class="p-1.5 rounded-lg bg-ink-900 border border-line group-hover:text-blue-400 transition-colors">
                        <Iconify icon="lucide:copy" size={14} />
                      </div>
                    </button>
                  </div>
                </div>

                <div class="p-3.5 rounded-xl bg-ink-900/40 border border-line space-y-2">
                  <div class="text-xs font-semibold text-ink-200 flex items-center gap-2">
                    <Iconify icon="lucide:info" size={14} class="text-blue-400" />
                    <span>How pairing works</span>
                  </div>
                  <ol class="space-y-1 text-xs text-ink-400 leading-relaxed list-decimal list-inside">
                    <li>Copy the command for your OS and paste it into your host terminal.</li>
                    <li>The daemon binary downloads, authenticates via token, and runs in the background.</li>
                    <li>Your machine appears online instantly and is accessible across all browser sessions.</li>
                  </ol>
                </div>
              </div>
            );
          }}
        </Show>
      </div>
    </Modal>
  );
}
