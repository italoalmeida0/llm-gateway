import { Show } from "solid-js";
import { Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import { CodeBlock } from "../components/CodeBlock";
import { copyWithToast } from "../../ui";

export interface PreviewModalCtx {
  previewFile: () => import("../types").PreviewFile | null;
  setPreviewFile: (v: null) => void;
  previewCopied: () => boolean;
  setPreviewCopied: (v: boolean) => void;
  downloadPreviewFile: () => void;
  restorePreviewFile: () => void;
  truncatePreviewFile: () => void;
  showTruncateInput: () => boolean;
  setShowTruncateInput: (v: boolean) => void;
  truncateTokens: () => number;
  setTruncateTokens: (v: number) => void;
}

export function PreviewModal(ctx: PreviewModalCtx) {
  return (
<>
<Modal
  open={!!ctx.previewFile()}
  onClose={() => ctx.setPreviewFile(null)}
  title={ctx.previewFile()?.name || "File Preview"}
  width="max-w-3xl"
  fullOnMobile
>
  <Show when={ctx.previewFile()}>
    {(f) => (
      <div class="space-y-3">
        <Show when={f().truncated}>
          <span class="inline-flex text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
            truncated
          </span>
        </Show>
        {/* Toolbar */}
        <div class="flex items-center gap-1.5 flex-wrap">
          <Show when={f().truncated && f().fullText}>
            <button
              onClick={ctx.restorePreviewFile}
              class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 cursor-pointer"
            >
              <Iconify icon="lucide:rotate-ccw" size={13} />
              <span>Restore</span>
            </button>
          </Show>
          <Show when={!f().dataUrl}>
            <button
              onClick={() => ctx.setShowTruncateInput(!ctx.showTruncateInput())}
              class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
              data-rc-tip="Truncate to reduce tokens" aria-label="Truncate to reduce tokens"
            >
              <Iconify icon="lucide:scissors" size={13} />
              <span>Truncate</span>
            </button>
          </Show>
          <Show when={f().text}>
            <button
              onClick={() => {
                copyWithToast(f().text || "");
                ctx.setPreviewCopied(true);
                setTimeout(() => ctx.setPreviewCopied(false), 1500);
              }}
              class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
            >
              <Iconify icon={ctx.previewCopied() ? "lucide:check" : "lucide:copy"} size={13} />
              <span>{ctx.previewCopied() ? "Copied!" : "Copy all"}</span>
            </button>
          </Show>
          <Show when={f().dataB64}>
            <button
              onClick={ctx.downloadPreviewFile}
              class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
            >
              <Iconify icon="lucide:download" size={13} />
              <span>Download</span>
            </button>
          </Show>
        </div>
        {/* Truncate input */}
        <Show when={ctx.showTruncateInput() && !f().dataUrl}>
          <div class="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-ink-900/60 border border-line/60">
            <Iconify icon="lucide:scissors" size={14} class="text-ink-500" />
            <span class="text-xs text-ink-400">Truncate to</span>
            <input
              type="number"
              min={100}
              max={200000}
              step={1000}
              class="w-24 bg-ink-950 border border-line rounded-lg px-2 py-1 text-ink-100 text-xs focus:outline-none"
              value={ctx.truncateTokens() || 16000}
              onInput={(e) => ctx.setTruncateTokens(parseInt(e.currentTarget.value) || 16000)}
            />
            <span class="text-xs text-ink-500">tokens (~{(((ctx.truncateTokens() || 16000) * 4)).toLocaleString()} chars)</span>
            <div class="flex items-center gap-2 ml-auto">
              <button
                onClick={() => ctx.setShowTruncateInput(false)}
                class="text-xs text-ink-400 hover:text-ink-100 px-2 py-1 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  ctx.truncatePreviewFile();
                  ctx.setShowTruncateInput(false);
                }}
                class="px-3 py-1.5 text-xs font-medium bg-ink-100 text-ink-950 rounded-lg hover:bg-accent-400 cursor-pointer"
              >
                Apply
              </button>
            </div>
          </div>
        </Show>
        {/* Content */}
        <div class="max-h-[50vh] overflow-auto rounded-xl border border-line/60 bg-ink-950 p-3">
          <Show
            when={f().dataUrl}
            fallback={
              <CodeBlock
                text={f().text || "(empty)"}
                language={f().language || languageForPath(f().name)}
                bare
                maxH="max-h-none"
              />
            }
          >
            <div class="flex items-center justify-center">
              <img src={f().dataUrl} class="max-w-full rounded-lg object-contain" />
            </div>
          </Show>
        </div>
        {/* Footer stats */}
        <Show when={f().text}>
          <div class="flex items-center justify-between text-[11px] text-ink-500">
            <span>
              {(f().text || "").length.toLocaleString()} chars ·{" "}
              {(f().text || "").split("\n").length.toLocaleString()} lines
              <Show when={f().truncated && f().fullText}>
                <span class="text-amber-400"> (original: {(f().fullText || "").length.toLocaleString()} chars)</span>
              </Show>
            </span>
            <span class="flex items-center gap-1 font-mono">
              <Iconify icon="lucide:hash" size={11} />
              {Math.round((f().text || "").length / 4).toLocaleString()} tokens
            </span>
          </div>
        </Show>
      </div>
    )}
  </Show>
</Modal>
</>
  );
}
