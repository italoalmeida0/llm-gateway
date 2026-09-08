import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { copyWithToast } from "../../ui";
import { useHost, useModal } from "../ctx";
import { indirectInstallCommands } from "../install";

export function Onboarding() {
  const h = useHost();
  const m = useModal();
  m.setShowPairModal(false);
  return (
<>
<div class="flex-1 flex flex-col items-center justify-center p-6 bg-ink-950 text-center overflow-y-auto">
  <div class="max-w-xl w-full mx-auto space-y-6 my-auto py-8">

    {/* Title & Subtitle */}
    <div>
      <div class="flex flex-col items-center mb-10 justify-center min-w-0">
      <img
        src="/indirect-big-icon.svg"
        alt="Indirect"
        class="w-auto h-60 shrink-0 object-contain rounded"
      />
      <span class="font-mono mt-[-1rem] text-[2.5rem] font-semibold tracking-wider text-ink-100 uppercase truncate">
        INDIRECT
      </span>
      </div>
      <p class="text-sm text-ink-400 mt-2 max-w-md mx-auto leading-relaxed">
        Run autonomous coding agents directly on your machine. Sessions, files, and commands remain 100% local on your device while you control them from this interface.
      </p>
    </div>

    {/* Action: Connect / Pair */}
    <Show
      when={m.pairingData()}
      fallback={
        <div class="pt-2">
          <button
            onClick={m.generatePairingToken}
            disabled={m.pairingLoading()}
            class="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm transition-all shadow-lg shadow-brand-500/20 hover:shadow-brand-500/30 cursor-pointer disabled:opacity-50"
          >
            <Show
              when={!m.pairingLoading()}
              fallback={<Iconify icon="lucide:refresh-cw" size={18} class="animate-spin" />}
            >
              <Iconify icon="lucide:plus" size={18} />
            </Show>
            <span>Connect Indirect Code Host</span>
          </button>
        </div>
      }
    >
      {/* Pairing Card */}
      <div class="p-6 rounded-2xl bg-ink-900 border border-line text-left space-y-5 shadow-2xl">
        <div class="flex items-center justify-between pb-3 border-b border-line">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span class="text-xs font-semibold uppercase tracking-wider text-ink-200">
              Pairing Credentials Ready
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
                Linux e macOS
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
            Downloads the latest compatible build, pairs this host and keeps it running in the background (log: ~/.indirect-code/daemon.log).
          </p>
        </div>


        {/* Live Status */}
        <div class="p-4 rounded-xl bg-brand-500/5 border border-brand-500/20 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center text-brand-400 shrink-0">
            <Iconify icon="lucide:refresh-cw" size={16} class="animate-spin" />
          </div>
          <div class="text-xs">
            <p class="font-medium text-ink-200">Waiting for daemon connection...</p>
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
            onClick={m.generatePairingToken}
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
