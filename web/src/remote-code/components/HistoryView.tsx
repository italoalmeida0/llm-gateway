import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { timeAgo } from "../utils/format";
import type { SessionSummary } from "../types";
import type { SearchHit } from "../viewTypes";

/** Conversation history view (extracted from TranscriptView without
 * visual changes — narrow props instead of the god-ctx). */
export interface HistoryViewProps {
  sessionFilter: () => string;
  setSessionFilter: (v: string) => void;
  queueDaemonSearch: (q: string) => void;
  searchResults: () => SearchHit[];
  setSearchResults: (v: SearchHit[]) => void;
  setHistoryView: (v: boolean) => void;
  selectSession: (id: string) => void;
  sessions: () => SessionSummary[];
  matchQuery: (s: SessionSummary) => boolean;
  sortedSessions: (list: SessionSummary[]) => SessionSummary[];
  isMobile: () => boolean;
}

export function HistoryView(props: HistoryViewProps) {
  return (
    <div class="flex-1 overflow-y-auto px-4 md:px-8 py-8">
      <div class="max-w-2xl mx-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-semibold text-ink-100">Conversation History</h2>
          <button
            onClick={() => props.setHistoryView(false)}
            class="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
            data-rc-tip="Back to chat" aria-label="Back to chat"
          >
            <Iconify icon="lucide:x" size={15} />
          </button>
        </div>
        <div class="relative mb-4">
          <Iconify icon="lucide:search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
          <input
            type="text"
            placeholder={
              props.isMobile()
                ? "Search conversations and messages..."
                : "Search conversations and messages... (Ctrl+K)"
            }
            class="w-full text-[13px] bg-ink-900 border border-line/70 rounded-xl pl-9 pr-3 py-2 text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            value={props.sessionFilter()}
            onInput={(e) => {
              props.setSessionFilter(e.currentTarget.value);
              props.queueDaemonSearch(e.currentTarget.value);
            }}
            ref={(el) => setTimeout(() => el?.focus(), 50)}
          />
        </div>
        {/* Daemon full-text hits (message content, host-local) */}
        <Show when={props.searchResults().length > 0}>
          <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
            Message matches
          </div>
          <div class="space-y-1 mb-4">
            <For each={props.searchResults()}>
              {(r) => (
                <button
                  onClick={() => {
                    props.setHistoryView(false);
                    props.setSearchResults([]);
                    props.selectSession(r.sessionId);
                  }}
                  class="w-full text-left px-3 py-2.5 rounded-xl border border-line/50 hover:bg-ink-900/70 transition-colors cursor-pointer"
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-[13px] text-ink-200 truncate font-medium">{r.title}</span>
                    <span class="text-[11px] text-ink-600 shrink-0">
                      {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}{timeAgo(r.updatedAt)}
                    </span>
                  </div>
                  <p class="text-[11px] text-ink-500 mt-1 line-clamp-2 leading-relaxed">{r.snippet}</p>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
          Conversations
        </div>
        <div class="space-y-1">
          <For
            each={props.sortedSessions(props.sessions().filter(props.matchQuery))}
            fallback={
              <p class="text-xs text-ink-600 py-6 text-center">No conversations found.</p>
            }
          >
            {(s) => (
              <button
                onClick={() => {
                  props.setHistoryView(false);
                  props.selectSession(s.id);
                }}
                class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-ink-900/70 transition-colors group cursor-pointer"
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-[13px] text-ink-200 truncate font-medium">{s.title}</span>
                  <span class="text-[11px] text-ink-600 shrink-0">{timeAgo(s.updatedAt)}</span>
                </div>
                <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-ink-500">
                  <Iconify icon="lucide:folder" size={11} />
                  <span class="truncate font-mono">{s.cwd}</span>
                </div>
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
