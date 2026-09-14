import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createSignal, onCleanup } from "solid-js";
import type { PreviewFile } from "../types";
import type { AttachmentDataEvent } from "../daemon-protocol";
import type { StoredAttachment } from "../viewTypes";

/** Review of changes + file preview + session attachments (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createReview(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  isSessionRunning: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm: (o: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  isHostOnline: () => boolean;
}) {
  // Stored attachments per session (from session_data + uploads).
  const [sessionFiles, setSessionFiles] = createSignal<
    Record<string, StoredAttachment[]>
  >({});
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
  function addSessionFile(
    sessionId: string,
    a: { id: string; name: string; mime: string; size?: number },
  ) {
    setSessionFiles((prev) => {
      const list = prev[sessionId] || [];
      if (list.some((x) => x.id === a.id)) return prev;
      return {
        ...prev,
        [sessionId]: [
          ...list,
          { id: a.id, name: a.name, mime: a.mime, size: a.size || 0 },
        ],
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
    Record<
      string,
      { name: string; mime: string; dataB64: string; text?: string }
    >
  >({});
  // File preview modal target.
  const [previewFile, setPreviewFileState] = createSignal<PreviewFile | null>(
    null,
  );
  function setPreviewFile(file: PreviewFile | null) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    setPreviewCopied(false);
    setShowTruncateInput(false);
    return setPreviewFileState(file);
  }
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  function downloadPreviewFile() {
    const f = previewFile();
    if (f?.dataB64 == null) {
      opts.toast("Original bytes unavailable for download", "err");
      return;
    }
    try {
      const bin = atob(f.dataB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(
        new Blob([bytes as any], { type: f.mime }),
      );
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
    const limit = Math.floor(truncateTokens());
    if (!Number.isFinite(limit) || limit < 1) {
      opts.toast("Enter a positive token limit", "err");
      return;
    }
    const maxChars = limit * 4;
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
    opts.toast(
      `Preview limited to ~${limit.toLocaleString()} tokens; the attachment is unchanged`,
      "ok",
    );
  }

  function restorePreviewFile() {
    const f = previewFile();
    if (f?.fullText) {
      setPreviewFile({
        ...f,
        text: f.fullText,
        fullText: undefined,
        truncated: false,
      });
      opts.toast("Original content restored", "ok");
    }
  }

  function previewPending(a: {
    name: string;
    mime: string;
    text?: string;
    objectUrl?: string;
    dataB64?: string;
    size?: number;
  }) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    if (a.objectUrl) {
      setPreviewFile({
        name: a.name,
        mime: a.mime,
        dataUrl:
          a.dataB64 != null ? b64ToDataUrl(a.mime, a.dataB64) : a.objectUrl,
        dataB64: a.dataB64,
        size: a.size,
      });
    } else {
      setPreviewFile({
        name: a.name,
        mime: a.mime,
        text: a.text ?? "(still extracting...)",
        dataB64: a.dataB64,
        size: a.size,
      });
    }
    setPreviewCopied(false);
  }

  function b64ToDataUrl(mime: string, b64: string) {
    return `data:${mime || "application/octet-stream"};base64,${b64}`;
  }

  function openStoredPreview(sessionId: string, attachmentId: string) {
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    const cached = previewCache()[`${sessionId}:${attachmentId}`];
    const meta = (sessionFiles()[sessionId] || []).find(
      (a) => a.id === attachmentId,
    );
    const name = cached?.name || meta?.name || "attachment";
    const mime = cached?.mime || meta?.mime || "";
    if (!cached) {
      if (opts.isOpen() && opts.isHostOnline()) {
        clearTimeout(previewTimer);
        const requestId = crypto.randomUUID();
        pendingPreview = { requestId, sessionId, attachmentId };
        opts.send({
          type: "get_attachment",
          requestId,
          sessionId,
          attachmentId,
        });
        previewTimer = setTimeout(
          () => failPreview(requestId, "Attachment preview timed out"),
          20000,
        );
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
    let text = cached.text ?? "";
    if (cached.text == null) {
      try {
        const bin = atob(cached.dataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = "(could not decode file)";
      }
    }
    setPreviewFile({
      name,
      mime,
      text,
      dataB64: cached.dataB64,
      size: meta?.size,
    });
    setPreviewCopied(false);
  }

  let pendingPreview:
    | { requestId: string; sessionId: string; attachmentId: string }
    | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let currentHost = "";
  createEffect(() => {
    const host = opts.getHostId();
    opts.getSessionId();
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    setPreviewFile(null);
    if (host !== currentHost) {
      currentHost = host;
      setPreviewCache({});
      setSessionFiles({});
    }
  });
  onCleanup(() => clearTimeout(previewTimer));
  function failPreview(requestId: string | undefined, message: string) {
    if (!requestId || pendingPreview?.requestId !== requestId) return false;
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    opts.toast(message, "err");
    return true;
  }
  // Relay broadcasts every response to all clients. Only the requesting view
  // may open the modal; out-of-order replies never replace a newer selection.
  function noteAttachmentData(msg: AttachmentDataEvent) {
    const a = msg.attachment;
    if (
      !a?.id ||
      typeof a.data !== "string" ||
      msg.requestId !== pendingPreview?.requestId ||
      msg.sessionId !== pendingPreview?.sessionId ||
      a.id !== pendingPreview?.attachmentId
    )
      return;
    clearTimeout(previewTimer);
    pendingPreview = undefined;
    const key = `${msg.sessionId}:${a.id}`;
    setPreviewCache((prev) => {
      const entries = Object.entries(prev).filter(([id]) => id !== key);
      // Bound retained base64 data across a long browsing session.
      let size = a.data.length;
      const next: typeof prev = {};
      for (const [id, value] of entries.reverse()) {
        size += value.dataB64.length;
        if (size > 24 * 1024 * 1024) break;
        next[id] = value;
      }
      next[key] = { name: a.name, mime: a.mime, dataB64: a.data, text: a.text };
      return next;
    });
    openStoredPreview(msg.sessionId, a.id);
  }

  return {
    sessionFiles,
    noteSessionFiles,
    addSessionFile,
    purgeSessionFiles,
    previewCache,
    previewFile,
    setPreviewFile,
    previewCopied,
    setPreviewCopied,
    truncateTokens,
    setTruncateTokens,
    showTruncateInput,
    setShowTruncateInput,
    downloadPreviewFile,
    truncatePreviewFile,
    restorePreviewFile,
    previewPending,
    openStoredPreview,
    noteAttachmentData,
    failPreview,
  };
}

export type ReviewDomain = ReturnType<typeof createReview>;
