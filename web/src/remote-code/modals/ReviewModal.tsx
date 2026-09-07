import { For, Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { FileIcon } from "../presentation";
import { DiffView } from "../components/CodeBlock";
import type { SimpleModalsCtx } from "./SimpleModals";

export function ReviewModal(ctx: SimpleModalsCtx) {
  return (
<>
<Modal open={ctx.reviewOpen()} onClose={() => ctx.setReviewOpen(false)} title="Review changes" description="Pending changes accumulate across turns. Keep accepts them; Undo restores the captured originals while preserving later manual edits." width="max-w-5xl" fullOnMobile
  footer={<><Btn variant="ghost" onClick={() => ctx.setReviewOpen(false)}>Close</Btn><Btn variant="ghost" disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.taskReview()?.files.length || !ctx.wsOpen()} onClick={() => ctx.undoChanges()}>Undo all changes</Btn><Btn disabled={ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.taskReview()?.files.length || !ctx.wsOpen()} onClick={ctx.keepChanges}>Keep changes</Btn></>}>
  <Show when={ctx.sessionStatus() === "running"}><p class="mb-3 text-xs text-ink-500">Live preview · updates as tools finish. Keep and Undo are available when the turn stops.</p></Show>
  <Show when={ctx.taskReview()?.checkedAt && ctx.sessionStatus() !== "running"}><p class="mb-3 text-xs text-ink-500">Files checked after the turn. Their current state is shown below.</p></Show>
  <Show when={ctx.reviewError()}><div role="alert" class="mb-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-sm text-ink-200">{ctx.reviewError()}</div></Show>
  <Show when={ctx.taskReview()?.notice}><p class="mb-3 text-xs text-ink-500">{ctx.taskReview()?.notice}</p></Show>
  <Show when={!ctx.reviewLoading()} fallback={<p class="p-4 text-sm text-ink-500">Loading changes…</p>}>
    <For each={ctx.taskReview()?.files || []} fallback={<p class="p-4 text-sm text-ink-500">No pending changes.</p>}>{(file) =>
      <details open class="mb-3 rounded-xl border border-line overflow-hidden">
        <summary class="flex flex-wrap items-center gap-2 px-4 py-3 bg-elev/50 text-xs text-ink-200 cursor-pointer"><FileIcon path={file.path} /><span class="flex-1 min-w-0 break-all font-mono">{file.path}</span><span class="text-ink-500 capitalize">{file.kind}</span><Show when={file.state}><span class="rounded-md border border-line px-2 py-0.5 text-ink-400">{file.state === "exists" ? "On disk" : file.state === "deleted" ? "No longer on disk" : "Could not verify"}</span></Show></summary>
        <Show when={file.truncated}><p class="px-3 py-2 text-xs text-ink-500">Preview truncated. Undo uses the complete backup.</p></Show>
        <Show when={!file.binary} fallback={<p class="p-4 text-xs text-ink-500">Binary file changed.</p>}>
          <Show when={file.diff} fallback={<p class="p-4 text-xs text-ink-500">{file.kind === "created then deleted" ? "This file was created and removed. Nothing remains on disk." : file.kind === "restored to original" ? "This file is back to its original contents." : "No text changes (file metadata changed)."}</p>}><DiffView text={file.diff!} name={file.path} max={160} /></Show>
        </Show>
        <div class="flex justify-end border-t border-line px-3 py-2"><button disabled={file.canUndo === false || ctx.sessionStatus() === "running" || ctx.reviewLoading() || !ctx.wsOpen()} onClick={() => ctx.undoChanges(file.path)} class="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-40 cursor-pointer">Undo file</button></div>
      </details>
    }</For>
  </Show>
</Modal>

{/* Modal: File Preview (chatbot FilePreviewModal) */}
</>
  );
}
