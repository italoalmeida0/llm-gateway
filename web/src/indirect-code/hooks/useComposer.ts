import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { REASONING_LEVELS, SLASH_COMMANDS } from "../constants";
import { formatEffort, normalizeEffort } from "../utils/format";
import type { ChatMessage } from "../types";
import { sanitizeUserText } from "../live";
import type { PendingAttachment } from "../viewTypes";
import type { Transcript } from "./useTranscript";

/** Composer: prompt, attachments, slash palette, and sending (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createComposer(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  isDisposed: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  getModel: () => string;
  getOptions: () => { effort: string; mode: string; skills: string[]; access: string };
  isSessionRunning: () => boolean;
  isWorkspaceBlocked: () => boolean;
  checkWorkspace: () => void;
  isHostOnline: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  t: Transcript;
  o: {
    configureSession: () => void;
    setActiveModel: (v: string) => void;
    setEffort: (v: string) => void;
  };
  /** /clear: the page opens a fresh draft. */
  onClearConversation: () => void;
  /** No session: the page creates one in the active project. */
  onBeginConversation: () => void;
  isCreatingSession: () => boolean;
  getSessionDraft?: () => string;
  getNewDraft?: () => string;
}) {
  const [inputPrompt, setInputPrompt] = createSignal("");
  const [pendingAttachments, setPendingAttachments] = createSignal<PendingAttachment[]>([]);
  const uploadWaiters = new Map<string, { ok: (id: string) => void; fail: (msg: string) => void }>();

  // Composer menus (addBtn/filesBtn anchors live on the page, as before —
  // ref={ctx.x} copies the value, always undefined; semantics preserved).
  const [addContextOpen, setAddContextOpen] = createSignal(false);
  const [filesMenuOpen, setFilesMenuOpen] = createSignal(false);

  // Autocomplete Palette
  const [slashIndex, setSlashIndex] = createSignal(0);

  // Palette visibility rules: open only while the head token is a partial
  // prefix of some command. An exact match hides it (Enter will run the
  // command); typing args (space) or a non-matching token hides it too.
  const slashMatches = createMemo(() => {
    const raw = inputPrompt().trim().toLowerCase();
    if (!raw.startsWith("/") || raw.includes(" ")) return [];
    if (SLASH_COMMANDS.some((sc) => sc.cmd === raw)) return [];
    return SLASH_COMMANDS.filter((sc) => sc.cmd.startsWith(raw));
  });
  // Selection resets on every keystroke so the focused row never goes stale.
  createEffect(() => {
    inputPrompt();
    setSlashIndex(0);
  });

  // Accepts a palette pick: fills the composer with the full command and
  // hides the palette (an exact command is no longer a "match"). Focus
  // stays in the textarea so typing/Enter continues naturally.
  function pickSlash(cmd: string) {
    setInputPrompt(cmd + " ");
    try {
      const el = document.querySelector<HTMLTextAreaElement>("#rc-composer");
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  }

  // Draft synchronization (via SignalDB mirror & daemon)
  let lastSentDraft = "";
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const recentSentDrafts = new Map<string, number>();
  let lastPromptSentAt = 0;
  let lastSentPromptText = "";

  function purgeRecentSentDrafts() {
    const now = Date.now();
    for (const [key, time] of recentSentDrafts.entries()) {
      if (now - time > 10000) recentSentDrafts.delete(key);
    }
  }

  function flushPendingDraft() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = undefined;
      const sid = currentSid ?? opts.getSessionId();
      const text = inputPrompt();
      if (lastSentDraft !== text) {
        lastSentDraft = text;
        recentSentDrafts.set(`${sid || "new"}:${text}`, Date.now());
        if (opts.isOpen()) {
          opts.send({ type: "set_draft", sessionId: sid, draft: text });
        }
      }
    }
  }

  function syncDraftToServer(sid: string, text: string) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (lastSentDraft === text) return;
      lastSentDraft = text;
      recentSentDrafts.set(`${sid || "new"}:${text}`, Date.now());
      purgeRecentSentDrafts();
      if (opts.isOpen()) {
        opts.send({ type: "set_draft", sessionId: sid, draft: text });
      }
    }, 350);
  }
  onCleanup(() => clearTimeout(draftTimer));

  let currentSid: string | null = null;
  createEffect(() => {
    const sid = opts.getSessionId();
    if (sid !== currentSid) {
      flushPendingDraft();
      currentSid = sid;
      if (sid) {
        const serverDraft = opts.getSessionDraft?.() ?? "";
        const localDraft = (() => {
          try { return localStorage.getItem(`llmgw-draft:${sid}`) || ""; } catch { return ""; }
        })();
        const draft = serverDraft || localDraft;
        setInputPrompt(draft);
        lastSentDraft = draft;
      } else {
        const newDraft = opts.getNewDraft?.() ?? "";
        setInputPrompt(newDraft);
        lastSentDraft = newDraft;
      }
    }
  });

  createEffect(() => {
    const sid = opts.getSessionId();
    const remote = (sid ? opts.getSessionDraft?.() : opts.getNewDraft?.()) ?? "";
    const current = inputPrompt();

    // 1. If remote is identical to current, nothing to do
    if (remote === current) return;

    // 2. Active Focus Guard: if user is actively typing in the composer, NEVER overwrite the DOM
    const isFocused = typeof document !== "undefined" && document.activeElement?.id === "rc-composer";
    if (isFocused) return;

    // 3. Echo Suppression: if remote matches what this client recently sent, discard it
    purgeRecentSentDrafts();
    if (recentSentDrafts.has(`${sid || "new"}:${remote}`) || remote === lastSentDraft) return;

    // 4. Monotonic Prefix Guard: if local text already starts with remote and is longer, local is ahead
    if (current.startsWith(remote) && current.length > remote.length) return;

    // 5. Post-Submit Suppression: prevent in-flight draft from resurrecting a prompt that was just sent
    if (Date.now() - lastPromptSentAt < 2500 && (remote === lastSentPromptText || (remote && lastSentPromptText.startsWith(remote)))) return;

    // Apply remote update cleanly
    setInputPrompt(remote);
    lastSentDraft = remote;
  });

  createEffect(() => {
    const text = inputPrompt();
    const sid = opts.getSessionId();
    if (sid) {
      try {
        if (text) localStorage.setItem(`llmgw-draft:${sid}`, text);
        else localStorage.removeItem(`llmgw-draft:${sid}`);
      } catch {}
      syncDraftToServer(sid, text);
    } else {
      syncDraftToServer("", text);
    }
  });

  // --- Attachments (chatbot-style; bytes live on the daemon) ---
  const MAX_ATTACHMENTS = 5;
  const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files || []);
    if (list.length === 0) return;

    const room = MAX_ATTACHMENTS - pendingAttachments().length;
    if (room <= 0) {
      opts.toast(`Max ${MAX_ATTACHMENTS} attachments per message`, "err");
      return;
    }
    const { sniffFile, extractText, uint8ToB64 } = await import("../../office");
    for (const file of list.slice(0, room)) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        opts.toast(`Could not read '${file.name}'`, "err");
        continue;
      }
      const sniff = sniffFile(file, bytes);
      if (sniff.blocked) {
        opts.toast(sniff.blocked, "err");
        continue;
      }
      const kind = sniff.kind || "text";
      const isImage = kind === "image";
      const cap = isImage ? MAX_IMAGE_BYTES : 12 * 1024 * 1024;
      if (bytes.length > cap) {
        opts.toast(`'${file.name}' too large (max ${isImage ? "2.5MB" : "12MB"})`, "err");
        continue;
      }
      const key = `pa_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
      const base = {
        key,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        dataB64: uint8ToB64(bytes),
      };
      if (isImage) {
        setPendingAttachments((prev) => [
          ...prev,
          { ...base, objectUrl: URL.createObjectURL(file) },
        ]);
        continue;
      }
      // Text-likes convert in the background (pdf/office may take seconds).
      const needsConvert = kind === "office" || !!sniff.officeFormat;
      setPendingAttachments((prev) => [
        ...prev,
        { ...base, loading: needsConvert, text: needsConvert ? (sniff.officeFormat === "pdf" ? "Extracting PDF..." : "Converting document...") : undefined },
      ]);
      if (needsConvert || sniff.officeFormat === "pdf" || kind === "text") {
        try {
          let text: string;
          if (kind === "text" && !sniff.officeFormat) {
            text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          } else {
            text = await extractText(bytes, file.name, sniff.officeFormat);
          }
          setPendingAttachments((prev) =>
            prev.map((p) => (p.key === key ? { ...p, loading: false, text } : p)),
          );
        } catch (e: any) {
          setPendingAttachments((prev) => prev.filter((p) => p.key !== key));
          opts.toast(`Could not extract '${file.name}': ${e?.message || e}`, "err");
        }
      }
    }
  }

  function removePendingAttachment(key: string) {
    setPendingAttachments((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit?.objectUrl) {
        try {
          URL.revokeObjectURL(hit.objectUrl);
        } catch {}
      }
      return prev.filter((p) => p.key !== key);
    });
  }

  function uploadOneAttachment(sid: string, a: PendingAttachment): Promise<string> {
    if (a.serverId) return Promise.resolve(a.serverId);
    const requestId = `ua_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    setPendingAttachments((prev) =>
      prev.map((p) => (p.key === a.key ? { ...p, uploading: true, uploadKey: requestId } : p)),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        uploadWaiters.delete(requestId);
        setPendingAttachments((prev) =>
          prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
        );
        reject(new Error(`Upload timed out for '${a.name}'`));
      }, 20000);
      uploadWaiters.set(requestId, {
        ok: (id: string) => {
          clearTimeout(timer);
          resolve(id);
        },
        fail: (m: string) => {
          clearTimeout(timer);
          setPendingAttachments((prev) =>
            prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
          );
          reject(new Error(m));
        },
      });
      opts.send({
        type: "upload_attachment",
        requestId,
        sessionId: sid,
        name: a.name,
        mime: a.mime,
        data: a.dataB64,
        text: a.text || undefined,
      });
    });
  }

  /** Resolves a pending upload (daemon ack via page dispatcher). */
  function noteAttachmentUploaded(requestId: string | undefined, attachment: { id: string; name: string }) {
    setPendingAttachments((prev) =>
      prev.map((p) =>
        p.uploadKey === requestId || (!p.serverId && p.name === attachment.name)
          ? { ...p, serverId: attachment.id, uploading: false }
          : p,
      ),
    );
    const w = requestId ? uploadWaiters.get(requestId) : undefined;
    if (w) {
      uploadWaiters.delete(requestId!);
      w.ok(attachment.id);
    }
  }
  function failUpload(requestId: string | undefined, message: string): boolean {
    if (requestId && uploadWaiters.has(requestId)) {
      const w = uploadWaiters.get(requestId)!;
      uploadWaiters.delete(requestId);
      w.fail(message);
      return true;
    }
    return false;
  }

  function clearAttachments() {
    for (const p of pendingAttachments()) {
      if (p.objectUrl) {
        try {
          URL.revokeObjectURL(p.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments([]);
  }

  // Routes /commands: UI-backed ones are handled locally (modals, silent
  // setters); transcript ops (/compact, /clear, /jail, /unjail) and unknown
  // commands go to the daemon. Returns true when fully handled.
  function routeSlash(text: string): boolean {
    const clean = text.trim();
    if (!clean.startsWith("/")) return false;
    const sp = clean.indexOf(" ");
    const head = (sp < 0 ? clean : clean.slice(0, sp)).toLowerCase();
    const arg = (sp < 0 ? "" : clean.slice(sp + 1)).trim();
    switch (head) {
      case "/clear":
        opts.onClearConversation();
        return true;
      case "/model":
        if (!arg) {
          opts.toast(`Current model: ${opts.getModel()}`, "ok");
          return true;
        }
        opts.o.setActiveModel(arg);
        opts.o.configureSession();
        opts.toast(`Model set to ${arg}`, "ok");
        return true;
      case "/reasoning": {
        const lvl = normalizeEffort(arg);
        if (!lvl || !(REASONING_LEVELS as readonly string[]).includes(lvl)) {
          opts.toast(`Reasoning: ${formatEffort(opts.getOptions().effort)}`, "ok");
          return true;
        }
        opts.o.setEffort(lvl);
        opts.o.configureSession();
        opts.toast(`Reasoning effort set to ${formatEffort(lvl)}`, "ok");
        return true;
      }
      default:
        return false;
    }
  }

  async function sendPrompt() {
    if (opts.isWorkspaceBlocked()) { opts.checkWorkspace(); return; }
    if (!opts.isOpen() || !opts.isHostOnline()) {
      opts.toast("Reconnect the host before sending a message", "err");
      return;
    }
    if (opts.isCreatingSession()) return;
    if (!opts.getModel()) { opts.toast("Configure a compatible model in the gateway first", "err"); return; }
    const text = inputPrompt().trim();
    const sid = opts.getSessionId();
    const hostId = opts.getHostId();
    // Slash fast-path: UI commands resolve locally, transcript ops go down.
    if (text.startsWith("/")) {
      try {
        if (sid) localStorage.removeItem(`llmgw-draft:${sid}`);
      } catch {}
      if (routeSlash(text)) {
        if (draftTimer) {
          clearTimeout(draftTimer);
          draftTimer = undefined;
        }
        setInputPrompt("");
        lastSentDraft = "";
        recentSentDrafts.set(`${sid || "new"}:`, Date.now());
        if (sid && opts.isOpen()) {
          opts.send({ type: "set_draft", sessionId: sid, draft: "" });
        }
        return;
      }
      if (!sid) {
        opts.onBeginConversation();
        return;
      }
    }
    if (!text && pendingAttachments().length === 0) return;
    if (!sid) {
      opts.onBeginConversation();
      return;
    }
    if (opts.isSessionRunning()) return;

    // Upload pending attachments first so the daemon owns the bytes.
    let attachmentIds: string[] = [];
    const pending = pendingAttachments();
    if (pending.some((a) => a.loading)) {
      opts.toast("Wait for files to finish extracting", "err");
      return;
    }
    if (pending.length > 0) {
      opts.t.setSessionStatus("running");
      try {
        attachmentIds = await Promise.all(pending.map((a) => uploadOneAttachment(sid, a)));
      } catch (e: any) {
        if (opts.getHostId() === hostId && opts.getSessionId() === sid) {
          opts.t.setSessionStatus("idle");
          opts.toast(e?.message || "Attachment upload failed", "err");
        }
        return;
      }
    }
    if (opts.isDisposed() || opts.getHostId() !== hostId || opts.getSessionId() !== sid) return;
    // Options may have changed while attachments were uploading.
    const model = opts.getModel();
    const options = opts.getOptions();
    const attachmentNames = pending.map((a) => a.name);

    const cleanText = sanitizeUserText(text);
    const displayText = cleanText || attachmentNames.map((n) => `[Attached ${n}]`).join("\n");
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text: displayText }],
      time: Date.now(),
      attachments: attachmentNames.length > 0 ? attachmentNames : undefined,
      isTurnStart: true,
    };
    lastPromptSentAt = Date.now();
    lastSentPromptText = text;
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = undefined;
    }
    opts.t.pushUserMessage(userMsg);
    setInputPrompt("");
    lastSentDraft = "";
    recentSentDrafts.set(`${sid || "new"}:`, Date.now());
    if (sid && opts.isOpen()) {
      opts.send({ type: "set_draft", sessionId: sid, draft: "" });
    }
    for (const p of pending) {
      if (p.objectUrl) {
        try {
          URL.revokeObjectURL(p.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments([]);
    try {
      localStorage.removeItem(`llmgw-draft:${sid}`);
    } catch {}
    opts.t.beginTurn();
    opts.t.scrollToBottom(true);

    opts.send({
      type: "prompt",
      sessionId: sid,
      text: cleanText || "(see attachments)",
      model,
      yolo: options.access === "full",
      options,
      attachmentIds,
    });
  }

  return {
    inputPrompt, setInputPrompt,
    pendingAttachments, setPendingAttachments,
    addContextOpen, setAddContextOpen, filesMenuOpen, setFilesMenuOpen,
    slashIndex, setSlashIndex, slashMatches, pickSlash, routeSlash,
    handleFiles, removePendingAttachment, uploadOneAttachment,
    noteAttachmentUploaded, failUpload, clearAttachments,
    sendPrompt,
    flushPendingDraft,
  };
}

export type Composer = ReturnType<typeof createComposer>;
