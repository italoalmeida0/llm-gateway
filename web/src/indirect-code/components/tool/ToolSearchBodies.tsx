import { For, Show, createMemo, onCleanup } from "solid-js";
import { followTail } from "../../utils/scrollMemory";
import { Streamdown } from "streamdown-solid";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";
import { parseGlobList, parseInspectTree } from "../../utils/toolTrees";
import type { ToolPartProps } from "./toolUnitModel";

function flagBadge(flag: string) {
  if (!flag || flag === "•") return null;
  const color =
    flag === "M"
      ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
      : flag === "A"
        ? "bg-emerald-500/15 text-emerald-300"
        : flag === "D" || flag === "R"
          ? "bg-rose-500/15 text-rose-300"
          : "bg-ink-800 text-ink-300";
  return (
    <span class={`shrink-0 rounded px-1 py-px font-mono text-[10px] ${color}`}>{flag}</span>
  );
}

export function ToolSearchBodies(props: ToolPartProps) {
  const inspectTree = createMemo(() => {
    if (props.m.name() !== "inspect") return null;
    return parseInspectTree(props.m.terminal().output || props.u.result?.toolResult || "");
  });
  const globList = createMemo(() => {
    if (props.m.name() !== "glob") return null;
    return parseGlobList(props.u.result?.toolResult || "");
  });
  return (
<>
        <Show when={props.m.name() === "search"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Searching…" : null}</div>}
          >
            <div class="px-3 py-1.5 text-[11px] text-ink-500 font-mono">
              <span class="text-ink-300">/{String(props.m.args().pattern || "")}/</span>
              <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">regex</span>
              {props.m.args().path && String(props.m.args().path) !== "." ? <span class="ml-1.5">in {String(props.m.args().path)}</span> : null}
            </div>
            <CodeBlock follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={props.m.key()} />
          </Show>
        </Show>
        <Show when={props.m.name() === "inspect"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Listing…" : null}</div>}
          >
            <Show
              when={inspectTree()}
              fallback={
                <CodeBlock follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={props.m.key()} />
              }
            >
              {(t) => (
                <>
                  <div class="px-3 pt-2 pb-1 font-mono text-[11px] text-ink-500">
                    {t().scope && t().scope !== "./" ? t().scope : "workspace"} · {t().count} {t().count === 1 ? "entry" : "entries"}
                    {t().capped ? ` (capped at ${t().capped})` : ""}
                  </div>
                  <ul class="px-1.5 pb-1.5">
                    <For each={t().entries}>
                      {(e) => (
                        <li class="flex items-center gap-1.5 rounded-md px-1.5 py-[3px] hover:bg-ink-900/70 text-[12px]">
                          <span style={{ "padding-left": `${e.depth * 14}px` }} class="flex min-w-0 flex-1 items-center gap-1.5">
                            <Show
                              when={e.isDir}
                              fallback={<FileIcon path={e.name} size={13} />}
                            >
                              <Iconify icon="lucide:folder" size={13} class="shrink-0 text-ink-500" />
                            </Show>
                            <span class="truncate font-mono text-ink-200">
                              {e.name}
                              {e.isDir ? "/" : ""}
                            </span>
                          </span>
                          {flagBadge(e.flag)}
                          <Show when={e.flag === "•"}>
                            <span class="h-1 w-1 shrink-0 rounded-full bg-ink-600" />
                          </Show>
                          <Show when={e.size}>
                            <span class="shrink-0 font-mono text-[10.5px] text-ink-500">
                              {e.size}
                              {e.lines !== undefined ? ` · ${e.lines} lines` : ""}
                            </span>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "glob"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Finding files…" : null}</div>}
          >
            <Show
              when={globList()}
              fallback={
                <CodeBlock follow={() => props.m.open() && props.running} text={props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={props.m.key()} />
              }
            >
              {(g) => (
                <>
                  <Show
                    when={!g().none}
                    fallback={<div class="px-3 py-2 text-[11px] text-ink-600">No files matched the pattern.</div>}
                  >
                    <div class="px-3 pt-2 pb-1 font-mono text-[11px] text-ink-500">
                      {g().files.length} {g().files.length === 1 ? "file" : "files"}
                    </div>
                    <ul ref={(el) => onCleanup(followTail(el, () => props.m.open() && props.running))} class="px-1.5 pb-1.5 max-h-64 overflow-y-auto [scrollbar-gutter:stable]">
                      <For each={g().files}>
                        {(f) => (
                          <li class="flex items-center gap-1.5 rounded-md px-1.5 py-[3px] hover:bg-ink-900/70 text-[12px]">
                            <FileIcon path={f} size={13} />
                            <span class="truncate font-mono text-ink-200">{f}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <Show when={g().truncated}>
                      <p class="px-3 pb-2 text-[10px] text-ink-600">Truncated: showing first {g().files.length} matches — narrow the pattern</p>
                    </Show>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "search_web"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Searching the web…" : null}</div>}
          >
            <div class="px-3 pt-2 pb-1 text-[11px] text-ink-500">
              <span class="font-mono text-ink-300">“{String(props.m.args().query || props.m.webDetails()?.query || "")}”</span>
              <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">DuckDuckGo</span>
              <Show when={props.m.webDetails()?.cached}><span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">cached</span></Show>
            </div>
            <Show when={(props.m.webDetails()?.results || []).length > 0} fallback={
              <CodeBlock follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={`${props.m.key()}:results`} />
            }>
              <ol class="px-3 pb-2 space-y-1.5">
                <For each={(props.m.webDetails()?.results || []).slice(0, 10)}>{(r: any, i: () => number) =>
                  <li class="group rounded-lg border border-line/60 bg-elev/50 px-2.5 py-1.5 transition-colors hover:border-ink-500">
                    <a href={String(r.url || "")} target="_blank" rel="noreferrer"
                       class="flex items-baseline gap-1.5 text-[12px] leading-snug">
                      <span class="shrink-0 font-mono text-[10px] text-ink-600">{i() + 1}.</span>
                      <span class="font-medium text-ink-100 group-hover:text-accent-300 group-hover:underline line-clamp-1">{String(r.title || r.url || "")}</span>
                    </a>
                    <div class="mt-0.5 truncate font-mono text-[10px] text-ink-600">{String(r.url || "")}</div>
                    <Show when={r.snippet}><p class="mt-0.5 text-[11px] leading-snug text-ink-400 line-clamp-2">{String(r.snippet)}</p></Show>
                  </li>
                }</For>
              </ol>
              <Show when={(props.m.webDetails()?.results || []).length > 10}>
                <p class="px-3 pb-2 text-[10px] text-ink-600">+{(props.m.webDetails()?.results || []).length - 10} more matches</p>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "fetch_url"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Fetching {String(props.m.args().url || "URL")}{props.active ? "…" : ""}</div>}
          >
            <a href={String(props.m.fetchDetails()?.url || props.m.args().url || "")} target="_blank" rel="noreferrer"
               class="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-line/60 bg-elev/50 px-2.5 py-2 transition-colors hover:border-ink-500">
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-500/15 font-mono text-[11px] font-bold text-accent-300">
                {(props.m.fetchDetails()?.host || "?").slice(0, 1).toUpperCase()}
              </span>
              <span class="min-w-0">
                <span class="block truncate text-[12px] font-medium text-ink-100">{String(props.m.fetchDetails()?.title || props.m.fetchDetails()?.host || props.m.args().url || "Article")}</span>
                <span class="block truncate font-mono text-[10px] text-ink-500">{String(props.m.fetchDetails()?.host || "")}</span>
              </span>
              <Iconify icon="lucide:external-link" size={12} class="ml-auto shrink-0 text-ink-500" />
            </a>
            <Show when={props.m.fetchDetails()?.content} fallback={
              <div class="border-t border-line/50 mt-2">
                <CodeBlock follow={() => props.m.open() && props.running} text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language="markdown" scrollKey={`${props.m.key()}:content`} />
              </div>
            }>
              <div
                ref={(el) => {
                  restoreToolScroll(props.m.key(), el);
                  requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
                  onCleanup(followTail(el, () => props.m.open() && props.running));
                }}
                onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
                class="px-3 py-2 max-h-96 overflow-y-auto [scrollbar-gutter:stable] text-[12.5px] leading-relaxed text-ink-200 article-body"
              >
                <Streamdown>{String(props.m.fetchDetails()?.content || "")}</Streamdown>
              </div>
              <Show when={props.m.fetchDetails()?.truncated}>
                <p class="px-3 pb-1 text-[10px] text-ink-600">Truncated</p>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() !== "edit" && props.m.name() !== "read" && props.m.name() !== "write" && props.m.name() !== "python" && props.m.name() !== "search" && props.m.name() !== "inspect" && props.m.name() !== "glob" && props.m.name() !== "question" && props.m.name() !== "patch" && props.m.name() !== "search_web" && props.m.name() !== "fetch_url"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.m.name() === "question" ? "Waiting for your answers…" : props.ctx.pendingApproval()?.callId === props.u.call?.toolId ? "Waiting for approval…" : props.active ? "Running…" : null}</div>}
          >
            <pre
              ref={(el) => {
                restoreToolScroll(props.m.key(), el);
                requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
                onCleanup(followTail(el, () => props.m.open() && props.running));
              }}
              onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
              class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] max-h-56 whitespace-pre-wrap"
            >
              {props.m.name() === "bash" && props.u.result ? props.m.terminal().output || "No output" : props.u.result?.toolResult || props.m.prog() || ""}
            </pre>
          </Show>
        </Show>
</>
  );
}
