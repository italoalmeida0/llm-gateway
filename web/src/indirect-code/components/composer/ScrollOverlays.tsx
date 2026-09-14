import { createEffect, For, Show } from "solid-js";
import { FloatMenu } from "../FloatMenu";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useTranscriptCtx } from "../../ctx";

export function ScrollOverlays() {
  const c = useComposerCtx();
  const t = useTranscriptCtx();
  let slashList: HTMLDivElement | undefined;
  createEffect(() => {const index = c.slashIndex(); slashList?.querySelectorAll("button")[index]?.scrollIntoView({block:"nearest"});});
  return (
<>
{/* Floating pin-at-bottom (unlocks on any scroll gesture) */}
<Show when={!t.isAtBottom() && t.messages().length > 0}>
  <div class="flex justify-center pb-2">
    <button
      onClick={() => t.pinAtBottom()}
      class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-ink-900 border border-line/70 text-ink-300 shadow-lg hover:text-ink-100 cursor-pointer"
    >
      <Iconify icon="lucide:pin" size={13} />
      <span>Pin at bottom</span>
    </button>
  </div>
</Show>
{/* Slash Command Autocomplete Menu */}
<FloatMenu anchor={() => document.getElementById("rc-composer")} open={c.slashMatches().length > 0} placement="top-start" width="40rem">
  <div ref={slashList} class="p-1.5 max-h-60 overflow-y-auto">
    <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-500 tracking-wider">
      Slash Commands
    </div>
    <For each={c.slashMatches()}>
      {(sc, idx) => (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => c.pickSlash(sc.cmd)}
          class={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center justify-between transition-colors ${
            idx() === c.slashIndex()
              ? "bg-ink-100 text-ink-950"
              : "text-ink-200 hover:bg-ink-800"
          }`}
        >
          <div class="flex items-center gap-2 font-mono font-semibold">
            <span>{sc.cmd}</span>
            <span class="text-[11px] opacity-70">{sc.args}</span>
          </div>
          <span class="text-[11px] opacity-80">{sc.desc}</span>
        </button>
      )}
    </For>
  </div>
</FloatMenu>
</>
  );
}
