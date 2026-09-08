import { For, Show, createEffect, createSignal, on } from "solid-js";
import { Modal, Btn } from "../../ui";
import { FileIcon } from "../presentation";
import { DiffView } from "../components/CodeBlock";
import { useHost, useModal, useTranscriptCtx } from "../ctx";

/** Per-file open state for the Review modal. Keyed by file path so refreshes
 * keep what the user already opened instead of snapping everything shut (or
 * open). A new review id resets to all-collapsed. */
const [openFiles, setOpenFiles] = createSignal<Record<string, boolean>>({});
let openFilesForReview = "";

function isOpen(path: string) {
  return openFiles()[path] === true;
}
function toggleOpen(path: string) {
  setOpenFiles((prev) => ({ ...prev, [path]: !isOpen(path) }));
}
function setAllOpen(files: { path: string }[], open: boolean) {
  setOpenFiles(Object.fromEntries(files.map((f) => [f.path, open])));
}

export function ReviewModal() {
  const m = useModal();
  const t = useTranscriptCtx();
  const h = useHost();
  let scrollBox: HTMLDivElement | undefined;
  // Last scrollTop seen on the modal body (updated on every scroll event).
  // Live refreshes re-render the list; restoring from this value keeps the
  // user's position instead of snapping to top.
  let lastScrollTop = 0;
  let pendingRestore: number | null = null;

  function attachBody(el: HTMLDivElement | undefined) {
    scrollBox = el;
    if (el) {
      el.onscroll = () => { lastScrollTop = el.scrollTop; };
      if (pendingRestore !== null) {
        const top = pendingRestore;
        pendingRestore = null;
        queueMicrotask(() => { if (scrollBox) scrollBox.scrollTop = top; });
      }
    }
  }

  const files = () => m.taskReview()?.files || [];
  const reviewId = () => m.taskReview()?.id || "";

  // New change set: collapse all, forget stale paths, reset scroll.
  createEffect(
    on(reviewId, (id) => {
      if (id !== openFilesForReview) {
        openFilesForReview = id;
        setOpenFiles({});
        lastScrollTop = 0;
        if (scrollBox) scrollBox.scrollTop = 0;
        else pendingRestore = 0;
      }
    }),
  );

  // Same review id, file list changed (live refresh): prune vanished paths
  // but keep the user's open choices for the rest, and restore the scroll
  // position captured by the body onscroll handler.
  createEffect(
    on(files, (list) => {
      const top = lastScrollTop;
      const paths = new Set(list.map((f) => f.path));
      setOpenFiles((prev) => {
        let changed = false;
        const next: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (paths.has(k)) next[k] = v;
          else changed = true;
        }
        return changed ? next : prev;
      });
      if (scrollBox && m.reviewOpen()) {
        pendingRestore = top;
        queueMicrotask(() => {
          if (scrollBox && pendingRestore !== null) {
            scrollBox.scrollTop = pendingRestore;
            pendingRestore = null;
          }
        });
      }
    }),
  );

  const totalAdded = () => files().reduce((n, f) => n + (Number(f.added) || 0), 0);
  const totalRemoved = () => files().reduce((n, f) => n + (Number(f.removed) || 0), 0);
  const allOpen = () => files().length > 0 && files().every((f) => isOpen(f.path));

  function expandAll() {
    setAllOpen(files(), true);
  }
  function collapseAll() {
    lastScrollTop = 0;
    if (scrollBox) scrollBox.scrollTop = 0;
    else pendingRestore = 0;
    setAllOpen(files(), false);
  }

  return (
<>
<Modal open={m.reviewOpen()} onClose={() => m.setReviewOpen(false)} bodyRef={attachBody} title="Review changes" description="Pending changes accumulate across turns. Keep accepts them; Undo restores the captured originals while preserving later manual edits." width="max-w-5xl" fullOnMobile
  footer={<><Btn variant="ghost" onClick={() => m.setReviewOpen(false)}>Close</Btn><Btn variant="ghost" disabled={t.sessionStatus() === "running" || m.reviewLoading() || !m.taskReview()?.files.length || !h.wsOpen()} onClick={() => m.undoChanges()}>Undo all changes</Btn><Btn disabled={t.sessionStatus() === "running" || m.reviewLoading() || !m.taskReview()?.files.length || !h.wsOpen()} onClick={m.keepChanges}>Keep changes</Btn></>}>
  <Show when={t.sessionStatus() === "running"}><p class="mb-3 text-xs text-ink-500">Live preview · updates as tools finish. Keep and Undo are available when the turn stops.</p></Show>
  <Show when={m.taskReview()?.checkedAt && t.sessionStatus() !== "running"}><p class="mb-3 text-xs text-ink-500">Files checked after the turn. Their current state is shown below.</p></Show>
  <Show when={m.reviewError()}><div role="alert" class="mb-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-sm text-ink-200">{m.reviewError()}</div></Show>
  <Show when={m.taskReview()?.notice}><p class="mb-3 text-xs text-ink-500">{m.taskReview()?.notice}</p></Show>
  <Show when={!m.reviewLoading()} fallback={<p class="p-4 text-sm text-ink-500">Loading changes…</p>}>
    <Show when={files().length > 0}>
      <div class="mb-3 flex flex-wrap items-center gap-3 text-xs text-ink-400">
        <span class="font-medium text-ink-200">{files().length} file{files().length === 1 ? "" : "s"} changed</span>
        <span class="font-mono text-emerald-400">+{totalAdded()}</span><span class="font-mono text-rose-400">-{totalRemoved()}</span>
        <span class="flex-1" />
        <button onClick={expandAll} class="rounded-md border border-line px-2 py-1 hover:bg-elev text-ink-300 cursor-pointer">Expand all</button>
        <button onClick={collapseAll} disabled={!allOpen()} class="rounded-md border border-line px-2 py-1 hover:bg-elev text-ink-300 disabled:opacity-40 cursor-pointer">Collapse all</button>
      </div>
    </Show>
    <For each={files()} fallback={<p class="p-4 text-sm text-ink-500">No pending changes.</p>}>{(file) =>
      <div class="mb-3 rounded-xl border border-line overflow-hidden">
        <button onClick={() => toggleOpen(file.path)} aria-expanded={isOpen(file.path)} class="flex w-full flex-wrap items-center gap-2 px-4 py-3 bg-elev/50 text-xs text-ink-200 cursor-pointer text-left">
          <FileIcon path={file.path} /><span class="flex-1 min-w-0 break-all font-mono">{file.path}</span>
          <Show when={!file.binary && ((Number(file.added) || 0) > 0 || (Number(file.removed) || 0) > 0)}><span class="font-mono"><Show when={(Number(file.added) || 0) > 0}><span class="text-emerald-400">+{file.added}</span></Show><Show when={(Number(file.added) || 0) > 0 && (Number(file.removed) || 0) > 0}><span class="text-ink-600"> </span></Show><Show when={(Number(file.removed) || 0) > 0}><span class="text-rose-400">-{file.removed}</span></Show></span></Show>
          <span class="text-ink-500 capitalize">{file.kind}</span><Show when={file.state}><span class="rounded-md border border-line px-2 py-0.5 text-ink-400">{file.state === "exists" ? "On disk" : file.state === "deleted" ? "No longer on disk" : "Could not verify"}</span></Show>
          <span class="text-ink-500">{isOpen(file.path) ? "▾" : "▸"}</span>
        </button>
        <Show when={isOpen(file.path)}>
          <Show when={file.truncated}><p class="px-3 py-2 text-xs text-ink-500">Preview truncated. Undo uses the complete backup.</p></Show>
          <Show when={!file.binary} fallback={<p class="p-4 text-xs text-ink-500">Binary file changed.</p>}>
            <Show when={file.diff} fallback={<p class="p-4 text-xs text-ink-500">{file.kind === "created then deleted" ? "This file was created and removed. Nothing remains on disk." : file.kind === "restored to original" ? "This file is back to its original contents." : "No text changes (file metadata changed)."}</p>}><DiffView text={file.diff!} name={file.path} max={160} /></Show>
          </Show>
          <div class="flex justify-end border-t border-line px-3 py-2"><button disabled={file.canUndo === false || t.sessionStatus() === "running" || m.reviewLoading() || !h.wsOpen()} onClick={() => m.undoChanges(file.path)} class="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-40 cursor-pointer">Undo file</button></div>
        </Show>
      </div>
    }</For>
  </Show>
</Modal>

{/* Modal: File Preview (chatbot FilePreviewModal) */}
</>
  );
}
