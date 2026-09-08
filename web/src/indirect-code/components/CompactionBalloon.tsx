import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Streamdown } from "streamdown-solid";
import { FileIcon } from "../presentation";
import { baseNameOf } from "../transcript";
import { copyWithToast } from "../../ui";
import type { CompactionState } from "../types";

export interface CompactionBalloonProps {
  compaction?: CompactionState | null;
  summary?: string;
  isLegacy?: boolean;
}

export function CompactionBalloon(props: CompactionBalloonProps) {
  const [expanded, setExpanded] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const rawSummary = () => props.summary || props.compaction?.previousSummary || "";
  const cleanedSummary = () =>
    rawSummary()
      .replace(/^## Context Summary \(compacted\)\n\n/, "")
      .trim();

  const isSplitTurn = () =>
    cleanedSummary().includes("**Turn Context (split turn):**");

  const usage = () => props.compaction?.usage;
  const inTok = () =>
    usage()?.input_tokens ??
    (usage() as any)?.inTok ??
    (usage() as any)?.inputTokens ??
    0;
  const outTok = () =>
    usage()?.output_tokens ??
    (usage() as any)?.outTok ??
    (usage() as any)?.outputTokens ??
    0;
  const cacheTok = () =>
    (usage()?.cache_read_tokens ?? 0) +
    (usage()?.cache_write_tokens ?? 0) +
    ((usage() as any)?.cacheTok ?? 0);
  const reasoningTok = () =>
    usage()?.reasoning_tokens ??
    (usage() as any)?.reasoningTok ??
    (usage() as any)?.reasoningTokens ??
    0;
  const costUsd = () =>
    usage()?.cost_usd ??
    (usage() as any)?.costUsd ??
    (usage() as any)?.costUSD ??
    0;

  const hasUsage = () => inTok() > 0 || outTok() > 0;

  const readFiles = () => props.compaction?.readFiles || [];
  const modifiedFiles = () => props.compaction?.modifiedFiles || [];
  const hasFiles = () => readFiles().length > 0 || modifiedFiles().length > 0;

  const count = () => props.compaction?.count ?? 0;

  function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    const text = cleanedSummary();
    if (!text) return;
    copyWithToast(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div class="w-full flex justify-center my-3 select-text">
      <div class="w-full max-w-2xl rounded-xl border border-line/70 bg-card p-3 shadow-xs transition-all">
        {/* Header Bar */}
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setExpanded(!expanded())}
            class="flex items-center gap-2 cursor-pointer text-left group focus:outline-none"
          >
            <div class="flex items-center justify-center w-6 h-6 rounded-lg bg-elev border border-line text-ink-300 group-hover:text-ink-100 transition-colors">
              <Iconify icon="lucide:archive" size={13} />
            </div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-xs font-semibold text-ink-200 group-hover:text-ink-100 transition-colors">
                Context Compacted
              </span>
              <Show when={count() > 0}>
                <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-elev text-ink-400 border border-line/50">
                  #{count()}
                </span>
              </Show>
              <Show when={isSplitTurn()}>
                <span class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-accent-500/10 text-accent-400 border border-accent-500/20">
                  Split Turn
                </span>
              </Show>
            </div>
          </button>

          {/* Right Action & Metric Pills */}
          <div class="flex items-center gap-2">
            <Show when={hasUsage()}>
              <div
                class="hidden sm:flex items-center gap-1.5 text-[11px] font-mono text-ink-400 bg-elev/70 px-2 py-0.5 rounded-md border border-line/50"
                title="Tokens used to generate compaction summary"
              >
                <Iconify icon="lucide:cpu" size={11} class="text-ink-500" />
                <span>
                  {inTok().toLocaleString()} in · {outTok().toLocaleString()} out
                </span>
                <Show when={costUsd() > 0}>
                  <span class="text-ink-500">(${costUsd().toFixed(4)})</span>
                </Show>
              </div>
            </Show>

            <Show when={cleanedSummary()}>
              <button
                type="button"
                onClick={handleCopy}
                class="p-1 rounded-md text-ink-400 hover:text-ink-200 hover:bg-elev transition-colors cursor-pointer"
                title="Copy compaction summary"
                aria-label="Copy compaction summary"
              >
                <Iconify icon={copied() ? "lucide:check" : "lucide:copy"} size={13} />
              </button>
            </Show>

            <button
              type="button"
              onClick={() => setExpanded(!expanded())}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-ink-400 hover:text-ink-200 hover:bg-elev transition-colors cursor-pointer"
            >
              <span>{expanded() ? "Hide" : "View"}</span>
              <Iconify
                icon={expanded() ? "lucide:chevron-up" : "lucide:chevron-down"}
                size={13}
              />
            </button>
          </div>
        </div>

        {/* Collapsed Snippet */}
        <Show when={!expanded() && cleanedSummary()}>
          <div
            onClick={() => setExpanded(true)}
            class="mt-2 text-[11px] text-ink-400 hover:text-ink-300 line-clamp-2 cursor-pointer select-none"
          >
            {cleanedSummary().replace(/\n+/g, " ")}
          </div>
        </Show>

        {/* Expanded Content View */}
        <Show when={expanded()}>
          <div class="mt-3 pt-3 border-t border-line/60 space-y-3">
            {/* File Operations Chips */}
            <Show when={hasFiles()}>
              <div class="space-y-2 text-[11px]">
                <Show when={modifiedFiles().length > 0}>
                  <div class="flex items-start gap-2">
                    <span class="text-ink-500 font-medium shrink-0 pt-0.5">Modified:</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={modifiedFiles()}>
                        {(file) => (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-elev border border-line/60 text-ink-300 font-mono text-[10px]">
                            <FileIcon path={file} size={11} />
                            <span>{baseNameOf(file)}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
                <Show when={readFiles().length > 0}>
                  <div class="flex items-start gap-2">
                    <span class="text-ink-500 font-medium shrink-0 pt-0.5">Read:</span>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={readFiles()}>
                        {(file) => (
                          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-elev border border-line/60 text-ink-300 font-mono text-[10px]">
                            <FileIcon path={file} size={11} />
                            <span>{baseNameOf(file)}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Token Usage Details Bar */}
            <Show when={hasUsage()}>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 p-2 rounded-lg bg-elev/60 border border-line/50 font-mono text-[11px] text-ink-400">
                <div>
                  <span class="text-ink-500 mr-1">Input:</span>
                  <span class="text-ink-200">{inTok().toLocaleString()}</span>
                </div>
                <Show when={cacheTok() > 0}>
                  <div>
                    <span class="text-ink-500 mr-1">Cache:</span>
                    <span class="text-ink-200">{cacheTok().toLocaleString()}</span>
                  </div>
                </Show>
                <div>
                  <span class="text-ink-500 mr-1">Output:</span>
                  <span class="text-ink-200">{outTok().toLocaleString()}</span>
                </div>
                <Show when={reasoningTok() > 0}>
                  <div>
                    <span class="text-ink-500 mr-1">Reasoning:</span>
                    <span class="text-ink-200">{reasoningTok().toLocaleString()}</span>
                  </div>
                </Show>
                <Show when={costUsd() > 0}>
                  <div class="border-l border-line/60 pl-3">
                    <span class="text-ink-500 mr-1">Cost:</span>
                    <span class="text-ink-200">${costUsd().toFixed(4)}</span>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Markdown Summary Content */}
            <Show
              when={cleanedSummary()}
              fallback={
                <div class="text-xs text-ink-500 italic">No summary text available.</div>
              }
            >
              <div class="rc-markdown text-xs max-h-96 overflow-y-auto px-1 py-0.5">
                <Streamdown class="text-xs">{cleanedSummary()}</Streamdown>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
