import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../../utils/lang";

/**
 * Renders a unified context diff (daemon edit results). Diff marker lines
 * (+/-) keep their red/green lane so added/removed still jump out; the line
 * BODY is syntax-highlighted per the file extension, and a truncate
 * control caps long diffs exactly like the file preview.
 */
export interface DiffRow {
  lineNum: string;
  marker: string;
  codeHtml: string;
  rawCode: string;
  kind: "add" | "del" | "context" | "header" | "ellipsis";
}

function cleanNotice(text: string): string {
  return (text || "").replace(
    /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
    "",
  );
}

export function parseDiffLine(line: string): {
  lineNum: string;
  marker: string;
  code: string;
  kind: "add" | "del" | "context" | "header" | "ellipsis";
} {
  if (line.startsWith("---") || line.startsWith("+++")) {
    return { lineNum: "", marker: "", code: line, kind: "header" };
  }
  if (line === "..." || line.startsWith("@@")) {
    return { lineNum: "", marker: "", code: line, kind: "ellipsis" };
  }
  const numMatch = line.match(/^(\d+):([ +-])?(.*)$/);
  if (numMatch) {
    const marker = numMatch[2] || "";
    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    return { lineNum: numMatch[1], marker, code: numMatch[3], kind };
  }
  const standardMatch = line.match(/^([ +-])(.*)$/);
  if (standardMatch) {
    const marker = standardMatch[1];
    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    return { lineNum: "", marker, code: standardMatch[2], kind };
  }
  return { lineNum: "", marker: "", code: line, kind: "context" };
}

/**
 * Renders a unified context diff (daemon edit results). Diff marker lines
 * (+/-) keep their red/green lane with an isolated line-number gutter;
 * the line BODY is syntax-highlighted per the file extension without marker/number
 * interference.
 */
export function DiffView(props: { text: string; max?: number; name?: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const [rows, setRows] = createSignal<DiffRow[] | null>(null);
  const lines = () =>
    cleanNotice(props.text || "")
      .split("\n")
      .filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  const max = () => props.max ?? 80;
  const shown = () => {
    const all = lines();
    return expanded() ? all : all.slice(0, max());
  };
  const hidden = () => Math.max(0, lines().length - shown().length);

  createEffect(() => {
    const currentLines = shown();
    const lang = languageForPath(props.name);
    setRows(null);
    let cancelled = false;

    const parsed = currentLines.map(parseDiffLine);
    void Promise.all(
      parsed.map(async (p) => {
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
      if (!cancelled) setRows(result);
    }).catch(() => {
      if (!cancelled) {
        setRows(
          parsed.map((p) => ({
            lineNum: p.lineNum,
            marker: p.marker,
            codeHtml: escapeHtml(p.code),
            rawCode: p.code,
            kind: p.kind,
          })),
        );
      }
    });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const hasGutter = () => shown().some((l) => /^\d+:/.test(l));

  return (
    <div class="font-mono text-[11px] leading-relaxed overflow-x-auto select-text">
      <div class="min-w-full w-fit">
        <Show
          when={rows() !== null}
          fallback={
            <For each={shown().map(parseDiffLine)}>
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
