import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { Tooltip } from "../../../ui";
import { compactTokens } from "../../context";
import { baseNameOf } from "../../transcript";
import type { RemoteCodeViewCtx } from "../../viewCtx";
import { FloatMenu } from "../FloatMenu";

export function ComposerFooter(ctx: RemoteCodeViewCtx) {
  return (
<>
<Show when={ctx.activeSessionId()}>
  <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-ink-500" data-composer-footer>
    <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={ctx.currentProject()?.path}><Iconify icon="lucide:folder" size={13} /><span class="truncate">{ctx.currentProject()?.name || baseNameOf(ctx.activeSession()?.cwd) || "Project"}</span></span>
    <FloatMenu anchor={() => ctx.contextBtn} open={ctx.usageOpen()} placement="top-end" width="19rem">
      <div class="p-1.5 text-xs">
        <div class="font-semibold text-ink-200 mb-3">Conversation context</div>
        <div class="text-lg font-medium text-ink-100 tabular-nums">{ctx.activeContext().label}</div>
        <p class="text-[11px] text-ink-500 mt-1 leading-relaxed">
          {ctx.activeContext().window > 0 ? `${compactTokens(ctx.activeContext().window)} tokens configured in the gateway.` : "Context limit not configured in the gateway."}
          {" "}Measured from the latest model request and its response.
        </p>
        <Show when={ctx.activeContext().percent !== null}>
          <div class="h-1.5 rounded-full bg-elev overflow-hidden mt-3" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, ctx.activeContext().percent ?? 0)}>
            <div class="h-full rounded-full bg-accent-500" style={{ width: `${Math.min(100, ctx.activeContext().percent ?? 0)}%` }} />
          </div>
        </Show>
        <div class="font-semibold text-ink-200 mb-2 mt-4 pt-3 border-t border-line">Session usage</div>
        <Show
          when={ctx.activeUsage()}
          fallback={
            <p class="text-ink-500 text-[11px]">
              No usage reported yet. Run the agent to see input / cache / output tokens here.
            </p>
          }
        >
          {(u) => (
            <div class="space-y-1.5 font-mono text-[11px]">
              <div class="flex justify-between"><span class="text-ink-500">Input</span><span class="text-ink-200">{u().inTok.toLocaleString()}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Cache</span><span class="text-ink-200">{u().cacheTok.toLocaleString()}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Output</span><span class="text-ink-200">{u().outTok.toLocaleString()}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Reasoning</span><span class="text-ink-200">{u().reasoningTok.toLocaleString()}</span></div>
              <Show when={u().costUsd > 0}>
                <div class="flex justify-between pt-1 border-t border-line/60"><span class="text-ink-500">Cost</span><span class="text-ink-200">${u().costUsd.toFixed(4)}</span></div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </FloatMenu>
    <Tooltip content="Conversation context and session usage">
      <button ref={ctx.contextBtn} data-menubtn aria-label={`Conversation context: ${ctx.activeContext().label}`} aria-expanded={ctx.usageOpen()}
        onClick={() => { const next = !ctx.usageOpen(); ctx.closeMenus(); ctx.setUsageOpen(next); }}
        class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-ink-400 hover:bg-elev hover:text-ink-200 cursor-pointer">
        <Iconify icon="lucide:chart-pie" size={12} /><span>{ctx.activeContext().label}</span>
      </button>
    </Tooltip>
  </div>
</Show>
</>
  );
}
