import type { DaemonCommand } from "../daemon-protocol";
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { copyWithToast } from "../../ui";
import { clearToolScrolls } from "../utils/scrollMemory";
import { createTranscriptScroll } from "../scroll";
import { createRenderBlockBuilder, latestShortTurnMessage } from "../transcript";
import { elapsedLabel, messageText } from "../utils/format";
import { prettyArgs } from "../utils/wire";import {
  appendReasoningDelta as reduceReasoningDelta,
  appendTextDelta as reduceTextDelta,
  appendToolArgsDelta as reduceToolArgs,
  appendToolResult as reduceToolResult,
  cutTail,
  finishTurn,
  foldBackgroundResult as reduceFoldBackground,
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
import { createAttachmentDraft } from "./useAttachmentDraft";
import { createMentions } from "./useMentions";
import type { StoredAttachment, TodoItem, TurnActivity } from "../viewTypes";

/** Transcript domain: messages, turn state, thinking, live tools,
 * scroll, render blocks, and per-message ops (extracted verbatim from RemoteCodePage —
 * only the source of collaborators changes: passed via params). */
export function createTranscript(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getHostId: () => string;
  getProjectId?: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
  showChoice: (o: { title: string; message: string; options: { id: string; label: string; hint?: string; primary?: boolean }[] }) => Promise<string | null>;
  /** Turn became idle: the page refreshes the review. */
  onTurnIdle: () => void;
  /** Context received in usage: the page compares it with the catalog. */
  onUsageContext: (ctx: SessionContext) => void;
  onDiscardResendOrRegenerate?: (sessionId: string) => void;
  onForkKind?: (kind: "resend" | "regenerate" | "fork") => void;
}) {
  const [editingAttachments, setEditingAttachments] = createSignal<StoredAttachment[]>([]);
  const editAttachments = createAttachmentDraft({ ...opts, additionalCount: () => editingAttachments().length });
  const [savingEdit, setSavingEdit] = createSignal(false);
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
  /** Last short assistant text of the running turn (single-line hint). */
  const turnHint = createMemo(() => {
    if (turnActivity()?.status !== "running" || sessionStatus() !== "running") return "";
    return latestShortTurnMessage(messages());
  });
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);
  const [pendingQuestion, setPendingQuestion] = createSignal<PendingQuestion | null>(null);
  const [questionSubmitting, setQuestionSubmitting] = createSignal(false);
  const [questionError, setQuestionError] = createSignal("");
  function showQuestion(question: PendingQuestion | null) {
    if (question && pendingQuestion()?.id === question.id) return;
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
    if (question) scrollToBottom(true);
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
    // Monotonic: never rewind a running clock. Snapshots re-send the
    // daemon's thinkingStartedAt on every pull; restarting here reset the
    // visible count back to 0s and the trailing stop then stamped ~0 over
    // the real duration. A null clock (fresh load, new phase) starts.
    if (thinkingStart() !== null) return;
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

  // Keep ingesting ordered state while hidden, but derive the view only once
  // on return. There is no backlog of per-token DOM work to replay.
  const [pageVisible, setPageVisible] = createSignal(!document.hidden);
  const onVisibility = () => setPageVisible(!document.hidden);
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));

  // Render blocks (reconciled store to preserve DOM identity across deltas)
  const buildRenderBlocks = createRenderBlockBuilder();
  const [renderState, setRenderState] = createStore<{ blocks: (RenderBlock & { id: string })[] }>({ blocks: [] });
  createEffect(() => {
    if (!pageVisible()) return;
    const blocks = buildRenderBlocks(messages()).map((block) => ({ ...block, id: block.msg.id }));
    setRenderState("blocks", reconcile(blocks, { merge: true }));
  });
  const renderBlocks = () => renderState.blocks;

  /**
   * Sealed history blocks: the daemon ships whole turns per page
   * (get_session tail + get_history pages), and the frontend renders
   * whole sealed blocks — never a slice cut mid-block. Each entry notes
   * its turn range [oldestTurn, newestTurn] plus whether the daemon said
   * more exists below (hasOlder at seal time). Block seams always fall
   * on turn boundaries, so balloons (keyed by TurnIndex) can never land
   * on the wrong turn.
   *
   * The live tail (streaming turn + anything appended after the last
   * seal) renders above the seals and is NOT a block: it grows until
   * the next snapshot/page seals it. Solid's <For> only creates DOM for
   * sealed blocks + tail, so a huge session mounts a few dozen bubbles.
   */
  interface SealedBlock {
    oldestTurn: number;
    newestTurn: number;
    /** First raw message index of the block (srcIdx base). */
    firstIndex: number;
    /** Message count at seal time (detects tail growth). */
    msgCount: number;
    /** hasOlder reported by the daemon when this block was sealed. */
    hasOlderBelow: boolean;
  }
  const [sealedBlocks, setSealedBlocks] = createSignal<SealedBlock[]>([]);
  /** Turn-anchored render budget: how many NEWEST sealed blocks render.
   * Grows by whole blocks only (never +N bubbles mid-block). */
  const [sealedBudget, setSealedBudget] = createSignal(1);
  // Server-driven history pagination (turn blocks): the daemon sends the
  // tail block plus a cursor; older blocks arrive via get_history.
  // historyArmed starts FALSE so the initial top-scroll never auto-loads
  // (the button shows first; the first click arms scroll loading).
  const [historyCursor, setHistoryCursor] = createSignal<{ oldestTurn: number; hasOlder: boolean; totalTurns: number } | null>(null);
  const [historyArmed, setHistoryArmed] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  /**
   * Visible seals: the newest `sealedBudget` sealed blocks, by turn.
   * Messages are filtered to the visible turn range — the live tail
   * (anything past the newest seal) always renders. When nothing is
   * sealed yet (small session, pre-pagination), everything renders.
   */
  const visibleTurnFloor = () => {
    const seals = sealedBlocks();
    if (seals.length === 0) return 0;
    const show = seals.slice(Math.max(0, seals.length - sealedBudget()));
    if (show.length === 0) return 0;
    return show[0].oldestTurn;
  };
  const visibleBlocks = () => {
    const floor = visibleTurnFloor();
    if (floor <= 0) return renderState.blocks;
    return renderState.blocks.filter((b) => {
      const t = typeof b.msg.turnIndex === "number" && b.msg.turnIndex > 0 ? b.msg.turnIndex : 0;
      // Unstamped (turn 0) system notices ride with the tail — always show.
      // Stamped blocks below the floor belong to hidden seals.
      // Blocks ABOVE the newest seal (live tail) always show.
      if (t <= 0) return true;
      const seals = sealedBlocks();
      const newestSealTop = seals.length > 0 ? seals[seals.length - 1].newestTurn : 0;
      if (newestSealTop > 0 && t > newestSealTop) return true;
      return t >= floor;
    });
  };
  /** Sealed blocks not yet revealed (whole blocks, never bubbles). */
  const hiddenSeals = () => Math.max(0, sealedBlocks().length - sealedBudget());
  /** Reveal one more sealed block (whole turns, never mid-block). */
  function revealSeal() {
    setSealedBudget((n) => Math.min(n + 1, Math.max(1, sealedBlocks().length)));
  }
  /** Clear all seal notes (session switch / truncate): the next
   * snapshot or page re-seals from scratch. */
  function clearSeals() {
    setSealedBlocks([]);
    setSealedBudget(1);
  }
  function resetHistory() {
    setHistoryCursor(null);
    setHistoryArmed(false);
    setLoadingOlder(false);
    clearSeals();
  }
  /** Unified "load older": reveal one more sealed block, fetching it
   * first when the daemon holds older turns. Every click moves exactly
   * one whole-turn seal (the counter always moves while hasOlder). Once
   * everything is loaded AND revealed, the button hides. The first click
   * arms scroll loading until the session is switched. */
  function loadOlder() {
    // First manual request arms scroll-driven loading from here on.
    setHistoryArmed(true);
    if (historyHasOlder() && !loadingOlder()) {
      requestOlderHistory();
      return;
    }
    if (hiddenSeals() > 0) {
      revealSeal();
      return;
    }
    // Nothing revealed-pending and daemon says more exists (cursor race
    // after truncate): fetch it.
    requestOlderHistory();
  }
  const historyHasOlder = () => historyCursor()?.hasOlder ?? false;
  /** Oldest turn loaded locally (pagination frontier for balloons).
   * 0 when no cursor (full transcript) — everything renders. */
  const historyOldestTurn = () => historyCursor()?.oldestTurn ?? 0;
  const historyHiddenTurns = () => {
    const cur = historyCursor();
    if (!cur || !cur.hasOlder) return 0;
    return Math.max(0, cur.oldestTurn - 1);
  };
  /** Ask the daemon for the next older turn block (cursor = oldest known turn). */
  function requestOlderHistory() {
    const sid = opts.getSessionId();
    const cur = historyCursor();
    if (!sid || !cur || !cur.hasOlder || cur.oldestTurn <= 0 || loadingOlder()) return;
    setLoadingOlder(true);
    opts.send({ type: "get_history", sessionId: sid, beforeTurn: cur.oldestTurn });
  }
  /** Seal a daemon block: note its turn range + raw base. Duplicate
   * seals (same oldestTurn) are ignored — retries never double-note. */
  function sealBlock(rawMsgs: any[], history: any) {
    if (!history || typeof history.oldestTurn !== "number") return;
    const oldestTurn = history.oldestTurn;
    const newestTurn = typeof history.newestTurn === "number" ? history.newestTurn : oldestTurn;
    const firstIndex = typeof history.firstIndex === "number" ? history.firstIndex : 0;
    setSealedBlocks((prev) => {
      if (prev.some((s) => s.oldestTurn === oldestTurn && s.newestTurn === newestTurn)) return prev;
      const next = [...prev, {
        oldestTurn, newestTurn, firstIndex,
        msgCount: Array.isArray(rawMsgs) ? rawMsgs.length : 0,
        hasOlderBelow: !!history.hasOlder,
      }];
      next.sort((a, b) => a.oldestTurn - b.oldestTurn);
      return next;
    });
  }
  /** Prepend one daemon history page, keeping the viewport anchored. */
  async function noteHistoryPage(rawMsgs: any[], history: any) {
    const base = typeof history?.firstIndex === "number" ? history.firstIndex : 0;
    const el = chatContainerRef();
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    const page = await normalizeAsync(rawMsgs, base);
    // Stale guard: the container detached (session switched) while the
    // worker ran — drop the page instead of splicing it anywhere.
    if (!el?.isConnected) {
      setLoadingOlder(false);
      return;
    }
    setMessages((prev) => {
      const known = new Set(prev.map((m) => m.id));
      return [...page.filter((m) => !known.has(m.id)), ...prev];
    });
    // Seal the arriving block (whole turns, newest last) and reveal
    // exactly it: budget +1 exposes this seal; older seals stay hidden
    // until further clicks. Seams always fall on turn boundaries.
    sealBlock(rawMsgs, history);
    setSealedBudget((n) => n + 1);
    if (history && typeof history.oldestTurn === "number") {
      setHistoryCursor({
        oldestTurn: history.oldestTurn,
        hasOlder: !!history.hasOlder,
        totalTurns: history.totalTurns ?? 0,
      });
    } else {
      setHistoryCursor((c) => (c ? { ...c, hasOlder: false } : c));
    }
    setLoadingOlder(false);
    // Anchor: the content above grew by (newHeight - prevHeight); shift
    // scrollTop by the same delta so the reader stays on the same bubble.
    if (el) {
      const grown = el.scrollHeight - prevHeight;
      if (grown > 0) el.scrollTop = prevTop + grown;
    }
  }
  function onChatScroll() {
    transcriptScroll.measure();
    const el = chatContainerRef();
    if (!el || el.scrollTop >= 400) return;
    // Button-first: nothing loads on scroll until the user opts in with
    // one click on the load-older button (arming resets on session
    // switch, like pin-at-bottom re-pinning). Without a click, scroll
    // does nothing — opening a session at the top never auto-loads.
    if (!historyArmed()) return;
    // Same rule as the button: fetch-then-reveal, one whole seal at a
    // time. Revealing a hidden seal needs no fetch.
    if (historyHasOlder()) {
      if (!loadingOlder()) requestOlderHistory();
      return;
    }
    if (hiddenSeals() > 0) {
      revealSeal();
      return;
    }
  }
  // The live tail always renders (no window to pin): streaming needs
  // no budget adjustment. Sealed blocks below stay as the reader left
  // them until "load older" reveals more.

  // Rendered position → raw daemon transcript index (normalization merges
  // tool envelopes, so naive For indices mismatch the raw array).
  function rawIdx(idx: number): number {
    return messages()[idx]?.srcIdx ?? idx;
  }
  /** Raw daemon index of a render block's lead message. */
  function blockRawIdx(block: RenderBlock): number {
    const i = messages().findIndex((msg) => msg.id === block.msg.id);
    return block.msg.srcIdx ?? (i >= 0 ? i : 0);
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

  // --- History worker (normalize off the main thread) ---
  // Pages/snapshots above this size go through the worker; small ones
  // stay synchronous (no postMessage round-trip overhead).
  const WORKER_MIN_MESSAGES = 50;
  let historyWorker: Worker | null = null;
  let historyWorkerSeq = 0;
  const historyWorkerWaiters = new Map<number, { resolve: (page: ChatMessage[]) => void; fallback: () => ChatMessage[] }>();
  function getHistoryWorker(): Worker | null {
    if (historyWorker) return historyWorker;
    try {
      // Served from dist/workers/history-worker.js (separate build
      // entry in build.ts); same-origin with the dashboard always.
      historyWorker = new Worker("workers/history-worker.js", { type: "module" });
      historyWorker.onmessage = (ev: MessageEvent<{ seq: number; page: ChatMessage[] }>) => {
        const w = historyWorkerWaiters.get(ev.data?.seq);
        if (w) {
          historyWorkerWaiters.delete(ev.data.seq);
          w.resolve(Array.isArray(ev.data.page) ? ev.data.page : []);
        }
      };
      historyWorker.onerror = () => {
        historyWorker?.terminate(); historyWorker = null;
        const waiters = [...historyWorkerWaiters.values()]; historyWorkerWaiters.clear();
        for (const waiter of waiters) waiter.resolve(waiter.fallback());
      };
    } catch {
      historyWorker = null;
    }
    return historyWorker;
  }
  /** Normalize via worker when large, synchronously when small/absent. */
  function normalizeAsync(rawMsgs: any[], indexBase: number): Promise<ChatMessage[]> | ChatMessage[] {
    const w = (rawMsgs?.length ?? 0) >= WORKER_MIN_MESSAGES ? getHistoryWorker() : null;
    if (!w) return normalizeSessionMessages(rawMsgs, [], indexBase);
    return new Promise((resolve) => {
      const seq = ++historyWorkerSeq;
      const fallback = () => normalizeSessionMessages(rawMsgs, [], indexBase);
      historyWorkerWaiters.set(seq, { resolve, fallback });
      try { w.postMessage({ seq, rawMsgs, indexBase }); }
      catch { historyWorkerWaiters.delete(seq); resolve(fallback()); }
    });
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
  let snapshotVersion = 0;
  let pendingSnapshot: { replay: (() => void)[] } | null = null;
  async function applySessionContent(sessionId: string, rawMsgs: any[], compaction?: any, history?: any) {
    const version = ++snapshotVersion;
    pendingSnapshot = null;
    const paged = history && typeof history.oldestTurn === "number";
    const base = paged && typeof history.firstIndex === "number" ? history.firstIndex : 0;
    const normalized = !paged && (rawMsgs?.length ?? 0) < WORKER_MIN_MESSAGES
      ? normalizeSessionMessages(rawMsgs, messages()) : normalizeAsync(rawMsgs, base);
    let tail: ChatMessage[];
    if (Array.isArray(normalized)) {
      // Small snapshots commit synchronously, before the next wire event.
      tail = normalized;
    } else {
      pendingSnapshot = { replay: [] };
      tail = await normalized;
    }
    if (version !== snapshotVersion || sessionId !== opts.getSessionId()) return;
    const replay = pendingSnapshot?.replay || [];
    pendingSnapshot = null;
    batch(() => {
      if (paged) {
        setMessages((prev) => {
          const ids = new Set(tail.map((m) => m.id));
          return [...prev.filter((m) => !ids.has(m.id)), ...tail];
        });
        sealBlock(rawMsgs, history);
        setSealedBudget((n) => Math.max(n, sealedBlocks().length));
      } else setMessages(tail);
      restoreEditDraft();
      if (compaction !== undefined) setSessionCompaction(compaction);
      // A worker snapshot must not overwrite deltas/status received while it
      // was normalizing. Replay only the events after this exact snapshot.
      for (const apply of replay) apply();
    });
    if (initialScrollSession === sessionId) {
      initialScrollSession = "";
      scrollToBottom(true);
    } else scrollToBottom();
  }
  onCleanup(() => {
    snapshotVersion++;
    pendingSnapshot = null;
    historyWorker?.terminate();
    for (const waiter of historyWorkerWaiters.values()) waiter.resolve([]);
    historyWorkerWaiters.clear();
  });
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
    if (r.history && typeof r.history.oldestTurn === "number") {
      setHistoryCursor({
        oldestTurn: r.history.oldestTurn,
        hasOlder: !!r.history.hasOlder,
        totalTurns: r.history.totalTurns ?? 0,
      });
    } else {
      setHistoryCursor(null);
    }
    setLoadingOlder(false);
    setTodos(r.todos || []);
    if (typeof r.todosOpen === "boolean") applyTodosOpenFromRemote(r.todosOpen);
    applySessionContent(sid, r.messages || r.Messages || [], r.compaction, r.history);
    showQuestion(r.question || null);
    setToolProgress(r.toolProgress || {});
    setToolStarts(r.toolStarts || {});
    setPendingApproval(r.pendingApproval ? { ...r.pendingApproval, args: prettyArgs(r.pendingApproval.args) } : null);
    if (r.thinkingStartedAt && r.status === "running") startThinkingTimer(r.thinkingStartedAt);
    else stopThinkingTimer();
    if (r.usage) applyUsage(sid, r.usage, null);
    setSessionContexts((prev) => ({ ...prev, [sid]: r.context ?? null }));

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
  /** Folds a finished background task into the originating tool row
   * (daemon bg_update snapshot → placeholder row). Idempotent. */
  function foldBgResult(job: { id: string; result?: string; status?: string; endedAt?: number }) {
    setMessages((prev) => reduceFoldBackground(prev, job));
  }
  // Drop rendered messages below a raw keep-index (optimistic edit/regen cut).
  function cutLiveTail(keepRawIdx: number) {
    setMessages((prev) => cutTail(prev, keepRawIdx));
    showQuestion(null);
  }

  function cancelTurnForSession(sessionId: string, e?: MouseEvent | KeyboardEvent) {
    e?.stopPropagation();
    if (!sessionId || !opts.isOpen()) return;
    // Stop-spam guard: the sidebar button already disables itself while
    // "cancelling", but the composer Stop button and keyboard paths
    // don't — and the daemon treats a second cancel as a no-op anyway.
    // Skip the duplicate send so an anxious double-click can't stack
    // redundant cancels behind a slow relay.
    if (sessionId === opts.getSessionId() && turnActivity()?.status === "cancelling") return;
    opts.send({ type: "cancel", sessionId });
    if (sessionId === opts.getSessionId()) {
      setTurnActivity((turn) => turn ? { ...turn, status: "cancelling" } : null);
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
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
    opts.onForkKind?.("fork");
    opts.send({ type: "fork_session", sessionId: opts.getSessionId(), index: last.srcIdx, requestId: forkRequestId });
  }
  // Regenerate from message idx: the daemon drops that message and everything
  // after it, then re-runs the turn (chatbot regenerateMessage semantics).
  // Offers fork-vs-resend: fork preserves the current timeline in a copy.
  async function regenerateMsg(idx: number, getModel: () => string, getYolo: () => boolean) {
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    if (!sid || !opts.isOpen()) return;
    if (sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }

    const msgs = messages();
    // Locate the user message that prompted this assistant turn.
    // Search backwards from idx in messages() for the preceding user message.
    let userMsg: ChatMessage | null = null;
    let userIdx = -1;
    for (let k = msgs.length - 1; k >= 0; k--) {
      if (msgs[k]?.role === "user" && (msgs[k].srcIdx ?? k) <= idx) {
        userMsg = msgs[k];
        userIdx = k;
        break;
      }
    }
    if (!userMsg) return;
    const userRawIdx = typeof userMsg?.srcIdx === "number" ? userMsg.srcIdx : (userMsg ? userIdx : idx);
    const userText = userMsg ? messageText(userMsg) : "";

    const choice = await opts.showChoice({
      title: "Regenerate response?",
      message: "Everything from this point down will be discarded and the turn re-runs from the previous user message.\n\nFork keeps the current timeline in a copy and regenerates there instead.",
      options: [
        { id: "resend", label: "Discard & regenerate", hint: "Discards the tail and resends here", primary: true },
        { id: "fork", label: "Fork & regenerate", hint: "Preserves here, regenerates in a copy" },
      ],
    });
    if (!choice || opts.getHostId() !== host || opts.getSessionId() !== sid || !opts.isOpen() || sessionStatus() === "running") return;
    if (choice === "fork") {
      forkRequestId = crypto.randomUUID();
      setForking(true);
      opts.onForkKind?.("regenerate");
      opts.send({
        type: "fork_session",
        sessionId: sid,
        index: userRawIdx,
        requestId: forkRequestId,
        editText: userText,
        editModel: getModel(),
        editYolo: getYolo(),
        attachmentIds: userMsg?.attachments?.map((a) => a.id),
      });
      return;
    }
    // Arm full reload after daemon signals the new turn
    opts.onDiscardResendOrRegenerate?.(sid);

    // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated and subsequent full reload).
    cutLiveTail(userRawIdx);
    opts.send({
      type: "regenerate",
      sessionId: sid,
      index: userRawIdx,
      text: userText,
      model: getModel(),
      yolo: getYolo(),
    });
  }
  let editSource: { host: string; sid: string; idx: number; source: string } | null = null;
  function editDraftPrefix() {
    return `llmgw-edit:${opts.getHostId()}:${opts.getSessionId()}:`;
  }
  function sourceOf(m: ChatMessage) {
    return JSON.stringify([m.role, messageText(m), (m.attachments || []).map((a) => a.id)]);
  }

  function persistEditDraft() {
    if (!editSource || editSource.host !== opts.getHostId() || editSource.sid !== opts.getSessionId() || editingMsgIdx() !== editSource.idx) return;
    try {
      localStorage.setItem(`${editDraftPrefix()}${editSource.idx}`, JSON.stringify({
        source: editSource.source, text: editingMsgText(), attachmentIds: editingAttachments().map((a) => a.id),
      }));
      localStorage.setItem(`${editDraftPrefix()}active`, String(editSource.idx));
    } catch {}
  }

  function clearEditDraft(idx: number) {
    try {
      localStorage.removeItem(`${editDraftPrefix()}${idx}`);
      localStorage.removeItem(`${editDraftPrefix()}active`);
    } catch {}
  }
  createEffect(() => { editingAttachments(); persistEditDraft(); });

  function restoreEditDraft() {
    if (editingMsgIdx() != null) {
      const current = messages().find((m) => m.srcIdx === editingMsgIdx());
      if (!current || sourceOf(current) !== editSource?.source) cancelEditMsg();
      return;
    }
    try {
      const saved = localStorage.getItem(`${editDraftPrefix()}active`);
      if (saved == null) return;
      const idx = Number(saved);
      const msg = messages().find((m) => m.srcIdx === idx && m.role === "user");
      const draft = JSON.parse(localStorage.getItem(`${editDraftPrefix()}${idx}`) || "null");
      if (msg && draft?.source === sourceOf(msg) && typeof draft.text === "string") startEditMsg(idx, msg);
      else clearEditDraft(idx);
    } catch {}
  }

  const editMentions = createMentions({ ...opts, getProjectId: () => opts.getProjectId?.() || "",
    text: editingMsgText, setText: updateEditingMsgText, inputId: "rc-editing-msg" });

  // Inline edit (chatbot startEditMessage): user edits resubmit, assistant
  // edits just save. The in-progress text stays in this browser only
  // (localStorage per host+session+message) and is restored on reopen.
  function startEditMsg(idx: number, m: ChatMessage) {
    batch(() => {
      editAttachments.clearAttachments();
      setEditingAttachments(m.attachments || []);
      setEditingMsgIdx(idx);
      editSource = { host: opts.getHostId(), sid: opts.getSessionId(), idx, source: sourceOf(m) };
      let text = messageText(m);
      try {
        const saved = JSON.parse(localStorage.getItem(`${editDraftPrefix()}${idx}`) || "null");
        if (saved?.source === editSource.source && typeof saved.text === "string") {
          text = saved.text;
          if (Array.isArray(saved.attachmentIds)) setEditingAttachments((m.attachments || []).filter((a) => saved.attachmentIds.includes(a.id)));
        }
      } catch {}
      setEditingMsgText(text);
      persistEditDraft();
    });
  }
  function updateEditingMsgText(text: string) {
    setEditingMsgText(text);
    persistEditDraft();
  }
  function cancelEditMsg() {
    batch(() => {
      editAttachments.clearAttachments();
      setEditingAttachments([]);
      const idx = editingMsgIdx();
      if (idx != null) clearEditDraft(idx);
      editSource = null;
      setEditingMsgIdx(null);
      setEditingMsgText("");
    });
  }
  async function saveEditMsg(idx: number, m: ChatMessage, getModel: () => string, getYolo: () => boolean) {
    const sid = opts.getSessionId();
    const host = opts.getHostId();
    const source = editSource;
    const text = editingMsgText().trim();
    if (savingEdit()) return;
    if (editAttachments.preparingAttachments()) { opts.toast("Wait for files to finish extracting", "err"); return; }
    if (!sid || !opts.isOpen()) { opts.toast("Reconnect the host before saving", "err"); return; }
    if (!text && !editingAttachments().length && !editAttachments.pendingAttachments().length) {
      opts.toast("Message cannot be empty", "err");
      return;
    }
    const regen = m.role === "user";
    if (regen && sessionStatus() === "running") {
      opts.toast("Stop the current turn first", "err");
      return;
    }
    const targetRawIdx = typeof m.srcIdx === "number" ? m.srcIdx : idx;
    setSavingEdit(true);
    let attachmentIds: string[] | undefined;
    try {
    if (regen) {
      const choice = await opts.showChoice({
        title: "Resend edited message?",
        message: "Everything from this message down will be discarded and the turn re-runs with your edited text.\n\nFork keeps the current timeline in a copy and resends there instead.",
        options: [
          { id: "resend", label: "Discard & resend", hint: "Discards the tail and resends here", primary: true },
          { id: "fork", label: "Fork & resend", hint: "Preserves here, resends in a copy" },
        ],
      });
      if (!choice || opts.getHostId() !== host || opts.getSessionId() !== sid || editSource !== source || editingMsgIdx() !== idx || !opts.isOpen() || sessionStatus() === "running") return;
      attachmentIds = [...editingAttachments().map((a) => a.id), ...await Promise.all(editAttachments.pendingAttachments().map((a) => editAttachments.uploadOneAttachment(sid, a)))];
      if (opts.getHostId() !== host || opts.getSessionId() !== sid || editSource !== source || editingMsgIdx() !== idx || !opts.isOpen() || sessionStatus() === "running") return;
      if (choice === "fork") {
        // Fork at this message carrying the edited text: the daemon
        // applies it to the boundary user message and resends from there.
        forkRequestId = crypto.randomUUID();
        setForking(true);
        opts.onForkKind?.("resend");
        opts.send({ type: "fork_session", sessionId: sid, index: targetRawIdx, requestId: forkRequestId, editText: text, editModel: getModel(), editYolo: getYolo(), attachmentIds });
        cancelEditMsg();
        return;
      }
      // Arm full reload after daemon signals the new turn
      opts.onDiscardResendOrRegenerate?.(sid);
      // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated).
      cutLiveTail(targetRawIdx);
    }
    opts.send({
      type: "edit_message",
      sessionId: sid,
      index: targetRawIdx,
      text,
      model: getModel(),
      yolo: getYolo(),
      regenerate: regen,
      attachmentIds,
    });
    cancelEditMsg();
    if (regen) setSessionStatus("running");
    } catch (e) { if (opts.getHostId() === host && opts.getSessionId() === sid) opts.toast(e instanceof Error ? e.message : "Could not save message", "err"); }
    finally { setSavingEdit(false); }
  }
  // --- Daemon events (called by the page dispatcher) ---
  function noteSessionDataRequestGuard(requestId: string | undefined): boolean {
    if (requestId && requestId !== transcriptRequestId) return true;
    return false;
  }
  function handleTruncated(sessionId: string | undefined, keep: number) {
    if (pendingSnapshot && sessionId === opts.getSessionId()) {
      pendingSnapshot.replay.push(() => handleTruncated(sessionId, keep)); return;
    }
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
      // The past changed: drop seals + cursor (a fresh tail arrives
      // next and re-seals).
      resetHistory();
      showQuestion(null);
    }
  }
  function handleStatusEvent(msg: SessionStatusEvent) {
    if (pendingSnapshot && msg.sessionId === opts.getSessionId()) {
      pendingSnapshot.replay.push(() => handleStatusEvent(msg)); return;
    }
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
    if (!ev || sessionId !== opts.getSessionId()) return;
    if (pendingSnapshot) { pendingSnapshot.replay.push(() => handleAgentEvent(sessionId, ev)); return; }
    if (ev.type === "turn_start") {
      setSessionStatus("running");
      setTurnActivity((turn) => !turn || turn.endedAt ? { startedAt: Date.now(), status: "running" } : turn);
    } else if (ev.type === "user_message") {
      const user = normalizeSessionMessages([ev.message])[0];
      if (user) setMessages((prev) => {
        const i = prev.findIndex((m) => m.srcIdx === ev.index || (m.role === "user" && m.srcIdx == null));
        const next = { ...user, id: i >= 0 ? prev[i].id : `msg_${ev.index}`, srcIdx: ev.index, turnIndex: ev.turnIndex };
        return i >= 0 ? [...prev.slice(0,i),next,...prev.slice(i+1)] : [...prev,next];
      });
    } else if (ev.type === "todo_update") {
      setTodos(ev.items || []);
    } else if (ev.type === "assistant_message") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages((prev) => mergeAssistantMessage(prev, ev));
    } else if (ev.type === "assistant_start") {
      // Each model step gets its own carrier. Tool loops cannot merge new
      // thinking into the previous assistant response.
      setMessages((prev) => pushAssistantCarrier(prev, ev.index, ev.turnIndex));
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
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setToolStarts((prev) => ({ ...prev, [ev.id]: ev.startedAt }));
    } else if (ev.type === "tool_progress") {
      setToolProgress((prev) => ({ ...prev, [ev.id]: ((prev[ev.id] || "") + (ev.text || "")).slice(-65536) }));
    } else if (ev.type === "tool_call") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
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
    } else if (ev.type === "retry") {
      if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
      setMessages((prev) => prev.filter((m) => ev.index == null ? !m.streaming : m.srcIdx == null || m.srcIdx < ev.index));
    } else if (ev.type === "turn_end") {
      setMessages((prev) => prev.map((m) => m.streaming ? { ...m, streaming: false } : m));
      // This ends one model call; tools and subsequent steps may still run.
      if (thinkingStart() !== null) {
        const dur = stopThinkingTimer();
        stampThinkingDuration(dur);
      }
      if (ev.usage || ev.cumulative) applyUsage(sessionId, ev.usage, ev.cumulative);
      if (ev.cancelled || (ev.stop === "aborted" && turnActivity()?.status === "cancelling")) {
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
      fetchSession(sessionId);
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
    snapshotVersion++; pendingSnapshot = null;
    editSource = null;
    editAttachments.clearAttachments();
    setEditingAttachments([]);
    clearToolScrolls();
    setTurnActivity(null); setTodos([]); setToolProgress({}); setToolStarts({});
    showQuestion(null);
    transcriptScroll.reset();
    resetHistory();
    setMessages([]);
    setSessionCompaction(null);
    setSessionStatus("idle");
    setPendingApproval(null);
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
    // Collapse to the newest seal (fresh tail): the reader already
    // reviewed the past before sending (ocultar, not descarregar —
    // data AND seal notes stay, only the reveal budget shrinks).
    // Older seals stay one click away on the load-older button.
    setSealedBudget(1);
    setTurnActivity({ startedAt: Date.now(), status: "running" });
  }

  return {
    // state
    messages, sessionStatus, setSessionStatus, turnActivity,
    todos, todosOpen, toggleTodosOpen, applyTodosOpenFromRemote, turnClock, turnLabel, turnHint,
    sessionCompaction,
    pendingApproval, pendingQuestion,
    questionSubmitting, questionError, showQuestion, answerQuestion,
    activeUsage, sessionContexts, setSessionContexts,
    toolStarts, toolProgress,
    copiedMsgId, copyMsg,
    thinkingStart, thinkingElapsed, thinkingIndex,
    stopThinkingTimer,
    editingMsgIdx, editingMsgText, updateEditingMsgText,
    isAtBottom,
    chatContainerRef, setChatContainerRef, chatContentRef, setChatContentRef,
    transcriptScroll, scrollToBottom, pinAtBottom, onChatScroll,
    renderBlocks, visibleBlocks, hiddenSeals, revealSeal,
    loadOlder, historyHasOlder, historyHiddenTurns, historyOldestTurn, loadingOlder,
    noteHistoryPage, requestOlderHistory,
    rawIdx, blockRawIdx, specialProgress,
    // session
    fetchSession, beginLoad, applySessionContent, applyUsage, applySnapshot,
    setWorkspaceSink, noteSessionDataRequestGuard,
    handleTruncated, handleStatusEvent, handleAgentEvent,
    noteApprovalRequest, noteQuestionResolved, noteQuestionError,
    appendReasoningDelta,
    appendToolArgsDelta, appendToolResult, foldBgResult,
    cancelTurnForSession, cancelCurrentTurn, respondApproval,
    forking, forkRequestId: () => forkRequestId,
    clearForkRequest: () => { forkRequestId = ""; }, setForking,
    forkMessage, regenerateMsg, startEditMsg, cancelEditMsg, saveEditMsg,
    editAttachments, editingAttachments, setEditingAttachments, savingEdit, editMentions,
    resetForSession, resetCaches, purgeSession, pushUserMessage, beginTurn,
  };
}

export type Transcript = ReturnType<typeof createTranscript>;
