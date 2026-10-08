import { For, Show } from "solid-js";
import type { FooterFact } from "../../utils/envelope";

/** Envelope facts (exit code, page range, …) as small chips under a tool body. */
export function ToolFooter(props: { facts: FooterFact[] }) {
  return (
    <Show when={props.facts.length}>
      <div class="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1" data-tool-footer>
        <For each={props.facts}>
          {(f) => (
            <span
              class={`rounded border px-1 py-px font-mono text-[10px] leading-tight tabular-nums ${
                f.tone === "fail"
                  ? "border-rose-500/40 text-rose-400"
                  : f.tone === "ok"
                    ? "border-emerald-500/40 text-emerald-400"
                    : "border-line/60 text-ink-500"
              }`}
            >
              {f.label}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
