import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Btn, copyWithToast } from "../../ui";
import { useHost, useModal } from "../ctx";
import { indirectInstallCommands } from "../install";
import { IndirectBrand } from "./IndirectBrand";

export function Onboarding() {
  const h = useHost();
  const m = useModal();
  m.setShowPairModal(false);
  return (
<>
<div class="flex-1 min-h-0 flex flex-col items-center p-4 sm:p-6 bg-ink-950 text-center overflow-y-auto">
  <div class="max-w-xl w-full mx-auto space-y-6 my-auto py-8">

    {/* Title & Subtitle */}
    <div>
      <IndirectBrand />
      <p class="text-[13px] text-ink-400 mt-5 max-w-sm mx-auto leading-relaxed">
        Connect a machine to work with your coding agent from anywhere. Your projects and conversations stay on that host.
      </p>
    </div>

    {/* Action: Connect / Pair */}
    <Show
      when={m.pairingData()}
      fallback={
        <div class="pt-2">
          <Btn
            onClick={() => m.generatePairingToken({ silent: true })}
            disabled={m.pairingLoading()}
            class="gap-2"
          >
            <Show
              when={!m.pairingLoading()}
              fallback={<Iconify icon="lucide:refresh-cw" size={18} class="animate-spin" />}
            >
              <Iconify icon="lucide:plus" size={18} />
            </Show>
            <span>Connect a host</span>
          </Btn>
        </div>
      }
    >
      {/* Pairing Card */}
      <div class="ui-card p-4 text-left space-y-4">
        <div class="flex items-center justify-between pb-3 border-b border-line">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span class="text-xs font-semibold uppercase tracking-wider text-ink-200">
              Ready to connect
            </span>
          </div>
          <span class="text-[11px] font-mono text-ink-400">
            Valid for ~15m
          </span>
        </div>

        {/* Step 1: one-line install (auto OS/arch, background) */}
        <div class="space-y-2">
          <div class="text-xs font-medium text-ink-200">
            1. Copy the command for your system and run it once in a terminal:
          </div>
          <div class="grid grid-cols-2 gap-2">
            <button
              onClick={() =>
                copyWithToast(
                  indirectInstallCommands(m.pairingData()?.connectUrl || "").unix,
                )
              }
              class="flex items-center justify-between gap-2 p-3 rounded-xl bg-ink-950 border border-line hover:border-brand-500/40 transition-colors cursor-pointer group"
            >
              <span class="flex items-center gap-2 text-xs font-medium text-ink-200">
                <Iconify icon="lucide:terminal" size={14} class="text-brand-400" />
                Linux & macOS
              </span>
              <Iconify icon="lucide:copy" size={14} class="text-ink-500 group-hover:text-brand-300" />
            </button>
            <button
              onClick={() =>
                copyWithToast(
                  indirectInstallCommands(m.pairingData()?.connectUrl || "").windows,
                )
              }
              class="flex items-center justify-between gap-2 p-3 rounded-xl bg-ink-950 border border-line hover:border-brand-500/40 transition-colors cursor-pointer group"
            >
              <span class="flex items-center gap-2 text-xs font-medium text-ink-200">
                <Iconify icon="lucide:app-window" size={14} class="text-brand-400" />
                Windows
              </span>
              <Iconify icon="lucide:copy" size={14} class="text-ink-500 group-hover:text-brand-300" />
            </button>
          </div>
          <p class="text-[11px] text-ink-500 leading-relaxed">
            Installs Indirect Code, connects this host, and keeps it available in the background.
          </p>
        </div>


        {/* Live Status */}
        <div class="p-4 rounded-xl bg-brand-500/5 border border-brand-500/20 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center text-brand-400 shrink-0">
            <Iconify icon="lucide:refresh-cw" size={16} class="animate-spin" />
          </div>
          <div class="text-xs">
            <p class="font-medium text-ink-200">Waiting for your host…</p>
            <p class="text-ink-400 text-[11px] mt-0.5">
              Run the command above in your terminal. This screen will connect automatically.
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div class="flex items-center justify-end gap-2.5 pt-2 text-xs">
          <button
            onClick={h.loadHosts}
            class="px-3.5 py-1.5 rounded-lg border border-line text-ink-300 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer"
          >
            Check Connection
          </button>
          <button
            onClick={() => m.generatePairingToken({ silent: true })}
            class="px-3.5 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 transition-colors cursor-pointer"
          >
            Regenerate Token
          </button>
        </div>
      </div>
    </Show>
  </div>
</div>
</>
  );
}
