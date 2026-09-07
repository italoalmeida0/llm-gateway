import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { REASONING_LEVELS } from "../constants";
import { formatEffort } from "../utils/format";
import type { GatewayModel } from "../context";

/** Session choices, also remembered by the daemon for the next draft.
 * (Extraído de RemoteCodePage.modelPickerBody verbatim — props estreitas
 * em vez do god-ctx; Fase 3 liga direto no ToolbarModel.) */
export function ModelPickerBody(props: {
  models: () => GatewayModel[];
  filtered: () => GatewayModel[];
  filter: () => string;
  setFilter: (v: string) => void;
  activeModelId: () => string;
  onPick: (id: string) => void;
  effort: () => string;
  onEffort: (lvl: string) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider flex items-center justify-between">
        <span>Model</span>
        <button
          onClick={props.onRefresh}
          class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
          data-rc-tip="Refresh models" aria-label="Refresh models"
        >
          <Iconify icon="lucide:refresh-cw" size={11} />
        </button>
      </div>
      <div class="px-2 pb-1">
        <input
          type="text"
          placeholder="Search models..."
          class="w-full bg-ink-950 border border-line/60 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
          value={props.filter()}
          onInput={(e) => props.setFilter(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          ref={(el) => setTimeout(() => el?.focus(), 40)}
        />
      </div>
      <div class="max-h-56 overflow-y-auto overflow-x-auto [scrollbar-gutter:stable]">
        <div class="min-w-full w-max flex flex-col">
          <For
            each={props.filtered()}
            fallback={
              <div class="px-2.5 py-2 text-[11px] text-ink-600 whitespace-nowrap">
                {props.models().length ? "No models match." : "No compatible models configured in the gateway."}
              </div>
            }
          >
            {(m) => (
              <button
                onClick={() => props.onPick(m.id)}
                class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-3 cursor-pointer ${
                  m.id === props.activeModelId()
                    ? "bg-ink-800 text-ink-100"
                    : "text-ink-300 hover:bg-ink-800/60"
                }`}
              >
                <span class="whitespace-nowrap">{m.name || m.id}</span>
                <Show when={m.id === props.activeModelId()}>
                  <Iconify icon="lucide:check" size={13} class="shrink-0" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="mt-1.5 pt-1.5 border-t border-line/60">
        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
          Reasoning effort
        </div>
        <div class="grid grid-cols-7 gap-1 p-1 rounded-lg bg-ink-950 border border-line/50">
          <For each={REASONING_LEVELS}>
            {(lvl) => (
              <button
                onClick={() => props.onEffort(lvl)}
                class={`py-1 rounded-md text-center text-[10px] sm:text-[11px] font-medium uppercase cursor-pointer ${
                  props.effort() === lvl
                    ? "bg-ink-100 text-ink-950"
                    : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {formatEffort(lvl)}
              </button>
            )}
          </For>
        </div>
      </div>

    </>
  );
}
