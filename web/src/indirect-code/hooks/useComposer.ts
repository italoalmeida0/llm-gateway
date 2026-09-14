import type { DaemonCommand } from "../daemon-protocol";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { REASONING_LEVELS, SLASH_COMMANDS } from "../constants";
import { formatEffort, normalizeEffort } from "../utils/format";
import type { ChatMessage } from "../types";
import { sanitizeUserText } from "../live";
import { createMentions } from "./useMentions";
import { slashCommand } from "../utils/composerTokens";
import { createAttachmentDraft } from "./useAttachmentDraft";
import type { Transcript } from "./useTranscript";

/** Composer: prompt, attachments, slash palette, and sending (extracted
 * verbatim from RemoteCodePage — collaborators via params). */
export function createComposer(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  isDisposed: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  getProjectId: () => string;
  getModel: () => string;
  getAvailableModels?: () => string[];
  getOptions: () => {
    effort: string;
    mode: string;
    skills: string[];
    access: string;
  };
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
  /** Turn running: the page queues the message instead of sending. */
  onQueueMessage: (text: string, attachmentIds: string[], model: string, yolo: boolean) => void;
  isCreatingSession: () => boolean;
  getSessionDraft?: () => string;
  getNewDraft?: () => string;
}) {
  const [inputPrompt, setInputPrompt] = createSignal("");
  const mentions = createMentions({
    ...opts,
    text: inputPrompt,
    setText: setInputPrompt,
    inputId: "rc-composer",
  });
  const attachments = createAttachmentDraft(opts);
  const { pendingAttachments, uploadOneAttachment } = attachments;
  const [sending, setSending] = createSignal(false);
  let submissionEpoch = 0;
  function clearAttachments() {
    submissionEpoch++;
    attachments.clearAttachments();
  }

  createEffect(() => {
    if (!opts.isOpen() || !opts.isHostOnline()) attachments.cancelUploads();
  });

  // Composer menus (addBtn anchor lives on the page, as before —
  // ref={ctx.x} copies the value, always undefined; semantics preserved).
  const [addContextOpen, setAddContextOpen] = createSignal(false);

  // Autocomplete Palette
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [slashDismissed, setSlashDismissed] = createSignal("");

  // Palette visibility rules: open only while the head token is a partial
  // prefix of some command. An exact match hides it (Enter will run the
  // command); typing args (space) or a non-matching token hides it too.
  const slashMatches = createMemo(() => {
    const raw = inputPrompt().trim().toLowerCase();
    if (slashDismissed() === inputPrompt() || !mentions.focused()) return [];
    if (!raw.startsWith("/") || /\s/.test(raw)) return [];
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
      if (lastSentDraft !== text && opts.isOpen()) {
        lastSentDraft = text;
        recentSentDrafts.set(`${sid || "new"}:${text}`, Date.now());
        if (opts.isOpen()) {
          opts.send({ type: "set_draft", sessionId: sid, draft: text });
        }
      }
    }
  }

  function syncDraftToServer(sid: string, text: string) {
    const hostId = opts.getHostId();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (
        lastSentDraft === text ||
        !opts.isOpen() ||
        opts.getHostId() !== hostId
      )
        return;
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
  let currentHost = "";
  createEffect(() => {
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    if (sid !== currentSid || host !== currentHost) {
      if (host === currentHost) flushPendingDraft();
      else {
        clearTimeout(draftTimer);
        recentSentDrafts.clear();
      }
      currentHost = host;
      currentSid = sid;
      if (sid) {
        const serverDraft = opts.getSessionDraft?.() ?? "";
        const localDraft = (() => {
          try {
            return (
              localStorage.getItem(`llmgw-draft:${opts.getHostId()}:${sid}`) ||
              ""
            );
          } catch {
            return "";
          }
        })();
        const draft = serverDraft || localDraft;
        setInputPrompt(draft);
        lastSentDraft = serverDraft;
      } else {
        const newDraft = opts.getNewDraft?.() ?? "";
        setInputPrompt(newDraft);
        lastSentDraft = newDraft;
      }
    }
  });

  createEffect(
    on(
      () =>
        (opts.getSessionId()
          ? opts.getSessionDraft?.()
          : opts.getNewDraft?.()) ?? "",
      (remote) => {
        const sid = opts.getSessionId();
        const current = inputPrompt();

        // 1. If remote is identical to current, nothing to do
        if (remote === current) return;

        // 2. Active Focus Guard: if user is actively typing in the composer, NEVER overwrite the DOM
        const isFocused =
          typeof document !== "undefined" &&
          document.activeElement?.id === "rc-composer";
        if (isFocused) return;

        // 3. Echo Suppression: if remote matches what this client recently sent, discard it
        purgeRecentSentDrafts();
        if (
          recentSentDrafts.has(`${sid || "new"}:${remote}`) ||
          remote === lastSentDraft
        )
          return;

        // 4. Monotonic Prefix Guard: if local text already starts with remote and is longer, local is ahead
        if (current.startsWith(remote) && current.length > remote.length)
          return;

        // 5. Post-Submit Suppression: prevent in-flight draft from resurrecting a prompt that was just sent
        if (
          Date.now() - lastPromptSentAt < 2500 &&
          (remote === lastSentPromptText ||
            (remote && lastSentPromptText.startsWith(remote)))
        )
          return;

        // Apply remote update cleanly
        setInputPrompt(remote);
        lastSentDraft = remote;
      },
    ),
  );

  createEffect(() => {
    const text = inputPrompt();
    const sid = opts.getSessionId();
    opts.isOpen();
    if (sid) {
      try {
        if (text)
          localStorage.setItem(`llmgw-draft:${opts.getHostId()}:${sid}`, text);
        else localStorage.removeItem(`llmgw-draft:${opts.getHostId()}:${sid}`);
      } catch {}
      syncDraftToServer(sid, text);
    } else {
      syncDraftToServer("", text);
    }
  });

  // Routes /commands: UI-backed ones are handled locally (modals, silent
  // setters); recognized transcript commands go to the daemon. Returns true when fully handled.
  function routeSlash(text: string): boolean {
    const clean = text.trim();
    if (!clean.startsWith("/")) return false;
    const sp = clean.search(/\s/);
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
        if (
          opts.getAvailableModels &&
          !opts.getAvailableModels().includes(arg)
        ) {
          opts.toast("Choose a model from the gateway catalog", "err");
          return true;
        }
        opts.o.setActiveModel(arg);
        opts.o.configureSession();
        opts.toast(`Model set to ${arg}`, "ok");
        return true;
      case "/reasoning": {
        const lvl = normalizeEffort(arg);
        if (!lvl || !(REASONING_LEVELS as readonly string[]).includes(lvl)) {
          opts.toast(
            `Reasoning: ${formatEffort(opts.getOptions().effort)}`,
            "ok",
          );
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
    if (sending()) return;
    if (attachments.preparingAttachments()) {
      opts.toast("Wait for files to finish extracting", "err");
      return;
    }
    if (opts.isWorkspaceBlocked()) {
      opts.checkWorkspace();
      return;
    }
    if (!opts.isOpen() || !opts.isHostOnline()) {
      opts.toast("Reconnect the host before sending a message", "err");
      return;
    }
    if (opts.isCreatingSession()) return;
    const text = inputPrompt().trim();
    const sid = opts.getSessionId();
    const hostId = opts.getHostId();
    // Slash fast-path: UI commands resolve locally, transcript ops go down.
    if (slashCommand(text)) {
      if (pendingAttachments().length) {
        opts.toast(
          "Send attachments in a message before running a command",
          "err",
        );
        return;
      }
      try {
        if (sid)
          localStorage.removeItem(`llmgw-draft:${opts.getHostId()}:${sid}`);
      } catch {}
      if (routeSlash(text)) {
        if (draftTimer) {
          clearTimeout(draftTimer);
          draftTimer = undefined;
        }
        setInputPrompt("");
        lastSentDraft = "";
        recentSentDrafts.set(`${sid || "new"}:`, Date.now());
        if (opts.isOpen()) {
          opts.send({ type: "set_draft", sessionId: sid, draft: "" });
        }
        return;
      }
      if (!sid) {
        opts.onBeginConversation();
        return;
      }
      if (opts.isSessionRunning()) {
        opts.toast("Stop the current turn before running a command", "err");
        return;
      }
      opts.send({
        type: "prompt",
        sessionId: sid,
        text,
        model: opts.getModel(),
        yolo: opts.getOptions().access === "full",
        options: opts.getOptions(),
        attachmentIds: [],
      });
      setInputPrompt("");
      return;
    }
    if (!opts.getModel()) {
      opts.toast("Configure a compatible model in the gateway first", "err");
      return;
    }
    if (!text && pendingAttachments().length === 0) return;
    if (!sid) {
      opts.onBeginConversation();
      return;
    }

    // Upload pending attachments first so the daemon owns the bytes.
    let attachmentIds: string[] = [];
    const pending = pendingAttachments();
    const epoch = submissionEpoch;
    if (pending.some((a) => a.loading)) {
      opts.toast("Wait for files to finish extracting", "err");
      return;
    }
    setSending(true);
    try {
      if (pending.length > 0) {
        try {
          attachmentIds = await Promise.all(
            pending.map((a) => uploadOneAttachment(sid, a)),
          );
        } catch (e: any) {
          if (opts.getHostId() === hostId && opts.getSessionId() === sid) {
            opts.toast(e?.message || "Attachment upload failed", "err");
          }
          return;
        }
      }
      if (
        epoch !== submissionEpoch ||
        opts.isDisposed() ||
        opts.getHostId() !== hostId ||
        opts.getSessionId() !== sid ||
        !opts.isOpen() ||
        !opts.isHostOnline()
      )
        return;
      if (
        pending.some((a) => !pendingAttachments().some((p) => p.key === a.key))
      )
        return;
      // Options may have changed while attachments were uploading.
      const model = opts.getModel();
      const options = opts.getOptions();
      const cleanText = sanitizeUserText(text);
      // A turn started while composing or uploading: queue instead of
      // sending. The daemon promotes the head when the turn completes.
      if (opts.isSessionRunning()) {
        clearAttachments();
        if (inputPrompt().trim() === text) setInputPrompt("");
        lastSentDraft = "";
        if (sid && opts.isOpen()) {
          opts.send({ type: "set_draft", sessionId: sid, draft: "" });
        }
        opts.onQueueMessage(cleanText, attachmentIds, model, options.access === "full");
        return;
      }
      const displayText = cleanText;
      const userMsg: ChatMessage = {
        id: `user_${Date.now()}`,
        role: "user",
        blocks: [{ type: "text", text: displayText }],
        time: Date.now(),
        attachments: pending.map((a, i) => ({
          id: attachmentIds[i],
          name: a.name,
          mime: a.mime,
          size: a.size,
        })),
        isTurnStart: true,
      };
      lastPromptSentAt = Date.now();
      lastSentPromptText = text;
      if (draftTimer) {
        clearTimeout(draftTimer);
        draftTimer = undefined;
      }
      opts.t.pushUserMessage(userMsg);
      if (inputPrompt().trim() === text) setInputPrompt("");
      lastSentDraft = "";
      recentSentDrafts.set(`${sid || "new"}:`, Date.now());
      if (sid && opts.isOpen()) {
        opts.send({ type: "set_draft", sessionId: sid, draft: "" });
      }
      // Preserve any new text or attachments entered while the upload was in flight.
      for (const p of pending) attachments.removePendingAttachment(p.key);
      try {
        localStorage.removeItem(`llmgw-draft:${opts.getHostId()}:${sid}`);
      } catch {}
      opts.t.beginTurn();
      opts.t.scrollToBottom(true);

      opts.send({
        type: "prompt",
        sessionId: sid,
        text: cleanText,
        model,
        yolo: options.access === "full",
        options,
        attachmentIds,
      });
    } finally {
      setSending(false);
    }
  }

  return {
    inputPrompt,
    setInputPrompt,
    ...attachments,
    clearAttachments,
    sending,
    mentions,
    addContextOpen,
    setAddContextOpen,
    slashIndex,
    setSlashIndex,
    slashMatches,
    pickSlash,
    dismissSlash: () => setSlashDismissed(inputPrompt()),
    sendPrompt,
    flushPendingDraft,
  };
}

export type Composer = ReturnType<typeof createComposer>;
