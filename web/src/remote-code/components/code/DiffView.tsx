import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../../utils/lang";

/**
 * Renders a unified context diff (daemon edit results). Diff marker lines
 * (+/-) keep their red/green lane so added/removed still jump out; the line
 * BODY is syntax-highlighted per the file extension, and a truncate
 * control caps long diffs exactly like the file preview.
 */
export function DiffView(props: { text: string; max?: number; name?: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const [html, setHtml] = createSignal<string | null>(null);
  const lines = () => (props.text || "").split("\n");
  const max = () => props.max ?? 80;
  const shown = () => {
    const all = lines();
    return expanded() ? all : all.slice(0, max());
  };
  const shownText = () => shown().join("\n");
  const hidden = () => Math.max(0, lines().length - shown().length);
  createEffect(() => {
    const text = shownText();
    const lang = languageForPath(props.name);
    setHtml(null);
    let cancelled = false;
    void Promise.all(text.split("\n").map(async (line) => {
      const marker = /^[ +-]/.test(line) ? line[0] : "";
      return escapeHtml(marker) + await highlightCode(marker ? line.slice(1) : line, lang);
    })).then((rows) => { if (!cancelled) setHtml(rows.join("\n")); })
      .catch(() => { if (!cancelled) setHtml(escapeHtml(text)); });
    onCleanup(() => {
      cancelled = true;
    });
  });
  // Keep one token per line so lane classes line up with the highlighted
  // body (the hl spans are injected inside each lane row, never across;
  // same safe-payload rule as CodeBlock applies). Newline splitting is
  // correct: hljs emits no raw newlines inside its own tags, so each source
  // line maps 1:1 to one rendered row (verified for diff + typescript).
  const rows = () => (html() ?? "").split("\n");
  return (
    <div class="font-mono text-[11px] leading-relaxed overflow-x-auto">
      <Show
        when={html() !== null}
        fallback={
          <For each={shown()}>
            {(ln) => (
              // eslint-disable-next-line solid/no-innerhtml
              <div class="px-3 whitespace-pre text-ink-400" innerHTML={escapeHtml(ln || " ")} />
            )}
          </For>
        }
      >
        <For each={rows()}>
          {(row) => {
            const plain = row.replace(/<[^>]*>/g, "");
            const cls =
              plain.startsWith("+") && !plain.startsWith("+++")
                ? "bg-emerald-500/10"
                : plain.startsWith("-") && !plain.startsWith("---")
                  ? "bg-rose-500/10"
                  : "text-ink-600";
            return (
              <div class={`px-3 whitespace-pre ${cls}`}>
                {/* eslint-disable-next-line solid/no-innerhtml */}
                <code class="tok" innerHTML={row || " "} />
              </div>
            );
          }}
        </For>
      </Show>
      <Show when={hidden() > 0}>
        <button
          onClick={() => setExpanded(true)}
          class="px-3 py-1 text-[11px] text-ink-500 hover:text-ink-200 cursor-pointer"
        >
          +{hidden()} more lines
        </button>
      </Show>
    </div>
  );
}
