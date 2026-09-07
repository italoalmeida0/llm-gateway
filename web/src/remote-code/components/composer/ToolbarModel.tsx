import { Icon as Iconify } from "../../../components/icon";
import { formatEffort } from "../../utils/format";
import type { RemoteCodeViewCtx } from "../../viewCtx";
import { FloatMenu } from "../FloatMenu";

export function ToolbarModel(ctx: RemoteCodeViewCtx) {
  return (
<>
{/* Model picker (moved from the removed topbar) */}
<div>
  <button
    ref={ctx.modelBtn}
    data-menubtn
    onClick={(e) => {
      e.stopPropagation();
      ctx.setModelMenuOpen(!ctx.modelMenuOpen());
      ctx.setProjectMenuOpen(false);
      ctx.setAddContextOpen(false);
      ctx.setUsageOpen(false);
    }}
    class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium cursor-pointer"
    data-rc-tip="Switch model" aria-label="Switch model"
  >
    <span class="max-w-[120px] sm:max-w-[150px] truncate">{ctx.activeModel().split("/").pop() || "Select model"}</span>
    <span class="uppercase text-ink-500 shrink-0 text-[11px]">{formatEffort(ctx.effort())}</span>
    <Iconify icon="lucide:chevron-down" size={11} class="shrink-0" />
  </button>
  <FloatMenu anchor={() => ctx.modelBtn} open={ctx.modelMenuOpen()} placement="top-start" width="26rem">
    <div>{ctx.modelPickerBody()}</div>
  </FloatMenu>

</div>
</>
  );
}
