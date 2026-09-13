import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { FileIcon } from "../presentation";
import { tryParseArgs } from "../utils/tools";
import type { PendingApproval } from "../types";

/** Tool call approval card (extracted from TranscriptView without
 * visual changes — narrow props instead of the god-ctx). */
export interface ApprovalCardProps {
  pendingApproval: () => PendingApproval | null;
  convWidthClass: () => string;
  respondApproval: (approved: boolean, always?: boolean) => void;
  setYoloMode: (v: boolean) => void;
}

export function ApprovalCard(props: ApprovalCardProps) {
  return (
    <Show when={props.pendingApproval()}>
      {(pa) => {
        const args = tryParseArgs(pa().args);
        const name = pa().tool || "tool";
        return (
          <div class={`${props.convWidthClass()} mx-auto rounded-2xl p-4 shadow-xl`}>
            <div class="flex items-center gap-2 text-[13px]">
              <Iconify icon="lucide:shield" size={15} class="text-brand-500 shrink-0" />
              <span class="font-semibold text-ink-100">Review tool call</span>
              <span class="text-[11px] text-ink-500">Safe mode — nothing ran yet</span>
            </div>
            {/* Human summary per tool (never raw JSON) */}
            <div class="mt-2.5 rounded-xl border border-line/60 bg-ink-950/70 overflow-hidden">
              <Show when={name === "bash"}>
                <div class="px-3.5 py-2.5">
                  <div class="text-[11px] text-ink-500 mb-1">Run command</div>
                  <pre class="font-mono text-[13px] text-ink-100 whitespace-pre-wrap break-all">{String(args.command || "")}</pre>
                </div>
              </Show>
              <Show when={name === "read"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <FileIcon path={String(args.path || "")} size={14} />
                  <span class="text-ink-500">Read</span>
                  <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                  <Show when={args.limit || args.offset}>
                    <span class="font-mono text-[11px] text-ink-500 shrink-0">
                      L{Number(args.offset || 0) + 1}-{Number(args.offset || 0) + Number(args.limit || 0)}
                    </span>
                  </Show>
                </div>
              </Show>
              <Show when={name === "write"}>
                <div class="px-3.5 py-2.5 text-[13px]">
                  <div class="flex items-center gap-2">
                    <FileIcon path={String(args.path || "")} size={14} />
                    <span class="text-ink-500">Create</span>
                    <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                  </div>
                  <Show when={args.content}>
                    <pre class="mt-2 font-mono text-[11px] text-ink-400 whitespace-pre-wrap max-h-32 overflow-y-auto border-t border-line/50 pt-2">
                      {String(args.content).split("\n").slice(0, 12).join("\n")}
                      {String(args.content).split("\n").length > 12 ? "\n…" : ""}
                    </pre>
                  </Show>
                </div>
              </Show>
              <Show when={name === "edit"}>
                <div class="px-3.5 py-2.5 text-[13px]">
                  <div class="flex items-center gap-2">
                    <FileIcon path={String(args.path || "")} size={14} />
                    <span class="text-ink-500">Edit</span>
                    <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                    <Show when={Array.isArray(args.edits)}>
                      <span class="text-[11px] text-ink-500 shrink-0">
                        {args.edits.length} change{args.edits.length === 1 ? "" : "s"}
                      </span>
                    </Show>
                  </div>
                  <Show when={Array.isArray(args.edits) && args.edits.length > 0}>
                    <div class="mt-2 rounded-lg overflow-hidden border border-line/50 font-mono text-[11px]">
                      <For each={args.edits.slice(0, 2)}>
                        {(e: any) => (
                          <>
                            <div class="px-2.5 py-1 bg-rose-500/10 text-rose-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                              {(String(e.oldText || "").split("\n").slice(0, 6).join("\n"))}
                            </div>
                            <div class="px-2.5 py-1 bg-emerald-500/10 text-emerald-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                              {(String(e.newText || "").split("\n").slice(0, 6).join("\n"))}
                            </div>
                          </>
                        )}
                      </For>
                      <Show when={args.edits.length > 2}>
                        <div class="px-2.5 py-1 text-ink-600">+{args.edits.length - 2} more changes</div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={name === "glob"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:search" size={14} class="text-ink-400 shrink-0" />
                  <span class="text-ink-500">Search files</span>
                  <span class="font-mono text-ink-100 truncate">{String(args.pattern || "")}</span>
                </div>
              </Show>
              <Show when={name === "todo"}>
                <div class="px-3.5 py-2.5 text-xs"><p class="font-medium text-ink-200 mb-2">Update task plan</p><ul class="space-y-1 text-ink-400"><For each={args.items || []}>{(item) => <li class="flex gap-2"><span class="text-ink-500">{String(item.status).replaceAll("_", " ")}</span><span>{item.text}</span></li>}</For></ul></div>
              </Show>
              <Show when={!["bash", "read", "write", "edit", "glob", "todo"].includes(name)}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:wrench" size={14} class="text-ink-400 shrink-0" />
                  <span class="font-mono text-ink-100">{name}</span>
                </div>
              </Show>
              <details>
                <summary class="px-3.5 py-1.5 text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer select-none border-t border-line/50">
                  Details
                </summary>
                <pre class="px-3.5 pb-3 font-mono text-[11px] text-ink-500 overflow-x-auto whitespace-pre-wrap max-h-40">
                  {pa().args}
                </pre>
              </details>
            </div>
            <div class="mt-3 flex items-center justify-end gap-2">
              <button
                onClick={() => props.respondApproval(false)}
                class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer"
              >
                Reject
              </button>
              <button
                onClick={() => props.respondApproval(true)}
                class="px-4 py-1.5 rounded-xl bg-ink-100 text-ink-950 hover:bg-accent-400 text-xs font-semibold border border-transparent transition-colors cursor-pointer"
              >
                Allow once
              </button>
              <button
                onClick={() => {
                  props.setYoloMode(true);
                  props.respondApproval(true, true);
                }}
                class="px-3.5 py-1.5 rounded-xl border ui-button-brand text-xs font-semibold hover:brightness-105 active:translate-y-[1px] transition-all cursor-pointer"
                data-rc-tip="Enable Full access and allow all tool calls" aria-label="Always allow — enable Full access"
              >
                Always allow
              </button>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
