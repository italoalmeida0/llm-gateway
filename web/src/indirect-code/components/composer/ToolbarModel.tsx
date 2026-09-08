import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { formatEffort } from "../../utils/format";
import { useComposerCtx, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

export function ToolbarModel() {
  const c = useComposerCtx();
  const s = useSession();
  const ui = useUI();
  return (
<>
{/* Model picker (desktop toolbar only — on mobile it is in the + menu) */}
<Show when={!ui.isMobile()}>
<div>
  <button
    ref={c.modelBtn}
    data-menubtn
    onClick={(e) => {
      e.stopPropagation();
      ui.setModelMenuOpen(!ui.modelMenuOpen());
      s.setProjectMenuOpen(false);
      c.setAddContextOpen(false);
      ui.setUsageOpen(false);
    }}
    class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium cursor-pointer"
    data-rc-tip="Switch model" aria-label="Switch model"
  >
    <span class="max-w-[120px] sm:max-w-[150px] truncate">{c.activeModel().split("/").pop() || "Select model"}</span>
    <span class="uppercase text-ink-500 shrink-0 text-[11px]">{formatEffort(c.effort())}</span>
    <Iconify icon="lucide:chevron-down" size={11} class="shrink-0" />
  </button>
  <FloatMenu anchor={() => c.modelBtn} open={ui.modelMenuOpen()} placement="top-start" width="26rem">
    <div>{c.modelPickerBody()}</div>
  </FloatMenu>

</div>
</Show>
</>
  );
}
