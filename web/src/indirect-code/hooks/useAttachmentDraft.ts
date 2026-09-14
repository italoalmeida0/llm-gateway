import { createSignal, onCleanup } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";
import type { PendingAttachment, StoredAttachment } from "../viewTypes";

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

/** Owns one draft's asynchronous reads, object URLs and correlated uploads. */
export function createAttachmentDraft(opts: {
  send: (command: DaemonCommand) => void;
  isOpen: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  additionalCount?: () => number;
}) {
  const [pendingAttachments, setPendingAttachments] = createSignal<
    PendingAttachment[]
  >([]);
  const [preparingAttachments, setPreparingAttachments] = createSignal(0);
  let epoch = 0;
  const waiters = new Map<
    string,
    {
      key: string;
      sid: string;
      promise: Promise<string>;
      ok: (id: string) => void;
      fail: (reason: string) => void;
    }
  >();

  async function handleFiles(files: FileList | File[]) {
    const generation = epoch;
    // Reserve slots before the first await, including simultaneous paste/drop events.
    const room = Math.max(
      0,
      MAX_ATTACHMENTS -
        pendingAttachments().length -
        preparingAttachments() -
        (opts.additionalCount?.() || 0),
    );
    const list = Array.from(files).slice(0, room);
    if (files.length > room)
      opts.toast(`Max ${MAX_ATTACHMENTS} attachments per message`, "err");
    if (!list.length) return;
    setPreparingAttachments((n) => n + list.length);
    try {
      const { sniffFile, extractText, uint8ToB64 } = await import(
        "../../office"
      );
      for (const file of list) {
        if (generation !== epoch) return;
        try {
          if (file.size > MAX_ATTACHMENT_BYTES)
            throw new Error(`'${file.name}' too large (max 4MB)`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (generation !== epoch) return;
          const sniff = sniffFile(file, bytes);
          if (sniff.blocked) throw new Error(sniff.blocked);
          const isImage = sniff.kind === "image";
          if (isImage && bytes.length > MAX_IMAGE_BYTES)
            throw new Error(`'${file.name}' too large (max 2.5MB for images)`);
          const text = isImage
            ? undefined
            : await extractText(bytes, file.name, sniff.officeFormat);
          if (generation !== epoch) return;
          setPendingAttachments((prev) => [
            ...prev,
            {
              key: crypto.randomUUID(),
              name: file.name,
              mime: sniff.mime || file.type || "text/plain",
              size: bytes.length,
              dataB64: uint8ToB64(bytes),
              text,
              objectUrl: isImage
                ? URL.createObjectURL(
                    new Blob([bytes], { type: sniff.mime || file.type }),
                  )
                : undefined,
            },
          ]);
        } catch (e) {
          if (generation === epoch)
            opts.toast(
              e instanceof Error ? e.message : `Could not read '${file.name}'`,
              "err",
            );
        } finally {
          if (generation === epoch)
            setPreparingAttachments((n) => Math.max(0, n - 1));
        }
      }
    } catch (e) {
      if (generation === epoch) {
        setPreparingAttachments(0);
        opts.toast(
          e instanceof Error ? e.message : "Could not load file conversion",
          "err",
        );
      }
    }
  }

  function removePendingAttachment(key: string) {
    for (const w of waiters.values())
      if (w.key === key) w.fail("Attachment removed");
    const hit = pendingAttachments().find((p) => p.key === key);
    if (hit?.objectUrl) URL.revokeObjectURL(hit.objectUrl);
    setPendingAttachments((prev) => prev.filter((p) => p.key !== key));
  }

  function uploadOneAttachment(
    sid: string,
    a: PendingAttachment,
  ): Promise<string> {
    if (a.serverId && a.serverSessionId === sid)
      return Promise.resolve(a.serverId);
    for (const w of waiters.values())
      if (w.key === a.key && w.sid === sid) return w.promise;
    if (!opts.isOpen())
      return Promise.reject(new Error("Reconnect the host before uploading"));
    const requestId = a.uploadKey || crypto.randomUUID();
    let ok!: (id: string) => void;
    let fail!: (reason: string) => void;
    const promise = new Promise<string>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(requestId);
        setPendingAttachments((prev) =>
          prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
        );
      };
      const timer = setTimeout(
        () => fail(`Upload timed out for '${a.name}'`),
        20000,
      );
      ok = (id) => {
        finish();
        resolve(id);
      };
      fail = (reason) => {
        finish();
        reject(new Error(reason));
      };
    });
    waiters.set(requestId, { key: a.key, sid, promise, ok, fail });
    setPendingAttachments((prev) =>
      prev.map((p) =>
        p.key === a.key ? { ...p, uploading: true, uploadKey: requestId } : p,
      ),
    );
    try {
      opts.send({
        type: "upload_attachment",
        requestId,
        sessionId: sid,
        name: a.name,
        mime: a.mime,
        data: a.dataB64,
        text:
          a.text == null
            ? undefined
            : Array.from(a.text)
                .slice(0, 512 * 1024)
                .join(""),
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Upload failed");
    }
    return promise;
  }

  function noteAttachmentUploaded(
    requestId: string | undefined,
    a: StoredAttachment,
    sid?: string,
  ) {
    const w = requestId ? waiters.get(requestId) : undefined;
    if (!w || sid !== w.sid || !a.id) return false;
    setPendingAttachments((prev) =>
      prev.map((p) =>
        p.key === w.key ? { ...p, serverId: a.id, serverSessionId: sid } : p,
      ),
    );
    w.ok(a.id);
    return true;
  }
  function failUpload(requestId: string | undefined, message: string) {
    const w = requestId ? waiters.get(requestId) : undefined;
    if (!w) return false;
    w.fail(message);
    return true;
  }
  function cancelUploads(
    message = "Upload interrupted. Reconnect and send again.",
  ) {
    for (const w of waiters.values()) w.fail(message);
  }
  function clearAttachments() {
    epoch++;
    cancelUploads("Attachment draft changed");
    for (const p of pendingAttachments())
      if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
    setPendingAttachments([]);
    setPreparingAttachments(0);
  }
  onCleanup(clearAttachments);
  return {
    pendingAttachments,
    setPendingAttachments,
    preparingAttachments,
    handleFiles,
    removePendingAttachment,
    uploadOneAttachment,
    noteAttachmentUploaded,
    failUpload,
    cancelUploads,
    clearAttachments,
  };
}
