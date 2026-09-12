import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../../utils/lang";
import { diffRows, type ParsedDiffLine } from "../../utils/diffLines";
import { recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";

/**
 * Renders a unified context diff (daemon edit results and turn-change
 * balloons). Diff marker lines (+/-) keep their red/green lane so
 * added/removed still jump out; the line BODY is syntax-highlighted per the
 * file extension. Line numbers come embedded ("<n>:[ +-]code") or are
 * derived from the @@ hunk headers of plain unified diffs; a truncate
 * control caps long diffs exactly like the file preview.
 */
export interface DiffRow {
  lineNum: string;
  marker: string;
  codeHtml: string;
  rawCode: string;
  kind: ParsedDiffLine["kind"];
}

/**
 * Renders a unified context diff (daemon edit results and turn-change
 * balloons). Diff marker lines (+/-) keep their red/green lane with an
 * isolated line-number gutter; the line BODY is syntax-highlighted per the
 * file extension without marker/number interference.
 */
export function DiffView(props: { text: string; max?: number; name?: string; scrollKey?: string }) {
  let containerRef: HTMLDivElement | null = null;
  const [expanded, setExpanded] = createSignal(false);
  const [rows, setRows] = createSignal<DiffRow[] | null>(null);
  const lines = () => diffRows(props.text || "");
  const max = () => props.max ?? 80;
  const shown = () => {
    const all = lines();
    return expanded() ? all : all.slice(0, max());
  };
  const hidden = () => Math.max(0, lines().length - shown().length);

  createEffect(() => {
    const currentLines = shown();
    const lang = languageForPath(props.name);
    let cancelled = false;

    void Promise.all(
      currentLines.map(async (p) => {
        let codeHtml: string;
        if (p.kind === "header" || p.kind === "ellipsis") {
          codeHtml = escapeHtml(p.code);
        } else {
          codeHtml = await highlightCode(p.code, lang);
        }
        return {
          lineNum: p.lineNum,
          marker: p.marker,
          codeHtml,
          rawCode: p.code,
          kind: p.kind,
        };
      }),
    ).then((result) => {
      if (!cancelled) {
        setRows(result);
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, containerRef));
      }
    }).catch(() => {
      if (!cancelled) {
        setRows(
          currentLines.map((p) => ({
            lineNum: p.lineNum,
            marker: p.marker,
            codeHtml: escapeHtml(p.code),
            rawCode: p.code,
            kind: p.kind,
          })),
        );
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, containerRef));
      }
    });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const hasGutter = () => shown().some((r) => r.lineNum !== "");

  return (
    <div
      ref={(el) => {
        containerRef = el;
        restoreToolScroll(props.scrollKey, el);
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, el));
      }}
      onScroll={(e) => recordToolScroll(props.scrollKey, e.currentTarget)}
      class="font-mono text-[11px] leading-relaxed overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] max-h-96 select-text"
    >
      <div class="min-w-full w-fit">
        <Show
          when={rows() !== null}
          fallback={
            <For each={shown()}>
              {(r) => (
                <div
                  class={`flex items-start px-2 py-0.5 whitespace-pre ${
                    r.kind === "add"
                      ? "bg-emerald-500/10 text-emerald-300"
                      : r.kind === "del"
                        ? "bg-rose-500/10 text-rose-300"
                        : r.kind === "header"
                          ? "text-ink-500 text-[10px]"
                          : r.kind === "ellipsis"
                            ? "text-ink-600/70"
                            : "text-ink-400"
                  }`}
                >
                  <Show when={hasGutter()}>
                    <span class="select-none text-right font-mono text-[10px] text-ink-600/50 min-w-[2.25rem] shrink-0 pr-2 border-r border-line/25 mr-2">
                      {r.lineNum || ""}
                    </span>
                  </Show>
                  <span
                    class={`select-none w-3.5 shrink-0 text-center font-bold ${
                      r.kind === "add"
                        ? "text-emerald-400"
                        : r.kind === "del"
                          ? "text-rose-400"
                          : "text-transparent"
                    }`}
                  >
                    {r.marker || " "}
                  </span>
                  {/* eslint-disable-next-line solid/no-innerhtml */}
                  <code class="tok flex-1" innerHTML={escapeHtml(r.code || " ")} />
                </div>
              )}
            </For>
          }
        >
          <For each={rows()}>
            {(r) => (
              <div
                class={`flex items-start px-2 py-0.5 whitespace-pre ${
                  r.kind === "add"
                    ? "bg-emerald-500/10"
                    : r.kind === "del"
                      ? "bg-rose-500/10"
                      : r.kind === "header"
                        ? "text-ink-500 text-[10px]"
                        : r.kind === "ellipsis"
                          ? "text-ink-600/70"
                          : "text-ink-400"
                }`}
              >
                <Show when={hasGutter()}>
                  <span class="select-none text-right font-mono text-[10px] text-ink-600/50 min-w-[2.25rem] shrink-0 pr-2 border-r border-line/25 mr-2">
                    {r.lineNum || ""}
                  </span>
                </Show>
                <span
                  class={`select-none w-3.5 shrink-0 text-center font-bold ${
                    r.kind === "add"
                      ? "text-emerald-400"
                      : r.kind === "del"
                        ? "text-rose-400"
                        : "text-transparent"
                  }`}
                >
                  {r.marker || " "}
                </span>
                {/* eslint-disable-next-line solid/no-innerhtml */}
                <code class="tok flex-1" innerHTML={r.codeHtml || " "} />
              </div>
            )}
          </For>
        </Show>
      </div>
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
