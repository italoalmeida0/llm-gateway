import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode } from "../utils/lang";

export { ShellCmd } from "./code/ShellCmd";
export { DiffView } from "./code/DiffView";

interface CodeRow {
  lineNum: string;
  code: string;
  html?: string;
}

function cleanNotice(text: string): string {
  return (text || "").replace(
    /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
    "",
  );
}

/**
 * Renders code/text with syntax highlighting. When the text carries line
 * numbers (e.g. read/write tools: "<number>:<content>"), the numbers are
 * isolated into a select-none gutter so they do not contaminate syntax
 * highlighting or clipboard copy.
 */
export function CodeBlock(props: {
  text: string;
  language?: string;
  bare?: boolean;
  maxH?: string;
}) {
  const [rows, setRows] = createSignal<CodeRow[] | null>(null);
  const [rawHtml, setRawHtml] = createSignal<string | null>(null);

  const clean = () => cleanNotice(props.text || "");
  const rawLines = () => clean().split("\n");
  const hasGutter = () => !props.bare && rawLines().some((l) => /^\d+:/.test(l));

  createEffect(() => {
    const text = clean();
    const lang = props.language;
    setRows(null);
    setRawHtml(null);
    let cancelled = false;

    if (!hasGutter()) {
      void highlightCode(text, lang)
        .then((h) => {
          if (!cancelled) setRawHtml(h);
        })
        .catch(() => {
          if (!cancelled) setRawHtml(escapeHtml(text));
        });
      return;
    }

    const lines = rawLines();
    const parsed: CodeRow[] = lines.map((line) => {
      const m = line.match(/^(\d+):(.*)$/);
      if (m) {
        return { lineNum: m[1], code: m[2] };
      }
      return { lineNum: "", code: line };
    });

    const cleanCode = parsed.map((p) => p.code).join("\n");
    void highlightCode(cleanCode, lang)
      .then((h) => {
        if (cancelled) return;
        const htmlLines = h.split("\n");
        setRows(
          parsed.map((p, i) => ({
            lineNum: p.lineNum,
            code: p.code,
            html: htmlLines[i] || escapeHtml(p.code),
          })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRows(
          parsed.map((p) => ({
            lineNum: p.lineNum,
            code: p.code,
            html: escapeHtml(p.code),
          })),
        );
      });

    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <div
      class={`font-mono text-[11px] text-ink-300 overflow-x-auto select-text ${
        props.maxH || "max-h-56"
      }`}
    >
      <Show
        when={hasGutter()}
        fallback={
          <pre class="px-3 py-2 whitespace-pre-wrap">
            <Show
              when={rawHtml() !== null}
              // eslint-disable-next-line solid/no-innerhtml
              fallback={<code class="tok" innerHTML={escapeHtml(clean())} />}
            >
              {/* eslint-disable-next-line solid/no-innerhtml */}
              <code class="tok" innerHTML={rawHtml() || ""} />
            </Show>
          </pre>
        }
      >
        <div class="py-1 min-w-full w-fit">
          <Show
            when={rows() !== null}
            fallback={
              <For each={rawLines()}>
                {(line) => {
                  const m = line.match(/^(\d+):(.*)$/);
                  const num = m ? m[1] : "";
                  const content = m ? m[2] : line;
                  return (
                    <div class="flex items-start px-2 py-0.5 leading-relaxed whitespace-pre hover:bg-surface/30">
                      <span class="select-none text-right font-mono text-[10px] text-ink-600/50 min-w-[2.25rem] shrink-0 pr-2 border-r border-line/25 mr-2">
                        {num}
                      </span>
                      {/* eslint-disable-next-line solid/no-innerhtml */}
                      <code class="tok flex-1" innerHTML={escapeHtml(content || " ")} />
                    </div>
                  );
                }}
              </For>
            }
          >
            <For each={rows()}>
              {(r) => (
                <div class="flex items-start px-2 py-0.5 leading-relaxed whitespace-pre hover:bg-surface/30">
                  <span class="select-none text-right font-mono text-[10px] text-ink-600/50 min-w-[2.25rem] shrink-0 pr-2 border-r border-line/25 mr-2">
                    {r.lineNum}
                  </span>
                  {/* eslint-disable-next-line solid/no-innerhtml */}
                  <code class="tok flex-1" innerHTML={r.html || " "} />
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
