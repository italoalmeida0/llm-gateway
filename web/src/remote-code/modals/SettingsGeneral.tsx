import { For } from "solid-js";
import { ThemeToggle } from "../../ui";
import { Icon as Iconify } from "../../components/icon";

import type { SettingsModalCtx } from "./SettingsModal";

export function SettingsGeneralSection(ctx: SettingsModalCtx) {
  return (
<>
<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:palette" size={15} class="text-ink-500" />
    <span>Appearance</span>

  </h3>
  <div class="space-y-3 text-xs">
    <div class="py-2 flex items-center justify-between gap-4">
      <div>
        <div class="font-semibold text-ink-200">Theme</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
          White or dark interface.
        </div>
      </div>
      <ThemeToggle />
    </div>
    <div class="py-2 flex items-center justify-between gap-4">
      <div>
        <div class="font-semibold text-ink-200">Verbose Agent Chat</div>
        <div class="text-[11px] text-ink-500 mt-0.5">
          Display intermediate thinking steps and tool calls.
        </div>
      </div>
      <button
        onClick={() => {
          const v = !ctx.verboseChat();
          ctx.setVerboseChat(v);
          try { localStorage.setItem("llmgw-rc-verbose", v ? "1" : "0"); } catch {}
        }}
        class={`w-10 h-5.5 rounded-full p-0.5 transition-colors shrink-0 cursor-pointer ${ctx.verboseChat() ? "bg-accent-500" : "bg-ink-700"}`}
        style={{ height: "22px" }}
        role="switch"
        aria-checked={ctx.verboseChat()}
        aria-label="Verbose agent chat"
      >
        <span
          class={`block w-4 h-4 rounded-full bg-accent-fg transition-transform ${ctx.verboseChat() ? "translate-x-[18px]" : "translate-x-0"}`}
          style={{ height: "16px", width: "16px" }}
        />
      </button>
    </div>
    <div class="py-2">
      <div class="font-semibold text-ink-200">Conversation Width</div>
      <div class="text-[11px] text-ink-500 mt-0.5 mb-2">
        Maximum width of the conversation panel.
      </div>
      <div class="grid grid-cols-3 gap-1 bg-ink-950 p-1 rounded-xl border border-line/60">
        <For each={[["narrow", "Narrow"], ["default", "Default"], ["wide", "Wide"]] as const}>
          {([v, label]) => (
            <button
              onClick={() => {
                ctx.setConvWidth(v);
                try { localStorage.setItem("llmgw-rc-width", v); } catch {}
              }}
              class={`py-1.5 rounded-lg text-center font-medium transition-colors cursor-pointer ${
                ctx.convWidth() === v
                  ? "bg-ink-800 text-ink-100"
                  : "text-ink-500 hover:text-ink-300"
              }`}
            >
              {label}
            </button>
          )}
        </For>
      </div>
    </div>
  </div>
</div>

<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:bot" size={15} class="text-ink-500" />
    <span>Agent</span>

  </h3>
  <div class="space-y-4 text-xs">
    <div class="space-y-2">
      <label class="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={ctx.daemonSettings().autoSwarmEnabled ?? false}
          onChange={(e) =>
            ctx.setDaemonSettings({
              ...ctx.daemonSettings(),
              autoSwarmEnabled: e.currentTarget.checked,
            })
          }
          class="rounded accent-brand-500"
        />
        <span class="text-ink-200 font-medium">
          Auto-Swarm (Allow agent to spawn parallel sub-agents)
        </span>
      </label>
    </div>
  </div>
</div>

<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:sliders-horizontal" size={15} class="text-ink-500" />
    <span>Advanced</span>
  </h3>
  <div class="space-y-4 text-xs">
    <div>
      <label class="block font-semibold text-ink-200 mb-1">
        Auto-compact threshold
      </label>
      <div class="grid grid-cols-6 gap-1 bg-ink-900 p-1 rounded-xl border border-line">
        <For each={[0, 70, 80, 85, 90, 95]}>
          {(v) => (
            <button
              onClick={() =>
                ctx.setDaemonSettings({ ...ctx.daemonSettings(), autoCompactPercent: v })
              }
              class={`py-1 rounded-lg text-center font-medium transition-colors cursor-pointer ${
                (ctx.daemonSettings().autoCompactPercent ?? 80) === v
                  ? "bg-ink-100 text-ink-950"
                  : "text-ink-400 hover:text-ink-200"
              }`}
            >
              {v === 0 ? "Off" : `${v}%`}
            </button>
          )}
        </For>
      </div>
      <p class="text-[11px] text-ink-500 mt-1">
        Compact the transcript automatically past this context usage.
      </p>
    </div>
  </div>
</div>

<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
    <Iconify icon="lucide:type" size={15} class="text-ink-500" />
    <span>Title Generator</span>
  </h3>
  <label class="flex items-start gap-2 cursor-pointer select-none text-xs">
    <input
      type="checkbox"
      checked={!(ctx.daemonSettings().noAutoTitle ?? false)}
      onChange={(e) =>
        ctx.setDaemonSettings({ ...ctx.daemonSettings(), noAutoTitle: !e.currentTarget.checked })
      }
      class="rounded accent-brand-500 mt-0.5"
    />
    <span>
      <span class="text-ink-200 font-medium">Auto-generate conversation titles</span>
      <span class="block text-[11px] text-ink-500 font-normal mt-0.5">
        The host asks the model for a short title after the first exchange. Off leaves "New conversation".
      </span>
    </span>
  </label>
</div>
</>
  );
}
