import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../utils/lang";

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
/**
 * Inline shell syntax highlight for tool headers (bash/run rows):
 * `$ command` with flags, strings, vars, pipes and comments tinted.
 * Sync + regex-based (no async hljs): headers render instantly and update
 * for free on every keystroke/signal change. Long commands clamp with
 * ellipsis (title attr keeps the full text).
 */
export function ShellCmd(props: { text: string; max?: number }) {
  const max = () => props.max ?? 90;
  const short = () => {
    const t = props.text || "";
    return t.length > max() ? t.slice(0, max()) + "…" : t;
  };
  // Tokenize: comments | strings | vars | operators | flags | numbers.
  const parts = () => {
    const src = short();
    const re = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$[A-Za-z_][A-Za-z0-9_]*|\$\{|\$\(|\$\d+)|(&&|\|\||\||;|>|>>|<|2>|&)|(^|\s)(-[A-Za-z][A-Za-z0-9-]*|--[A-Za-z0-9][A-Za-z0-9-]*)(?=\s|$)|\b(\d+(?:\.\d+)?)\b/g;
    const out: { t: string; c: string }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    // Safety: bail to plain text on pathological input.
    let guard = 0;
    while ((m = re.exec(src)) !== null && guard++ < 500) {
      if (m.index > last) out.push({ t: src.slice(last, m.index), c: "" });
      const [full, comment, str, vr, op, _pre, flag, num] = m;
      if (comment) out.push({ t: full, c: "text-ink-600 italic" });
      else if (str) out.push({ t: full, c: "text-emerald-300" });
      else if (vr) out.push({ t: full, c: "text-amber-300" });
      else if (op) out.push({ t: full, c: "text-rose-300" });
      else if (flag) out.push({ t: full, c: "text-sky-300" });
      else if (num) out.push({ t: full, c: "text-violet-300" });
      else out.push({ t: full, c: "" });
      last = m.index + full.length;
      if (full.length === 0) re.lastIndex++;
    }
    if (last < src.length) out.push({ t: src.slice(last), c: "" });
    return out;
  };
  return (
    <code title={props.text || ""} class="font-mono truncate min-w-0">
      <span class="text-ink-600 select-none">$ </span>
      <For each={parts()}>{(p) =>
        p.c ? <span class={p.c}>{p.t}</span> : <span>{p.t}</span>
      }</For>
    </code>
  );
}
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
