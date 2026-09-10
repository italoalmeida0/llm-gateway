import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { copyWithToast } from "../../ui";
import { createTranscriptScroll } from "../scroll";
import { buildRenderBlocks } from "../transcript";
import { elapsedLabel, messageText } from "../utils/format";
import { prettyArgs } from "../utils/wire";import {
  appendReasoningDelta as reduceReasoningDelta,
  appendTextDelta as reduceTextDelta,
  appendToolArgsDelta as reduceToolArgs,
  appendToolResult as reduceToolResult,
  cutTail,
  finishTurn,
  mergeAssistantMessage,
  mergeUsage,
  normalizeSessionMessages,
  pushAssistantCarrier,
  stampDuration,
  upsertToolCall as reduceToolCall,
} from "../transcript/updaters";
import type { PendingQuestion } from "../components/QuestionModal";
import type {
  AgentEvent, SessionStatusEvent, ToolApprovalRequestEvent,
} from "../daemon-protocol";
import type { SessionContext } from "../context";
import type {
  ChatMessage, CompactionState, PendingApproval, RenderBlock, SessionUsage, ToolUnit,
} from "../types";
import type { TodoItem, TurnActivity } from "../viewTypes";

/** Transcript domain: messages, turn state, thinking, live tools,
 * scroll, render blocks, and per-message ops (extracted verbatim from RemoteCodePage —
 * only the source of collaborators changes: passed via params). */
export function createTranscript(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
  showChoice: (o: { title: string; message: string; options: { id: string; label: string; hint?: string; primary?: boolean }[] }) => Promise<string | null>;
  showConfirm: (o: { title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }) => Promise<boolean>;
  /** Turn became idle: the page refreshes the review. */
  onTurnIdle: () => void;
  /** Context received in usage: the page compares it with the catalog. */
  onUsageContext: (ctx: SessionContext) => void;
  isHideToolMessages?: () => boolean;
}) {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [sessionCompaction, setSessionCompaction] = createSignal<CompactionState | null>(null);
  const [turnActivity, setTurnActivity] = createSignal<TurnActivity | null>(null);
  const [todos, setTodos] = createSignal<TodoItem[]>([]);
  const [todosOpen, setTodosOpen] = createSignal(true);
  let pendingTodosOpen: { value: boolean; time: number } | undefined;

  function toggleTodosOpen() {
    const next = !todosOpen();
    setTodosOpen(next);
    pendingTodosOpen = { value: next, time: Date.now() };
    const sid = opts.getSessionId();
    if (sid && opts.isOpen()) {
      opts.send({ type: "set_todos_open", sessionId: sid, open: next });
    }
  }

  function applyTodosOpenFromRemote(remote: boolean) {
    if (pendingTodosOpen) {
      if (pendingTodosOpen.value === remote) {
        // Confirmed by SignalDB / daemon
        pendingTodosOpen = undefined;
        return;
      }
      if (Date.now() - pendingTodosOpen.time < 4000) {
        return;
      }
      pendingTodosOpen = undefined;
    }
    setTodosOpen(remote);
  }
  const [turnClock, setTurnClock] = createSignal(Date.now());
  createEffect(() => {
    if (!turnActivity()?.startedAt || sessionStatus() !== "running") return;
    setTurnClock(Date.now());
    const timer = setInterval(() => setTurnClock(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const turnLabel = () => {
    const turn = turnActivity();
    if (!turn) return "";
    const elapsed = elapsedLabel((turn.endedAt || turnClock()) - turn.startedAt);
    const label = turn.status === "running" && pendingQuestion() ? "Waiting for your answers" : turn.status === "running" && pendingApproval() ? "Waiting for approval" : { running: "Working", cancelling: "Stopping turn", cancelled: "Turn cancelled", completed: "Turn completed", failed: "Turn failed" }[turn.status];
    return `${label} · ${elapsed}`;
  };
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = createSignal<PendingQuestion | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = createSignal(false);
  const [questionError, setQuestionError] = createSignal("");
  function showQuestion(question: PendingQuestion | null) {
    if (question) {
      const raw = (question as any).questions ?? (question as any).question;
      const normalized: PendingQuestion["questions"] = Array.isArray(raw)
        ? raw.map((q: any) => typeof q === "string" ? { header: "Question", question: q, options: [] } : { header: q?.header || "Question", question: q?.question || "", options: Array.isArray(q?.options) ? q.options : [], multiple: !!q?.multiple, custom: q?.custom })
        : raw && typeof raw === "object"
          ? [{ header: raw.header || "Question", question: raw.question || "", options: Array.isArray(raw.options) ? raw.options : [], multiple: !!raw.multiple, custom: raw.custom }]
          : typeof raw === "string" && raw.trim()
            ? [{ header: "Question", question: raw.trim(), options: [] }]
            : [];
      if (!normalized.length) {
        setPendingQuestion(null);
        setQuestionSubmitting(false);
        setQuestionError("");
        return;
      }
      question = { ...question, questions: normalized };
    }
    setPendingQuestion(question);
    setQuestionSubmitting(false);
    setQuestionError("");
  }
  function answerQuestion(answers: string[][]) {
    const question = pendingQuestion();
    if (!question || !opts.isOpen() || questionSubmitting()) return;
    setQuestionSubmitting(true);
    setQuestionError("");
    opts.send({ type: "question_response", sessionId: opts.getSessionId(), questionId: question.id, answers });
  }
  // Live usage per session (from daemon usage/turn_end events).
  const [sessionUsage, setSessionUsage] = createSignal<Record<string, SessionUsage>>({});
  /** Usage of the active session, or null — keeps "" session ids out of the union. */
  const activeUsage = createMemo<SessionUsage | null>(() => {
    const id = opts.getSessionId();
    return id ? (sessionUsage()[id] ?? null) : null;
  });
  const [sessionContexts, setSessionContexts] = createSignal<Record<string, SessionContext | null>>({});
  // Live tool progress text per tool call id (cleared on result/turn_end).
  const [toolStarts, setToolStarts] = createSignal<Record<string, number>>({});
  const [toolProgress, setToolProgress] = createSignal<Record<string, string>>({});
  const [toolOpen, setToolOpen] = createSignal<Record<string, boolean>>({});
  const [toolGroupOpen, setToolGroupOpen] = createSignal<Record<string, boolean>>({});
  function toggleToolOpen(key: string) {
    setToolOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }
  function toggleToolGroup(key: string) {
    setToolGroupOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }
  // Expanded thinking blocks: reasoning never starts open by itself —
  // the exception is the live one (auto-opens while it streams, then keeps
  // the user's toggle state after it ends).
  const [expandedThinking, setExpandedThinking] = createSignal<Record<string, boolean>>({});
  // Copied-message feedback.
  const [copiedMsgId, setCopiedMsgId] = createSignal<string | null>(null);
  function copyMsg(id: string, text: string) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    copyWithToast(trimmed);
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1500);
  }

  // Live thinking timer (chatbot thinkingElapsed). thinkingIndex tracks
  // WHICH reasoning block of the live assistant message the timer belongs
  // to, so the clock + ticking dots stick to the right panel when one
  // message carries several thinkings.
  const [thinkingStart, setThinkingStart] = createSignal<number | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0);
  const [thinkingIndex, setThinkingIndex] = createSignal(0);
  let thinkingTimer: any = null;
  function startThinkingTimer(startedAt = Date.now()) {
    stopThinkingTimer();
    setThinkingStart(startedAt);
    setThinkingElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    thinkingTimer = setInterval(() => {
      const s = thinkingStart();
      if (s) setThinkingElapsed(Math.floor((Date.now() - s) / 1000));
    }, 1000);
  }
  function stopThinkingTimer(): number {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    const s = thinkingStart();
    const d = s ? Math.floor((Date.now() - s) / 1000) : 0;
    setThinkingStart(null);
    setThinkingElapsed(0);
    return d;
  }
  onCleanup(() => stopThinkingTimer());

  // Inline message editing (chatbot editingMessageIndex).
  const [editingMsgIdx, setEditingMsgIdx] = createSignal<number | null>(null);
  const [editingMsgText, setEditingMsgText] = createSignal("");

  // Scroll / viewport
  const [isAtBottom, setIsAtBottom] = createSignal(true);
  const [chatContainerRef, setChatContainerRef] = createSignal<HTMLDivElement | null>(null);
  const [chatContentRef, setChatContentRef] = createSignal<HTMLDivElement | null>(null);
  const transcriptScroll = createTranscriptScroll({
    element: chatContainerRef,
    running: () => sessionStatus() === "running",
    atBottom: setIsAtBottom,
  });
  createEffect(() => {
    const content = chatContentRef();
    if (!content) return;
    const observer = new ResizeObserver(() => transcriptScroll.schedule());
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => transcriptScroll.dispose());
  function scrollToBottom(force = false) { transcriptScroll.schedule(force); }
  /** Explicit "Pin at bottom": jump to the tail and follow streaming again. */
  function pinAtBottom() { transcriptScroll.pin(); }

  // Render blocks (reconciled store to preserve DOM identity across deltas)
  const [renderState, setRenderState] = createStore<{ blocks: (RenderBlock & { id: string })[] }>({ blocks: [] });
  createEffect(() => {
    const hide = opts.isHideToolMessages ? opts.isHideToolMessages() : true;
    const blocks = buildRenderBlocks(messages(), { hideToolMessages: hide }).map((block) => ({ ...block, id: block.msg.id }));
    setRenderState("blocks", reconcile(blocks));
  });
  const renderBlocks = () => renderState.blocks;

  /**
   * Transcript window: only the newest WINDOW_BLOCKS render. Scrolling near
   * the top ("load older") grows the window by WINDOW_STEP; switching
   * sessions or receiving a fresh full transcript resets it. Solid's <For>
   * only creates DOM for the slice, so a 500-message session mounts ~10
   * bubbles until the reader scrolls up.
   */
  const WINDOW_BLOCKS = 10;
  const WINDOW_STEP = 20;
  const [windowSize, setWindowSize] = createSignal(WINDOW_BLOCKS);
  const visibleBlocks = () => {
    const all = renderState.blocks;
    return all.length <= windowSize() ? all : all.slice(all.length - windowSize());
  };
  const hiddenCount = () => Math.max(0, renderState.blocks.length - windowSize());
  function growWindow() {
    setWindowSize((n) => Math.min(n + WINDOW_STEP, renderState.blocks.length));
  }
  function resetWindow() {
    setWindowSize(WINDOW_BLOCKS);
  }
  function onChatScroll() {
    transcriptScroll.measure();
    const el = chatContainerRef();
    if (el && el.scrollTop < 400 && hiddenCount() > 0) growWindow();
  }
  // While a turn streams and the reader follows the tail, keep the window
  // pinned to the newest blocks (otherwise fresh units would render outside
  // the slice and appear stuck).
  createEffect(() => {
    if (sessionStatus() === "running" && isAtBottom()) {
      setWindowSize((n) => Math.max(n, renderState.blocks.length));
    }
  });

  // Rendered position → raw daemon transcript index (normalization merges
  // tool envelopes, so naive For indices mismatch the raw array).
  function rawIdx(idx: number): number {
    return messages()[idx]?.srcIdx ?? idx;
  }
  /** Raw daemon index of a render block's lead message. */
  function blockRawIdx(block: RenderBlock): number {
    const i = messages().findIndex((msg) => msg.id === block.msg.id);
    return i >= 0 ? i : 0;
  }

  /** Newest in-flight tool progress line inside a series (spinner sidecar). */
  function specialProgress(units: ToolUnit[]): string | undefined {
    for (let i = units.length - 1; i >= 0; i--) {
      const id = units[i].call?.toolId;
      const t = id ? toolProgress()[id] : undefined;
      if (t) return t;
    }
    return undefined;
  }

  // --- Session fetch (get_session with dedicated requestId) ---
  let transcriptRequestId = "";
  let initialScrollSession = "";
  function fetchSession(sessionId: string) {
    transcriptRequestId = crypto.randomUUID();
    opts.send({ type: "get_session", sessionId, requestId: transcriptRequestId });
  }
  /** Marks the session whose next full snapshot triggers initial scroll. */
  function beginLoad(sessionId: string) {
    initialScrollSession = sessionId;
  }
  function applySessionContent(sessionId: string, rawMsgs: any[], compaction?: any) {
    setMessages(normalizeSessionMessages(rawMsgs));
    if (compaction !== undefined) {
      setSessionCompaction(compaction);
    }
    if (initialScrollSession === sessionId) {
      initialScrollSession = "";
      scrollToBottom(true);
    } else {
      scrollToBottom();
    }
  }
  function applyUsage(sessionId: string, u: any, cum: any) {
    setSessionUsage((prev) => mergeUsage(prev, sessionId, u, cum));
  }

  /** Transcript-owned block of the session_data event (model/options live in
   * the options domain; workspace in the workspace domain — the page composes). */
  function applySnapshot(sid: string, r: any) {
    if (r.workspace) setWorkspaceSnapshot(r.workspace);
    setSessionStatus(r.status === "running" ? "running" : "idle");
    setSessionCompaction(r.compaction ?? null);
    setTurnActivity(r.turn || null);
    setTurnClock(Date.now());
    setTodos(r.todos || []);
    if (typeof r.todosOpen === "boolean") applyTodosOpenFromRemote(r.todosOpen);
    const em = r.editingMsg;
    if (em && typeof em.index === "number") {
      applyEditingMsgFromRemote(em.index, em.text || "");
    } else {
      applyEditingMsgFromRemote(null, "");
    }
    showQuestion(r.question || null);
    setToolProgress(r.toolProgress || {});
    setToolStarts(r.toolStarts || {});
    setPendingApproval(r.pendingApproval ? { ...r.pendingApproval, args: prettyArgs(r.pendingApproval.args) } : null);
    if (r.thinkingStartedAt && r.status === "running") startThinkingTimer(r.thinkingStartedAt);
    else stopThinkingTimer();
    if (r.usage) applyUsage(sid, r.usage, null);
    setSessionContexts((prev) => ({ ...prev, [sid]: r.context ?? null }));
    applySessionContent(sid, r.messages || r.Messages || [], r.compaction);
  }

  // Point-in-time workspace received in the snapshot — redirected by the page via
  // setWorkspaceSink (avoids coupling the transcript to the workspace domain).
  let workspaceSink: ((w: any) => void) | null = null;
  function setWorkspaceSink(fn: (w: any) => void) {
    workspaceSink = fn;
  }
  function setWorkspaceSnapshot(w: any) {
    workspaceSink?.(w);
  }

  function stampThinkingDuration(dur: number) {
    setMessages((prev) => stampDuration(prev, dur));
  }
  function appendStreamingDelta(delta: string) {
    setMessages((prev) => reduceTextDelta(prev, delta));
  }
  function appendReasoningDelta(delta: string) {
    if (!delta) return;
    if (thinkingStart() === null) startThinkingTimer();
    setMessages((prev) => reduceReasoningDelta(prev, delta));
    // The live clock/ticks belong to this message's first reasoning block.
    setThinkingIndex(0);
  }
  function appendToolCall(callId: string, name: string, args: any) {
    setMessages((prev) => reduceToolCall(prev, callId, name, args));
  }
  function appendToolArgsDelta(callId: string, delta: string) {
    if (!delta) return;
    setMessages((prev) => reduceToolArgs(prev, callId, delta));
  }
  function appendToolResult(callId: string, result: string | undefined, isError?: boolean, startedAt?: number, durationMs?: number, details?: any) {
    setMessages((prev) => reduceToolResult(prev, callId, result, isError, startedAt, durationMs, details));
  }
  // Drop rendered messages below a raw keep-index (optimistic edit/regen cut).
  function cutLiveTail(keepRawIdx: number) {
    setMessages((prev) => cutTail(prev, keepRawIdx));
    showQuestion(null);
  }

  function cancelTurnForSession(sessionId: string, e?: MouseEvent | KeyboardEvent) {
    e?.stopPropagation();
    if (!sessionId || !opts.isOpen()) return;
    opts.send({ type: "cancel", sessionId });
    if (sessionId === opts.getSessionId()) {
      setTurnActivity((turn) => turn ? { ...turn, status: "cancelling" } : null);
      stopThinkingTimer();
      transcriptScroll.detach();
    }
  }
  function cancelCurrentTurn() {
    cancelTurnForSession(opts.getSessionId());
  }
  function respondApproval(approved: boolean, always = false) {
    const p = pendingApproval();
    if (!p || !opts.getSessionId()) return;
    opts.send({
      type: "tool_approval_response",
      sessionId: opts.getSessionId(),
      callId: p.callId,
      approved,
      always,
    });
    setPendingApproval(null);
  }

  const [forking, setForking] = createSignal(false);
  let forkRequestId = "";
  function forkMessage(block: RenderBlock) {
    if (!opts.getSessionId() || !opts.isOpen() || forking()) return;
    const last = block.kind === "series" ? block.extras.at(-1) || block.msg : block.msg;
    if (last.srcIdx == null) return;
    forkRequestId = crypto.randomUUID();
    setForking(true);
    opts.send({ type: "fork_session", sessionId: opts.getSessionId(), index: last.srcIdx, requestId: forkRequestId });
  }
  // Regenerate from message idx: the daemon drops that message and everything
  // after it, then re-runs the turn (chatbot regenerateMessage semantics).
  // Offers fork-vs-resend: fork preserves the current timeline in a copy.
  async function regenerateMsg(idx: number, getModel: () => string, getYolo: () => boolean) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    if (sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }
    const choice = await opts.showChoice({
      title: "Regenerate response?",
      message: "Everything from this point down will be discarded and the turn re-runs from the previous user message.\n\nFork keeps the current timeline in a copy and regenerates there instead.",
      options: [
        { id: "resend", label: "Discard & regenerate", hint: "Discards the tail and resends here", primary: true },
        { id: "fork", label: "Fork & regenerate", hint: "Preserves here, regenerates in a copy" },
      ],
    });
    if (!choice) return;
    if (choice === "fork") {
      forkRequestId = crypto.randomUUID();
      setForking(true);
      opts.send({ type: "fork_session", sessionId: sid, index: rawIdx(idx), requestId: forkRequestId });
      return;
    }
    // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated).
    cutLiveTail(rawIdx(idx) - 1);
    opts.send({ type: "regenerate", sessionId: sid, index: rawIdx(idx), model: getModel(), yolo: getYolo() });
  }
  let editMsgTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSentEditIdx: number | null = null;
  let lastSentEditText = "";
  const recentSentEdits = new Map<string, number>();
  let lastStartedEditAt = 0;
  let lastClosedEditAt = 0;

  function purgeRecentSentEdits() {
    const now = Date.now();
    for (const [key, time] of recentSentEdits.entries()) {
      if (now - time > 10000) recentSentEdits.delete(key);
    }
  }

  function flushPendingEdit() {
    if (editMsgTimer) {
      clearTimeout(editMsgTimer);
      editMsgTimer = undefined;
      const sid = opts.getSessionId();
      const idx = editingMsgIdx();
      const text = editingMsgText();
      if (sid && idx != null && opts.isOpen()) {
        lastSentEditIdx = idx;
        lastSentEditText = text;
        recentSentEdits.set(`${idx}:${text}`, Date.now());
        opts.send({ type: "set_editing_msg", sessionId: sid, index: idx, text });
      }
    }
  }

  function syncEditingMsg(sid: string, idx: number | null, text: string) {
    clearTimeout(editMsgTimer);
    if (!opts.isOpen()) return;
    if (idx == null) {
      lastSentEditIdx = null;
      lastSentEditText = "";
      opts.send({ type: "set_editing_msg", sessionId: sid, index: null, text: "" });
      return;
    }
    editMsgTimer = setTimeout(() => {
      if (opts.isOpen()) {
        lastSentEditIdx = idx;
        lastSentEditText = text;
        recentSentEdits.set(`${idx}:${text}`, Date.now());
        purgeRecentSentEdits();
        opts.send({ type: "set_editing_msg", sessionId: sid, index: idx, text });
      }
    }, 350);
  }
  onCleanup(() => clearTimeout(editMsgTimer));

  function applyEditingMsgFromRemote(idx: number | null, text: string) {
    const currentIdx = editingMsgIdx();
    const currentText = editingMsgText();

    const isFocused = typeof document !== "undefined" && document.activeElement?.id === "rc-editing-msg";

    if (idx == null) {
      if (currentIdx == null) return;
      // If user is actively typing in the editing textarea, do not close edit mode
      if (isFocused) return;
      // If user just started editing on this device, suppress stale pre-edit nulls
      if (Date.now() - lastStartedEditAt < 2000) return;

      lastSentEditIdx = null;
      lastSentEditText = "";
      setEditingMsgIdx(null);
      setEditingMsgText("");
      return;
    }

    // Suppress reopening if recently closed on this device
    if (currentIdx == null && Date.now() - lastClosedEditAt < 2000) return;

    // If identical, nothing to do
    if (idx === currentIdx && text === currentText) return;

    // If actively focused, local typing has authority: do not overwrite
    if (isFocused) {
      if (idx === currentIdx) return;
      return;
    }

    // Echo suppression
    purgeRecentSentEdits();
    if (idx === lastSentEditIdx && (text === lastSentEditText || recentSentEdits.has(`${idx}:${text}`))) {
      return;
    }

    // Monotonic prefix guard: if same message and local text already starts with remote and is longer
    if (idx === currentIdx && currentText.startsWith(text) && currentText.length > text.length) {
      return;
    }

    lastSentEditIdx = idx;
    lastSentEditText = text;
    setEditingMsgIdx(idx);
    setEditingMsgText(text);
  }

  // Inline edit (chatbot startEditMessage): user edits resubmit, assistant
  // edits just save.
  function startEditMsg(idx: number, m: ChatMessage) {
    lastStartedEditAt = Date.now();
    setEditingMsgIdx(idx);
    const text = messageText(m);
    setEditingMsgText(text);
    lastSentEditIdx = idx;
    lastSentEditText = text;
    recentSentEdits.set(`${idx}:${text}`, Date.now());
    const sid = opts.getSessionId();
    if (sid && opts.isOpen()) {
      opts.send({ type: "set_editing_msg", sessionId: sid, index: idx, text });
    }
  }
  function updateEditingMsgText(text: string) {
    setEditingMsgText(text);
    const sid = opts.getSessionId();
    const idx = editingMsgIdx();
    if (sid && idx != null) {
      syncEditingMsg(sid, idx, text);
    }
  }
  function cancelEditMsg() {
    clearTimeout(editMsgTimer);
    editMsgTimer = undefined;
    lastClosedEditAt = Date.now();
    const sid = opts.getSessionId();
    if (sid && opts.isOpen() && editingMsgIdx() != null) {
      opts.send({ type: "set_editing_msg", sessionId: sid, index: null, text: "" });
    }
    lastSentEditIdx = null;
    lastSentEditText = "";
    setEditingMsgIdx(null);
    setEditingMsgText("");
  }
  async function saveEditMsg(idx: number, m: ChatMessage, getModel: () => string, getYolo: () => boolean) {
    const sid = opts.getSessionId();
    const text = editingMsgText().trim();
    if (!sid || !opts.isOpen()) {
      cancelEditMsg();
      return;
    }
    if (!text) {
      opts.toast("Message cannot be empty", "err");
      return;
    }
    const regen = m.role === "user";
    if (regen && sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }
    if (regen) {
      const choice = await opts.showChoice({
        title: "Resend edited message?",
        message: "Everything from this message down will be discarded and the turn re-runs with your edited text.\n\nFork keeps the current timeline in a copy and resends there instead.",
        options: [
          { id: "resend", label: "Discard & resend", hint: "Discards the tail and resends here", primary: true },
          { id: "fork", label: "Fork & resend", hint: "Preserves here, resends in a copy" },
        ],
      });
      if (!choice) return;
      if (choice === "fork") {
        // Fork at this message carrying the edited text: the daemon
        // applies it to the boundary user message and resends from there.
        forkRequestId = crypto.randomUUID();
        setForking(true);
        opts.send({ type: "fork_session", sessionId: sid, index: rawIdx(idx), requestId: forkRequestId, editText: text, editModel: getModel(), editYolo: getYolo() });
        cancelEditMsg();
        return;
      }
      // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated).
      cutLiveTail(rawIdx(idx));
    }
    opts.send({
      type: "edit_message",
      sessionId: sid,
      index: rawIdx(idx),
      text,
      model: getModel(),
      yolo: getYolo(),
      regenerate: regen,
    });
    cancelEditMsg();
    if (regen) setSessionStatus("running");
  }
  async function deleteMsg(idx: number) {
    const sid = opts.getSessionId();
    if (!sid || !opts.isOpen()) return;
    const ok = await opts.showConfirm({
      title: "Delete message?",
      message: "This message will be permanently deleted from the transcript.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) opts.send({ type: "delete_message", sessionId: sid, index: rawIdx(idx) });
  }

  // --- Daemon events (called by the page dispatcher) ---
  function noteSessionDataRequestGuard(requestId: string | undefined): boolean {
    if (requestId && requestId !== transcriptRequestId) return true;
    return false;
  }
  function handleTruncated(sessionId: string | undefined, keep: number) {
    // Authoritative tail cut after edit/regenerate (daemon broadcast).
    // keepIndex is the last RAW message to keep; drop rendered messages
    // whose srcIdx exceeds it, then let the following session_content
    // (or the new turn) repaint.
    if (sessionId !== opts.getSessionId()) return;
    if (keep >= 0) {
      setMessages((prev: ChatMessage[]) => {
        const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keep);
        return cut < 0 ? prev : prev.slice(0, cut);
      });
      showQuestion(null);
    }
  }
  function handleStatusEvent(msg: SessionStatusEvent) {
    // Composer responsiveness only (stop button state) — the collections
    // get the same truth via the sessions change ping.
    if (msg.sessionId === opts.getSessionId()) {
      setSessionStatus(msg.status === "running" ? "running" : "idle");
      if (msg.turn) setTurnActivity(msg.turn);
      if (msg.status === "idle") {
        showQuestion(null);
        setTurnActivity((turn) => finishTurn(turn));
        opts.onTurnIdle();
        setPendingApproval(null);
        setToolProgress({}); setToolStarts({});
        if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      }
    }
  }
  function handleAgentEvent(sessionId: string, ev: AgentEvent | undefined) {
    if (!ev) return;
    if (ev.type === "turn_start") {
      setSessionStatus("running");
      setTurnActivity((turn) => !turn || turn.endedAt ? { startedAt: Date.now(), status: "running" } : turn);
    } else if (ev.type === "todo_update") {
      setTodos(ev.items || []);
    } else if (ev.type === "assistant_message") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages((prev) => mergeAssistantMessage(prev, ev));
    } else if (ev.type === "assistant_start") {
      // Each model step gets its own carrier. Tool loops cannot merge new
      // thinking into the previous assistant response.
      setMessages((prev) => pushAssistantCarrier(prev));
    } else if (ev.type === "text_delta") {
      // First content chunk freezes the thinking clock (chatbot-style).
      if (thinkingStart() !== null) {
        const dur = stopThinkingTimer();
        stampThinkingDuration(dur);
      }
      appendStreamingDelta(ev.delta);
    } else if (ev.type === "reasoning_delta") {
      appendReasoningDelta(ev.delta || "");
    } else if (ev.type === "tool_use_start") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      // Pre-render a live "composing call" card while args stream in.
      appendToolCall(ev.id, ev.name, "");
    } else if (ev.type === "tool_use_args") {
      appendToolArgsDelta(ev.id, ev.delta);
    } else if (ev.type === "tool_use_end") {
      // No-op: the final tool_call event carries the full block.
    } else if (ev.type === "tool_execution_start") {
      setToolStarts((prev) => ({ ...prev, [ev.id]: ev.startedAt }));
    } else if (ev.type === "tool_progress") {
      setToolProgress((prev) => ({ ...prev, [ev.id]: ((prev[ev.id] || "") + (ev.text || "")).slice(-65536) }));
    } else if (ev.type === "tool_call") {
      appendToolCall(ev.id, ev.name, ev.args);
    } else if (ev.type === "tool_result") {
      setPendingApproval(null);
      setToolProgress((prev) => {
        const next = { ...prev };
        delete next[ev.id];
        return next;
      });
      appendToolResult(ev.id, ev.result ?? ev.content, ev.isError, ev.startedAt, ev.durationMs, ev.details);
      setToolStarts((prev) => { const next = { ...prev }; delete next[ev.id]; return next; });
    } else if (ev.type === "usage") {
      applyUsage(sessionId, ev.usage, ev.cumulative);
      const uctx = ev.context;
      if (uctx) {
        setSessionContexts((prev) => ({ ...prev, [sessionId]: uctx }));
        opts.onUsageContext(uctx);
      }
    } else if (ev.type === "compact_progress") {
      if (ev.text === "Compacting older context…") opts.toast(ev.text, "ok");
    } else if (ev.type === "turn_end") {
      // This ends one model call; tools and subsequent steps may still run.
      if (thinkingStart() !== null) {
        const dur = stopThinkingTimer();
        stampThinkingDuration(dur);
      }
      if (ev.usage || ev.cumulative) applyUsage(sessionId, ev.usage, ev.cumulative);
      if (ev.cancelled || ev.stop === "aborted" || /context cancel(?:led|ed)/i.test(ev.error || "")) {
        showQuestion(null);
        setTurnActivity((turn) => turn ? { ...turn, status: "cancelled", endedAt: Date.now() } : null);
        setPendingApproval(null);
      } else if (ev.error) opts.toast(ev.error, "err");
      // The daemon sends the final snapshot and idle status after the task.
    } else if (ev.type === "done") {
      // Compatibility with daemons that predate final session snapshots.
      fetchSession(sessionId);
    } else if (ev.type === "error") {
      opts.toast(ev.message || "Agent error", "err");
      setSessionStatus("idle");
    }
    scrollToBottom();
  }
  /** tool_approval_request event (with session guard). */
  function noteApprovalRequest(msg: ToolApprovalRequestEvent) {
    if (msg.sessionId === opts.getSessionId()) {
      setPendingApproval({
        callId: msg.callId,
        tool: msg.tool,
        args:
          typeof msg.args === "string"
            ? msg.args
            : JSON.stringify(msg.args, null, 2),
      });
    }
  }
  /** question_resolved event (with session/question guard). */
  function noteQuestionResolved(sessionId: string | undefined, questionId: string) {
    if (sessionId === opts.getSessionId() && pendingQuestion()?.id === questionId) showQuestion(null);
  }
  /** question_error event (with session/question guard). */
  function noteQuestionError(sessionId: string | undefined, questionId: string, message: string | undefined) {
    if (sessionId === opts.getSessionId() && pendingQuestion()?.id === questionId) {
      setQuestionSubmitting(false);
      setQuestionError(message || "Could not submit answers");
    }
  }
  /** Session switch reset (remaining items — review/options/composer — are
   * cleaned up by their own domains; the page orchestrates).
   */
  function resetForSession() {
    flushPendingEdit();
    setTurnActivity(null); setTodos([]); setToolProgress({}); setToolStarts({});
    showQuestion(null);
    transcriptScroll.reset();
    resetWindow();
    setMessages([]);
    setSessionCompaction(null);
    setSessionStatus("idle");
    setPendingApproval(null);
    clearTimeout(editMsgTimer);
    editMsgTimer = undefined;
    lastSentEditIdx = null;
    lastSentEditText = "";
    setEditingMsgIdx(null);
    setEditingMsgText("");
    stopThinkingTimer();
  }
  /** Clears per-session caches when switching hosts (different daemon). */
  function resetCaches() {
    setSessionUsage({});
    setSessionContexts({});
  }
  /** Cleans up leftovers of sessions removed from the mirror (usage). */
  function purgeSession(sessionId: string) {
    setSessionUsage((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }
  function clearQuestion() {
    showQuestion(null);
  }
  function clearMessages() {
    setMessages([]);
    setSessionCompaction(null);
  }
  /** Optimistic user bubble (composer, before daemon ack). */
  function pushUserMessage(msg: ChatMessage) {
    setMessages((prev) => [...prev, msg]);
  }
  /** Marks turn start in composer (status + activity + tail). */
  function beginTurn() {
    setSessionStatus("running");
    // Sending a message re-engages the pin: the reader expects to follow
    // their own turn even while reading further up.
    transcriptScroll.reset();
    setIsAtBottom(true);
    setTurnActivity({ startedAt: Date.now(), status: "running" });
  }

  return {
    // state
    messages, sessionStatus, setSessionStatus, turnActivity, setTurnActivity,
    todos, setTodos, todosOpen, setTodosOpen, toggleTodosOpen, applyTodosOpenFromRemote, turnClock, turnLabel,
    sessionCompaction, setSessionCompaction,
    pendingApproval, setPendingApproval, pendingQuestion,
    questionSubmitting, questionError, showQuestion, clearQuestion, answerQuestion,
    sessionUsage, activeUsage, sessionContexts, setSessionContexts,
    toolStarts, setToolStarts, toolProgress, setToolProgress,
    toolOpen, toolGroupOpen, toggleToolOpen, toggleToolGroup,
    expandedThinking, setExpandedThinking,
    copiedMsgId, copyMsg,
    thinkingStart, thinkingElapsed, thinkingIndex,
    startThinkingTimer, stopThinkingTimer,
    editingMsgIdx, setEditingMsgIdx, editingMsgText, setEditingMsgText, updateEditingMsgText, applyEditingMsgFromRemote, flushPendingEdit,
    isAtBottom, setIsAtBottom,
    chatContainerRef, setChatContainerRef, chatContentRef, setChatContentRef,
    transcriptScroll, scrollToBottom, pinAtBottom, onChatScroll,
    renderBlocks, visibleBlocks, hiddenCount, growWindow, resetWindow,
    rawIdx, blockRawIdx, specialProgress,
    // session
    fetchSession, beginLoad, applySessionContent, applyUsage, applySnapshot,
    setWorkspaceSink, noteSessionDataRequestGuard,
    handleTruncated, handleStatusEvent, handleAgentEvent,
    noteApprovalRequest, noteQuestionResolved, noteQuestionError,
    stampThinkingDuration, appendStreamingDelta, appendReasoningDelta,
    appendToolCall, appendToolArgsDelta, appendToolResult, cutLiveTail,
    cancelTurnForSession, cancelCurrentTurn, respondApproval,
    forking, forkRequestId: () => forkRequestId,
    clearForkRequest: () => { forkRequestId = ""; }, setForking,
    forkMessage, regenerateMsg, startEditMsg, cancelEditMsg, saveEditMsg, deleteMsg,
    resetForSession, resetCaches, purgeSession, pushUserMessage, beginTurn,
    clearMessages,
  };
}

export type Transcript = ReturnType<typeof createTranscript>;
