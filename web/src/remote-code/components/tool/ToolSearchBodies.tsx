import { For, Show } from "solid-js";
import { Streamdown } from "streamdown-solid";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock } from "../CodeBlock";
import { recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";
import type { ToolPartProps } from "./toolUnitModel";

export function ToolSearchBodies(props: ToolPartProps) {
  return (
<>
        <Show when={props.m.name() === "search"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Searching…</div>}
          >
            <div class="px-3 py-1.5 text-[11px] text-ink-500 font-mono">
              <span class="text-ink-300">/{String(props.m.args().pattern || "")}/</span>
              {props.m.args().isRegex ? <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">regex</span> : null}
              {props.m.args().path && String(props.m.args().path) !== "." ? <span class="ml-1.5">in {String(props.m.args().path)}</span> : null}
            </div>
            <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={props.m.key()} />
          </Show>
        </Show>
        <Show when={props.m.name() === "inspect"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Listing…</div>}
          >
            <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={props.m.key()} />
          </Show>
        </Show>
        <Show when={props.m.name() === "search_web"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Searching the web…</div>}
          >
            <div class="px-3 pt-2 pb-1 text-[11px] text-ink-500">
              <span class="font-mono text-ink-300">“{String(props.m.args().query || props.m.webDetails()?.query || "")}”</span>
              <span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">DuckDuckGo</span>
              <Show when={props.m.webDetails()?.cached}><span class="ml-1.5 rounded bg-ink-700/60 px-1 py-px text-[10px]">cached</span></Show>
            </div>
            <Show when={(props.m.webDetails()?.results || []).length > 0} fallback={
              <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language={undefined} scrollKey={`${props.m.key()}:results`} />
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
                <p class="px-3 pb-2 text-[10px] text-ink-600">+{(props.m.webDetails()?.results || []).length - 10} more in raw output below</p>
              </Show>
              <details class="border-t border-line/50">
                <summary class="px-3 py-1 text-[10px] text-ink-600 hover:text-ink-300 cursor-pointer select-none">Raw output</summary>
                <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || ""} language={undefined} scrollKey={`${props.m.key()}:raw`} />
              </details>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() === "fetch_url"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Fetching {String(props.m.args().url || "URL")}…</div>}
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
                <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || props.m.prog() || ""} language="markdown" scrollKey={`${props.m.key()}:content`} />
              </div>
            }>
              <div
                ref={(el) => {
                  restoreToolScroll(props.m.key(), el);
                  requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
                }}
                onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
                class="px-3 py-2 max-h-96 overflow-y-auto text-[12.5px] leading-relaxed text-ink-200 article-body"
              >
                <Streamdown>{String(props.m.fetchDetails()?.content || "")}</Streamdown>
              </div>
              <Show when={props.m.fetchDetails()?.truncated}>
                <p class="px-3 pb-1 text-[10px] text-ink-600">Truncated — full text in raw output below</p>
              </Show>
              <details class="border-t border-line/50">
                <summary class="px-3 py-1 text-[10px] text-ink-600 hover:text-ink-300 cursor-pointer select-none">Raw output</summary>
                <CodeBlock text={props.m.terminal().output || props.u.result?.toolResult || ""} language="markdown" scrollKey={`${props.m.key()}:raw`} />
              </details>
            </Show>
          </Show>
        </Show>
        <Show when={props.m.name() !== "edit" && props.m.name() !== "read" && props.m.name() !== "write" && props.m.name() !== "python" && props.m.name() !== "search" && props.m.name() !== "inspect" && props.m.name() !== "patch" && props.m.name() !== "search_web" && props.m.name() !== "fetch_url"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.m.name() === "question" ? "Waiting for your answers…" : props.ctx.pendingApproval()?.callId === props.u.call?.toolId ? "Waiting for approval…" : "Running…"}</div>}
          >
            <pre
              ref={(el) => {
                restoreToolScroll(props.m.key(), el);
                requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
              }}
              onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
              class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap"
            >
              {props.m.name() === "bash" && props.u.result ? props.m.terminal().output || "No output" : props.u.result?.toolResult || props.m.prog() || ""}
            </pre>
          </Show>
        </Show>
</>
  );
}
