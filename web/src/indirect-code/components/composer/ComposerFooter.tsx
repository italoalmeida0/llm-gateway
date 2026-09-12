import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { Tooltip } from "../../../ui";
import { compactTokens } from "../../context";
import { baseNameOf, cacheHitPct, fmtUsd, usageCosts } from "../../transcript";
import { useComposerCtx, useSession, useTranscriptCtx, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";

export function ComposerFooter() {
  const c = useComposerCtx();
  const s = useSession();
  const t = useTranscriptCtx();
  const ui = useUI();
  return (
<>
<Show when={s.draftMode()}>
  <div class="mt-3 flex justify-center" data-draft-project>
    {/* Project picker — where the next conversation starts.
        Default: project of the newest conversation (daemon). */}
    <div>
      <button
        ref={s.projBtn}
        data-menubtn
        onClick={(e) => {
          e.stopPropagation();
          s.setProjectMenuOpen(!s.projectMenuOpen());
          ui.setModelMenuOpen(false);
          c.setAddContextOpen(false);
          ui.setUsageOpen(false);
        }}
        class="ui-button ui-button-outline ui-button-sm gap-2"
        data-rc-tip="Project" aria-label="Project"
      >
        <Iconify icon="lucide:folder" size={13} />
        <span class="max-w-[110px] truncate">
          {s.activeProject()?.name || "Select project"}
        </span>
        <Iconify icon="lucide:chevron-down" size={11} />
      </button>
      <FloatMenu anchor={() => s.projBtn} open={s.projectMenuOpen()} placement="bottom" width="18rem">
          <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
            Project
          </div>
          <div class="max-h-56 overflow-y-auto [scrollbar-gutter:stable]">
            <For
              each={s.projects()}
              fallback={
                <div class="px-2.5 py-2 text-[11px] text-ink-600">
                  No projects yet.
                </div>
              }
            >
              {(p) => (
                <button
                  onClick={() => {
                    s.pickProject(p.id);
                    s.setProjectMenuOpen(false);
                  }}
                  class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer ${
                    p.id === s.activeProject()?.id
                      ? "bg-ink-800 text-ink-100"
                      : "text-ink-300 hover:bg-ink-800/60"
                  }`}
                  data-rc-tip={p.path} aria-label={p.path}
                >
                  <span class="flex items-center gap-1.5 min-w-0">
                    <Iconify icon="lucide:folder" size={13} class="shrink-0 text-ink-500" />
                    <span class="truncate">{p.name}</span>
                  </span>
                  <Show when={p.id === s.activeProject()?.id}>
                    <Iconify icon="lucide:check" size={13} />
                  </Show>
                </button>
              )}
            </For>
          </div>
          <button
            onClick={() => {
              s.setProjectMenuOpen(false);
              s.openNewProjectModal();
            }}
            class="mt-1 w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-400 hover:bg-ink-800/60 hover:text-ink-200 flex items-center gap-2 cursor-pointer border-t border-line/60"
          >
            <Iconify icon="lucide:folder-plus" size={13} />
            <span>New project…</span>
          </button>
      </FloatMenu>
    </div>
  </div>
</Show>
<Show when={s.activeSessionId()}>
  <div class="mt-2 flex items-center justify-between gap-3 text-[11px] text-ink-500" data-composer-footer>
    <span class="flex items-center gap-1.5 min-w-0" data-rc-tip={s.currentProject()?.path}><Iconify icon="lucide:folder" size={13} /><span class="truncate">{s.currentProject()?.name || baseNameOf(s.activeSession()?.cwd) || "Project"}</span></span>
    <FloatMenu anchor={() => ui.contextBtn} open={ui.usageOpen()} placement="top-end" width="19rem">
      <div class="p-1.5 text-xs">
        <div class="font-semibold text-ink-200 mb-3">Conversation context</div>
        <div class="text-lg font-medium text-ink-100 tabular-nums">{c.activeContext().label}</div>
        <p class="text-[11px] text-ink-500 mt-1 leading-relaxed">
          {c.activeContext().window > 0 ? `${compactTokens(c.activeContext().window)} tokens configured in the gateway.` : "Context limit not configured in the gateway."}
          {" "}Measured from the latest model request and its response.
        </p>
        <Show when={c.activeContext().percent !== null}>
          <div class="h-1.5 rounded-full bg-elev overflow-hidden mt-3" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, c.activeContext().percent ?? 0)}>
            <div class="h-full rounded-full bg-accent-500" style={{ width: `${Math.min(100, c.activeContext().percent ?? 0)}%` }} />
          </div>
        </Show>
        <div class="font-semibold text-ink-200 mb-2 mt-4 pt-3 border-t border-line">Session usage</div>
        <Show
          when={t.activeUsage()}
          fallback={
            <p class="text-ink-500 text-[11px]">
              No usage reported yet. Run the agent to see input / cache / output tokens here.
            </p>
          }
        >
          {(u) => {
            const costs = usageCosts(u());
            const chip = (v: number | undefined) =>
              costs ? <span class="text-ink-600 ml-1.5">${fmtUsd(v || 0)}</span> : null;
            return (
            <div class="space-y-1.5 font-mono text-[11px]">
              <Show when={costs && costs.total > 0}>
                <div class="flex justify-between pb-1 border-b border-line/60"><span class="text-ink-500">Total</span><span class="text-ink-100">${fmtUsd(costs!.total)}</span></div>
              </Show>
              <div class="flex justify-between"><span class="text-ink-500">Input</span><span class="text-ink-200">{u().inTok.toLocaleString()}{chip(costs?.input)}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Cache{(() => { const p = cacheHitPct(u()); return p === null ? "" : ` (${p}%)`; })()}</span><span class="text-ink-200">{u().cacheTok.toLocaleString()}{chip(costs?.cache)}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Output</span><span class="text-ink-200">{u().outTok.toLocaleString()}{chip(costs?.output)}</span></div>
              <div class="flex justify-between"><span class="text-ink-500">Reasoning</span><span class="text-ink-200">{u().reasoningTok.toLocaleString()}{chip(costs?.reasoning)}</span></div>
            </div>
            );
          }}
        </Show>
      </div>
    </FloatMenu>
    <Tooltip content="Conversation context and session usage">
      <button ref={ui.contextBtn} data-menubtn aria-label={`Conversation context: ${c.activeContext().label}`} aria-expanded={ui.usageOpen()}
        onClick={() => { const next = !ui.usageOpen(); ui.closeMenus(); ui.setUsageOpen(next); }}
        class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-ink-400 hover:bg-elev hover:text-ink-200 cursor-pointer">
        <Iconify icon="lucide:chart-pie" size={12} /><span>{c.activeContext().label}</span>
      </button>
    </Tooltip>
  </div>
</Show>
</>
  );
}
