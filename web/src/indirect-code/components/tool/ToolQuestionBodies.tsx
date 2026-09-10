import { For, Show, createMemo } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { parseQuestionQA } from "../../utils/toolTrees";
import type { ToolPartProps } from "./toolUnitModel";

/** Read-only history of an answered (or pending) question call: every
 * question with its options, the chosen answers highlighted. The live
 * asking happens in QuestionModal; this is the collapsible record. */
export function ToolQuestionBodies(props: ToolPartProps) {
  const items = createMemo(() =>
    parseQuestionQA(props.m.args(), props.u.result?.toolResult || "", props.u.result?.toolDetails),
  );
  const answered = () => !!props.u.result;

  return (
    <Show when={props.m.name() === "question"}>
      <Show
        when={items().length > 0}
        fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Waiting for your answers…</div>}
      >
        <div class="px-3 py-2 space-y-3">
          <For each={items()}>
            {(q, i) => {
              const picked = (label: string) => q.answers.includes(label);
              const custom = () =>
                q.answers.filter((a) => !q.options.some((o) => o.label === a));
              return (
                <div>
                  <div class="flex items-center gap-1.5">
                    <span class="shrink-0 rounded bg-ink-800 px-1.5 py-px font-mono text-[10px] text-ink-400">
                      Q{i() + 1}
                    </span>
                    <Show when={q.header}>
                      <span class="truncate text-[12px] font-medium text-ink-200">{q.header}</span>
                    </Show>
                    <Show when={q.multiple}>
                      <span class="shrink-0 rounded bg-ink-800 px-1.5 py-px text-[10px] text-ink-400">
                        multi-select
                      </span>
                    </Show>
                  </div>
                  <Show when={q.question}>
                    <p class="mt-1 text-[12.5px] leading-snug text-ink-300">{q.question}</p>
                  </Show>
                  <Show when={q.options.length > 0 || custom().length > 0 || !answered()}>
                    <ul class="mt-1.5 space-y-1">
                      <For each={q.options}>
                        {(o) => (
                          <li
                            class={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[12px] leading-snug ${
                              answered() && picked(o.label)
                                ? "border-emerald-500/40 bg-emerald-500/10 text-ink-100"
                                : "border-line/50 text-ink-400"
                            }`}
                          >
                            <Iconify
                              icon={answered() && picked(o.label) ? "lucide:check-circle-2" : "lucide:circle"}
                              size={13}
                              class={`mt-0.5 shrink-0 ${answered() && picked(o.label) ? "text-emerald-400" : "text-ink-600"}`}
                            />
                            <span class="min-w-0">
                              <span class="block font-medium">{o.label}</span>
                              <Show when={o.description}>
                                <span class="block text-[11px] text-ink-500">{o.description}</span>
                              </Show>
                            </span>
                          </li>
                        )}
                      </For>
                      <For each={custom()}>
                        {(c) => (
                          <li class="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5 text-[12px] leading-snug text-ink-100">
                            <Iconify icon="lucide:pencil" size={13} class="mt-0.5 shrink-0 text-emerald-400" />
                            <span class="min-w-0">
                              <span class="block font-medium">{c}</span>
                              <span class="block text-[11px] text-ink-500">Custom answer</span>
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={!answered()}>
            <p class="text-[11px] text-ink-600">Waiting for your answers…</p>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
