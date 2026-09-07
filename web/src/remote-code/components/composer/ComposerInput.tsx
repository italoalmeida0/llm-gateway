import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { FileIcon } from "../../presentation";

export function ComposerInput() {
  const c = useComposerCtx();
  const s = useSession();
  const m = useModal();
  const ui = useUI();
  return (
<>
{/* Attachment chips (chatbot-style) */}
<Show when={c.pendingAttachments().length > 0}>
  <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
    <For each={c.pendingAttachments()}>
      {(att) => (
        <div
          onClick={() => m.previewPending(att)}
          class="relative group flex items-center gap-1.5 bg-ink-950 rounded-lg border border-line/70 pl-1.5 pr-2 py-1 text-xs max-w-[180px] cursor-pointer hover:border-ink-500 transition-colors"
          data-rc-tip={`${att.name} (${Math.round(att.size / 1024)}KB) — click to preview`}
        >
          <Show
            when={att.loading}
            fallback={
              <Show
                when={att.objectUrl}
                fallback={<FileIcon path={att.name} size={20} />}
              >
                <img src={att.objectUrl} class="w-7 h-7 object-cover rounded shrink-0 border border-line/60" />
              </Show>
            }
          >
            <span class="w-5 h-5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
          </Show>
          <span class="truncate text-ink-300">{att.name}</span>
          <Show when={att.uploading}>
            <span class="w-3 dot-spin border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
          </Show>
          <button
            onClick={(e) => {
              e.stopPropagation();
              c.removePendingAttachment(att.key);
            }}
            class="absolute -top-1.5 -right-1.5 bg-ink-700 hover:bg-rose-500 rounded-full p-0.5 transition-colors shadow cursor-pointer"
            data-rc-tip="Remove" aria-label="Remove"
          >
            <Iconify icon="lucide:x" size={10} />
          </button>
        </div>
      )}
    </For>
  </div>
</Show>

{/* Input row: textarea occupies remaining width, clear button takes its own size */}
<div class="flex items-start">
  <textarea
    id="rc-composer"
    disabled={s.creatingSession()}
    rows={1}
    class="flex-1 min-w-0 bg-transparent text-base sm:text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none resize-none px-4 pt-3 pb-1 max-h-[160px] min-h-[48px] overflow-y-auto [scrollbar-gutter:stable]"
    placeholder={
      ui.isMobile() ? "Ask anything…" : s.activeSession()
        ? `Ask anything, @ to mention, / for actions`
        : `Start a conversation in ${s.activeProject()?.name || "project"}...`
    }
    value={c.inputPrompt()}
    onInput={(e) => {
      c.setInputPrompt(e.currentTarget.value);
      const el = e.currentTarget;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 160) + "px";
    }}
    onPaste={(e) => {
      const files: File[] = [];
      try {
        const items = e.clipboardData?.items;
        if (items) {
          for (const it of items) {
            if (it.kind === "file") {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }
        }
      } catch {}
      if (files.length > 0) {
        e.preventDefault();
        c.handleFiles(files);
      }
    }}
    onDragOver={(e) => e.preventDefault()}
    onDrop={(e) => {
      e.preventDefault();
      try {
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length > 0) c.handleFiles(files);
      } catch {}
    }}
    onKeyDown={(e) => {
      if (c.slashMatches().length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          c.setSlashIndex((prev) =>
            Math.min(prev + 1, c.slashMatches().length - 1),
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          c.setSlashIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          const pick = c.slashMatches()[c.slashIndex()];
          if (pick) c.pickSlash(pick.cmd);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        c.sendPrompt();
      }
    }}
  />
  <Show when={c.inputPrompt().length > 0}>
    <button
      onClick={() => c.setInputPrompt("")}
      class="shrink-0 mr-2.5 mt-2.5 p-1 rounded-md text-ink-600 hover:text-ink-300 hover:bg-ink-800 transition-colors cursor-pointer"
      data-rc-tip="Clear input" aria-label="Clear input"
    >
      <Iconify icon="lucide:x" size={13} />
    </button>
  </Show>
</div>
</>
  );
}
