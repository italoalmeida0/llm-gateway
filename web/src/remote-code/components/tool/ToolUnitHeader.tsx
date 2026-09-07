import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { absoluteRemotePath } from "../../paths";
import type { ToolUnit } from "../../types";
import type { TranscriptRenderCtx } from "../TranscriptBlocks";
import { ShellCmd } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import type { useToolUnitModel } from "./toolUnitModel";

type ToolModel = ReturnType<typeof useToolUnitModel>;

export interface ToolPartProps {
  ctx: TranscriptRenderCtx;
  msgId: string;
  u: ToolUnit;
  m: ToolModel;
  running: boolean;
}

export function ToolUnitHeader(props: ToolPartProps) {
  return (
    <div
      onClick={() => props.ctx.toggleToolOpen(props.m.key())}
      class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
    >
      <Show
        when={!(props.running && !props.u.result)}
        fallback={
          <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
        }
      >
        <Iconify
          icon={props.m.sum().icon}
          size={14}
          class="shrink-0 text-ink-500"
        />
      </Show>
      <span class="text-ink-500 shrink-0">{props.m.sum().verb}</span>
      <span class="flex items-center gap-2 min-w-0 flex-1">
        <span class="inline-flex items-center gap-2 min-w-0" data-rc-tip={props.m.args().path ? absoluteRemotePath(String(props.m.args().path), props.ctx.activeSession()?.cwd || "", props.ctx.projects().find((p: { protected?: boolean }) => p.protected)?.path) : undefined}>
          <Show when={props.m.args().path}><FileIcon path={String(props.m.args().path)} /></Show>
          <Show when={props.m.name() === "bash" || props.m.name() === "python"} fallback={
            <span class="truncate text-ink-200 font-medium min-w-0">{props.m.sum().target}</span>
          }>
            <span class="truncate text-ink-200 min-w-0 text-[12.5px]"><ShellCmd text={props.m.bashHeaderCmd()} /></span>
          </Show>
        </span>
      </span>
      <Show when={props.m.sum().statAdd != null || props.m.sum().statDel != null}>
        <span class="font-mono text-[11px] shrink-0">
          <Show when={(props.m.sum().statAdd || 0) > 0}>
            <span class="text-emerald-400">+{props.m.sum().statAdd}</span>
          </Show>
          <Show when={(props.m.sum().statAdd || 0) > 0 && (props.m.sum().statDel || 0) > 0}>
            <span class="text-ink-600"> </span>
          </Show>
          <Show when={(props.m.sum().statDel || 0) > 0}>
            <span class="text-rose-400">-{props.m.sum().statDel}</span>
          </Show>
        </span>
      </Show>
      <Show when={props.m.sum().stat && props.m.sum().statAdd == null}>
        <span class="text-[11px] text-ink-600 shrink-0">{props.m.sum().stat}</span>
      </Show>
      <Show when={props.m.elapsed()}><span data-tool-duration class="text-[11px] text-ink-500 tabular-nums shrink-0">{props.m.elapsed()}</span></Show>
      <Iconify
        icon="lucide:chevron-down"
        size={12}
        class={`shrink-0 text-ink-600 transition-transform ${props.m.open() ? "rotate-180" : ""}`}
      />
    </div>
  );
}
