import type { DaemonCommand } from "../daemon-protocol";
import { createSignal } from "solid-js";
import type { PreviewFile } from "../types";
import type { AttachmentDataEvent } from "../daemon-protocol";
import type { StoredAttachment } from "../viewTypes";

/** Review of changes + file preview + session attachments (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createReview(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  isSessionRunning: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm: (o: { title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }) => Promise<boolean>;
  isHostOnline: () => boolean;
}) {
  function resetReview() {
    // No-op now: per-turn file changes replaced the git review modal.
    // Kept so session-switch call sites don't change.
  }

  // Stored attachments per session (from session_data + uploads).
  const [sessionFiles, setSessionFiles] = createSignal<Record<string, StoredAttachment[]>>({});
  function noteSessionFiles(sid: string, atts: any[]) {
    if (Array.isArray(atts)) {
      setSessionFiles((prev) => ({
        ...prev,
        [sid]: atts.map((a: any) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          size: a.size || 0,
        })),
      }));
    }
  }
  function addSessionFile(sessionId: string, a: { id: string; name: string; mime: string; size?: number }) {
    setSessionFiles((prev) => {
      const list = prev[sessionId] || [];
      if (list.some((x) => x.id === a.id)) return prev;
      return {
        ...prev,
        [sessionId]: [...list, { id: a.id, name: a.name, mime: a.mime, size: a.size || 0 }],
      };
    });
  }
  function purgeSessionFiles(sessionId: string) {
    setSessionFiles((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }

  // Fetched bytes cache for preview (attachmentId -> data).
  const [previewCache, setPreviewCache] = createSignal<
    Record<string, { name: string; mime: string; dataB64: string; text?: string }>
  >({});
  // File preview modal target.
  const [previewFile, setPreviewFile] = createSignal<PreviewFile | null>(null);
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  function downloadPreviewFile() {
    const f = previewFile();
    if (!f?.dataB64) {
      opts.toast("Original bytes unavailable for download", "err");
      return;
    }
    try {
      const bin = atob(f.dataB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes as any], { type: f.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      opts.toast("Download failed", "err");
    }
  }

  function truncatePreviewFile() {
    const f = previewFile();
    const maxChars = (truncateTokens() || 16000) * 4;
    if (!f?.text || f.text.length <= maxChars) {
      opts.toast("File is already within the token limit", "err");
      return;
    }
    setPreviewFile({
      ...f,
      fullText: f.fullText || f.text,
      text: f.text.substring(0, maxChars),
      truncated: true,
    });
    opts.toast(`Truncated to ~${truncateTokens().toLocaleString()} tokens`, "ok");
  }

  function restorePreviewFile() {
    const f = previewFile();
    if (f?.fullText) {
      setPreviewFile({ ...f, text: f.fullText, fullText: undefined, truncated: false });
      opts.toast("Original content restored", "ok");
    }
  }

  function previewPending(a: { name: string; mime: string; text?: string; objectUrl?: string; dataB64?: string; size?: number }) {
    if (a.objectUrl) {
      setPreviewFile({ name: a.name, mime: a.mime, dataUrl: a.objectUrl, size: a.size });
    } else {
      setPreviewFile({ name: a.name, mime: a.mime, text: a.text || "(still extracting...)", size: a.size });
    }
    setPreviewCopied(false);
  }

  function b64ToDataUrl(mime: string, b64: string) {
    return `data:${mime || "application/octet-stream"};base64,${b64}`;
  }

  function openStoredPreview(sessionId: string, attachmentId: string) {
    const cached = previewCache()[attachmentId];
    const meta = (sessionFiles()[sessionId] || []).find((a) => a.id === attachmentId);
    const name = cached?.name || meta?.name || "attachment";
    const mime = cached?.mime || meta?.mime || "";
    if (!cached) {
      if (opts.isOpen()) {
        opts.send({ type: "get_attachment", sessionId, attachmentId });
        opts.toast("Loading attachment...", "ok");
      } else {
        opts.toast("Not connected to host", "err");
      }
      return;
    }
    if (mime.startsWith("image/")) {
      setPreviewFile({
        name,
        mime,
        dataUrl: b64ToDataUrl(mime, cached.dataB64),
        dataB64: cached.dataB64,
        size: meta?.size,
      });
      setPreviewCopied(false);
      return;
    }
    let text = cached.text || "";
    if (!text) {
      try {
        const bin = atob(cached.dataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = "(could not decode file)";
      }
    }
    setPreviewFile({ name, mime, text, dataB64: cached.dataB64, size: meta?.size });
    setPreviewCopied(false);
  }

  /** Evento attachment_data (guarda bytes + abre preview). */
  function noteAttachmentData(msg: AttachmentDataEvent) {
    const a = msg.attachment;
    if (!a?.id || (!a.data && !a.text)) return;
    setPreviewCache((prev) => ({
      ...prev,
      [a.id]: { name: a.name, mime: a.mime, dataB64: a.data || "", text: a.text },
    }));
    openStoredPreview(msg.sessionId, a.id);
  }

  return {
    resetReview,
    sessionFiles, noteSessionFiles, addSessionFile, purgeSessionFiles,
    previewCache, previewFile, setPreviewFile, previewCopied, setPreviewCopied,
    truncateTokens, setTruncateTokens, showTruncateInput, setShowTruncateInput,
    downloadPreviewFile, truncatePreviewFile, restorePreviewFile,
    previewPending, openStoredPreview, noteAttachmentData,
  };
}

export type ReviewDomain = ReturnType<typeof createReview>;
