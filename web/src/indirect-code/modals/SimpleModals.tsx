import { For, Show } from "solid-js";
import { Modal, Btn, Badge, ModalNotice } from "../../ui";
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
        <Btn variant="ghost" onClick={() => state()?.resolve(null)}>
          Cancel
        </Btn>
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
                class={`flex items-center justify-between gap-3 rounded-2xl border p-4 text-left transition-all cursor-pointer group ${
                  opt.primary
                    ? "border-accent-500 bg-accent-500/10 hover:bg-accent-500/20 shadow-sm"
                    : "border-line/80 bg-elev/40 hover:bg-elev/80 hover:border-line"
                }`}
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span
                      class={`text-xs sm:text-sm font-semibold ${
                        opt.primary ? "text-ink-50" : "text-ink-100"
                      }`}
                    >
                      {opt.label}
                    </span>
                    <Show when={opt.primary}>
                      <Badge tone="indigo">Recommended</Badge>
                    </Show>
                  </div>
                  <Show when={opt.hint}>
                    <p class="text-[11px] sm:text-xs text-ink-400 mt-0.5 leading-relaxed">
                      {opt.hint}
                    </p>
                  </Show>
                </div>
                <Iconify
                  icon="lucide:arrow-right"
                  size={15}
                  class={`shrink-0 transition-transform group-hover:translate-x-0.5 ${
                    opt.primary ? "text-brand-500" : "text-ink-500"
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
          <Badge tone="red">Irreversible</Badge>
        </Show>
      }
      footer={
        <>
          <Btn
            variant="ghost"
            onClick={() => {
              state()?.resolve(false);
              m.setConfirmState(null);
            }}
          >
            {state()?.cancelText || "Cancel"}
          </Btn>
          <Btn
            variant={state()?.danger ? "danger" : "primary"}
            onClick={() => {
              state()?.resolve(true);
              m.setConfirmState(null);
            }}
          >
            {state()?.confirmText || "Confirm"}
          </Btn>
        </>
      }
    >
      <div class="space-y-4">
        <ModalNotice
          tone={state()?.danger ? "danger" : "info"}
          title={state()?.danger ? "Caution" : undefined}
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
        <div class="flex items-center gap-1.5 text-xs text-ink-500">
          <Iconify icon="lucide:shield-check" size={14} class="text-brand-500" />
          <span>Encrypted relay channel</span>
        </div>
      }
      footer={
        <Btn onClick={() => m.setShowPairModal(false)}>
          Done
        </Btn>
      }
    >
      <div class="space-y-5 text-xs">
        <Show when={m.pairingData()}>
          {(p) => {
            const cmds = () => indirectInstallCommands(p().connectUrl);
            return (
              <div class="space-y-4">
                <div class="space-y-2">
                  <div class="text-xs font-semibold uppercase tracking-wider text-ink-300">
                    Pairing Commands
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => copyWithToast(cmds().unix)}
                      class="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-elev/50 border border-line/80 hover:border-brand-500/50 hover:bg-elev/80 transition-all cursor-pointer group text-left"
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
                      <div class="p-1.5 rounded-lg bg-ink-900 border border-line/60 group-hover:text-brand-400 transition-colors">
                        <Iconify icon="lucide:copy" size={14} />
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => copyWithToast(cmds().windows)}
                      class="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-elev/50 border border-line/80 hover:border-brand-500/50 hover:bg-elev/80 transition-all cursor-pointer group text-left"
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
                      <div class="p-1.5 rounded-lg bg-ink-900 border border-line/60 group-hover:text-brand-400 transition-colors">
                        <Iconify icon="lucide:copy" size={14} />
                      </div>
                    </button>
                  </div>
                </div>

                <div class="p-4 rounded-2xl bg-elev/30 border border-line/70 space-y-2.5">
                  <div class="text-xs font-semibold text-ink-200 flex items-center gap-2">
                    <Iconify icon="lucide:info" size={14} class="text-blue-400" />
                    <span>How pairing works</span>
                  </div>
                  <ol class="space-y-1.5 text-[11px] text-ink-400 leading-relaxed list-decimal list-inside">
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
