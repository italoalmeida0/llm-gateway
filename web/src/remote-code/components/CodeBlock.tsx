import { createEffect, createSignal, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode } from "../utils/lang";

export { ShellCmd } from "./code/ShellCmd";
export { DiffView } from "./code/DiffView";

/**
 * Renders code/text with syntax highlighting (extension-detected or
 * auto-detected for extension-less content like diffs). The highlighted
 * HTML is re-computed reactively when text/language change via the
 * hl-loaded singleton — escaped <pre> until the lib arrives (same paint as
 * before, zero layout shift). innerHTML below only ever carries one of two
 * safe payloads: highlight.js-generated spans (built from escaped text) or
 * escapeHtml() output — never raw upstream strings.
 */
export function CodeBlock(props: {
  text: string;
  language?: string;
  bare?: boolean;
  maxH?: string;
}) {
  const [html, setHtml] = createSignal<string | null>(null);
  createEffect(() => {
    const text = props.text || "";
    const lang = props.language;
    setHtml(null);
    let cancelled = false;
    void highlightCode(text, lang).then((h) => {
      if (!cancelled) setHtml(h);
    }).catch(() => { if (!cancelled) setHtml(escapeHtml(text)); });
    onCleanup(() => {
      cancelled = true;
    });
  });
  return (
    <pre
      class={`px-3 py-2 text-[11px] text-ink-300 overflow-x-auto whitespace-pre-wrap ${
        props.maxH || "max-h-56"
      }`}
    >
      <Show
        when={html() !== null}
        // eslint-disable-next-line solid/no-innerhtml
        fallback={<code class="tok" innerHTML={escapeHtml(props.text || "")} />}
      >
        {/* eslint-disable-next-line solid/no-innerhtml */}
        <code class="tok" innerHTML={html() || ""} />
      </Show>
    </pre>
  );
}
