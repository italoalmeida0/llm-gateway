import { Show } from "solid-js";
import { Modal, Btn, Badge } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import { CodeBlock } from "../components/CodeBlock";
import { copyWithToast } from "../../ui";
import { useModal } from "../ctx";

export function PreviewModal() {
  const m = useModal();
  const file = () => m.previewFile();

  return (
    <Modal
      open={!!file()}
      onClose={() => m.setPreviewFile(null)}
      title={file()?.name || "File Preview"}
      subtitle="Inspect source code, review estimated token size, or truncate content before sending to agent."
      width="max-w-3xl"
      fullOnMobile
      badge={
        <Show when={file()?.truncated}>
          <Badge tone="amber">truncated</Badge>
        </Show>
      }
      footerLeft={
        <Show when={file()?.text}>
          <div class="flex items-center gap-3 text-xs text-ink-400 flex-wrap">
            <span class="flex items-center gap-1 font-mono text-[11px] text-ink-300">
              <Iconify icon="lucide:file-text" size={13} class="text-ink-500" />
              {(file()?.text || "").split("\n").length.toLocaleString()} lines
            </span>
            <span class="text-ink-600">·</span>
            <span class="flex items-center gap-1 font-mono text-[11px] text-ink-300">
              <Iconify icon="lucide:hash" size={13} class="text-ink-500" />
              ~{Math.round((file()?.text || "").length / 4).toLocaleString()} tokens
            </span>
            <Show when={file()?.truncated && file()?.fullText}>
              <span class="text-amber-400 text-[10px]">
                (original: {(file()?.fullText || "").length.toLocaleString()} chars)
              </span>
            </Show>
          </div>
        </Show>
      }
      footer={
        <Btn variant="ghost" onClick={() => m.setPreviewFile(null)}>
          Close
        </Btn>
      }
    >
      <Show when={file()}>
        {(f) => (
          <div class="space-y-4">
            {/* Action Toolbar */}
            <div class="flex items-center justify-between gap-2 flex-wrap pb-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <Show when={f().truncated && f().fullText}>
                  <button
                    onClick={m.restorePreviewFile}
                    class="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl border bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:rotate-ccw" size={13} />
                    <span>Restore Full</span>
                  </button>
                </Show>
                <Show when={!f().dataUrl}>
                  <button
                    onClick={() => m.setShowTruncateInput(!m.showTruncateInput())}
                    class="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl border border-line bg-elev/50 text-ink-300 hover:text-ink-100 hover:border-ink-500 transition-colors cursor-pointer"
                    data-rc-tip="Truncate to reduce tokens"
                    aria-label="Truncate to reduce tokens"
                  >
                    <Iconify icon="lucide:scissors" size={13} />
                    <span>Truncate</span>
                  </button>
                </Show>
                <Show when={f().text}>
                  <button
                    onClick={() => {
                      copyWithToast(f().text || "");
                      m.setPreviewCopied(true);
                      setTimeout(() => m.setPreviewCopied(false), 1500);
                    }}
                    class="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl border border-line bg-elev/50 text-ink-300 hover:text-ink-100 hover:border-ink-500 transition-colors cursor-pointer"
                  >
                    <Iconify icon={m.previewCopied() ? "lucide:check" : "lucide:copy"} size={13} />
                    <span>{m.previewCopied() ? "Copied!" : "Copy Code"}</span>
                  </button>
                </Show>
                <Show when={f().dataB64}>
                  <button
                    onClick={m.downloadPreviewFile}
                    class="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl border border-line bg-elev/50 text-ink-300 hover:text-ink-100 hover:border-ink-500 transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:download" size={13} />
                    <span>Download</span>
                  </button>
                </Show>
              </div>

              <div class="text-[11px] font-mono text-ink-500 uppercase tracking-wider">
                {f().language || languageForPath(f().name)}
              </div>
            </div>

            {/* Truncate input card */}
            <Show when={m.showTruncateInput() && !f().dataUrl}>
              <div class="flex flex-wrap items-center gap-3 p-3.5 rounded-2xl bg-elev/40 border border-line/80">
                <div class="flex items-center gap-1.5 text-ink-400 text-xs">
                  <Iconify icon="lucide:scissors" size={14} class="text-ink-400" />
                  <span>Truncate to:</span>
                </div>
                <input
                  type="number"
                  min={100}
                  max={200000}
                  step={1000}
                  class="w-28 bg-ink-950 border border-line rounded-lg px-2.5 py-1 text-ink-100 text-xs font-mono focus:outline-none focus:border-accent-500"
                  value={m.truncateTokens() || 16000}
                  onInput={(e) => m.setTruncateTokens(parseInt(e.currentTarget.value) || 16000)}
                />
                <span class="text-xs text-ink-500">
                  tokens (~{(((m.truncateTokens() || 16000) * 4)).toLocaleString()} chars)
                </span>
                <div class="flex items-center gap-2 ml-auto">
                  <button
                    onClick={() => m.setShowTruncateInput(false)}
                    class="text-xs text-ink-400 hover:text-ink-100 px-2.5 py-1 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <Btn
                    size="sm"
                    onClick={() => {
                      m.truncatePreviewFile();
                      m.setShowTruncateInput(false);
                    }}
                  >
                    Apply
                  </Btn>
                </div>
              </div>
            </Show>

            {/* Code / Image Content Viewer */}
            <div class="max-h-[55vh] overflow-auto rounded-2xl border border-line/80 bg-ink-950 p-4">
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
                <div class="flex items-center justify-center p-4">
                  <img src={f().dataUrl} class="max-w-full rounded-xl object-contain shadow-lg" />
                </div>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
}
