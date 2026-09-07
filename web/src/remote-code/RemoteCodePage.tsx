import {
  createSignal,
  createEffect,
  createMemo,
  batch,
  untrack,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { RemoteHints } from "./presentation";
import { projectForDirectory, projectsByActivity } from "./paths";
import { buildRenderBlocks } from "./transcript";
import { type PendingQuestion } from "./components/QuestionModal";
import { createTranscriptScroll } from "./scroll";
import { contextDisplay, type GatewayModel, type SessionContext } from "./context";
import { api, currentSession, type RemoteHostDto, type RemotePairDto } from "../api";
import { createDataLayer } from "./store/sessions";
import { copyWithToast } from "../ui";
import { Icon as Iconify } from "../components/icon";
import { REASONING_LEVELS, SLASH_COMMANDS } from "./constants";
import { formatEffort } from "./utils/format";
import { elapsedLabel, messageText, normalizeEffort, timeAgo } from "./utils/format";
import { prettyArgs, parseContentBlocks } from "./utils/wire";
import { Onboarding } from "./components/Onboarding";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TranscriptView } from "./components/TranscriptView";
import { Composer } from "./components/Composer";
import {
  NewProjectModal, ReviewModal, ChoiceModal, ConfirmModal, PairModal,
  type SimpleModalsCtx,
} from "./modals/SimpleModals";
import { PreviewModal } from "./modals/PreviewModal";
import { SettingsModal } from "./modals/SettingsModal";
import type { RemoteCodeViewCtx } from "./viewCtx";
import type { Review, TurnActivity, TodoItem, PendingAttachment, SearchHit, StoredAttachment, WorkspaceStatus, ChoiceOption, ConfirmState } from "./viewTypes";
import type {
  AgentSettings, ChatMessage, ContentBlock, MCPServerConfig, PendingApproval,
  PreviewFile, Project, RenderBlock, SessionSummary,
  SessionUsage, SkillConfig, ToolUnit,
} from "./types";

export default function RemoteCodePage() {
  const [appNotice, setAppNotice] = createSignal<{ message: string; kind: "ok" | "err" } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string, kind: "ok" | "err" = "ok") {
    clearTimeout(noticeTimer);
    setAppNotice({ message, kind });
    if (kind === "ok") noticeTimer = setTimeout(() => setAppNotice(null), 5000);
  }
  onCleanup(() => clearTimeout(noticeTimer));
  const [draftMode, setDraftMode] = createSignal(true);
  const [creatingSession, setCreatingSession] = createSignal(false);
  let creationRequestId = "";
  const [effort, setEffort] = createSignal("medium");
  const [agentMode, setAgentMode] = createSignal("build");
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([]);
  const [modeMenuOpen, setModeMenuOpen] = createSignal(false);
  const [accessMenuOpen, setAccessMenuOpen] = createSignal(false);
  let modeBtn: HTMLButtonElement | undefined;
  let accessBtn: HTMLButtonElement | undefined;
  const [expandedSessionLists, setExpandedSessionLists] = createSignal<Record<string, boolean>>({});
  const [folderEntries, setFolderEntries] = createSignal<{ name: string; path: string }[]>([]);
  const [folderParent, setFolderParent] = createSignal("");
  const [folderCurrent, setFolderCurrent] = createSignal("");
  const [folderLoading, setFolderLoading] = createSignal(false);
  const [folderError, setFolderError] = createSignal("");
  let folderRequestId = "";
  let projectCreationId = "";
  const [pendingProjectId, setPendingProjectId] = createSignal("");
  const [taskReview, setTaskReview] = createSignal<Review | null>(null);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [reviewLoading, setReviewLoading] = createSignal(false);
  const [reviewError, setReviewError] = createSignal("");
  let reviewRequestId = "";
  let reviewRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reviewRefreshTimer));
  function refreshReview() {
    clearTimeout(reviewRefreshTimer);
    reviewRefreshTimer = setTimeout(() => requestReview(reviewOpen(), true), 100);
  }
  function sessionOptions() { return { effort: effort(), mode: agentMode(), skills: selectedSkills(), access: yoloMode() ? "full" : "ask" }; }
  let lastLocalSelection: ReturnType<typeof sessionOptions> & {model:string} | undefined;
  let pendingSessionChoice: {sessionId:string; choice:ReturnType<typeof sessionOptions> & {model:string}} | undefined;
  function matchesChoice(a:any, b:any) {
    return a?.model === b?.model && a?.effort === b?.effort && a?.mode === b?.mode && a?.access === b?.access && JSON.stringify(a?.skills || []) === JSON.stringify(b?.skills || []);
  }
  function configureSession() {
    lastLocalSelection = {model:activeModel(), ...sessionOptions()};
    pendingSessionChoice = activeSessionId() ? {sessionId:activeSessionId(), choice:lastLocalSelection} : undefined;
    if (wsOpen()) sendWS({ type: "configure_session", sessionId: activeSessionId(), model: activeModel(), options: sessionOptions() });
  }
  function applyOptions(options: any) {
    setEffort(options?.effort || "medium");
    setAgentMode(options?.mode || "build");
    setSelectedSkills(Array.isArray(options?.skills) ? options.skills : []);
    setYoloMode(options?.access !== "ask");
  }
  function requestFolders(path: string) {
    setNewProjectPath(path);
    if (!wsOpen() || activeHost()?.status !== "online") { setFolderError("Connect this host to browse its folders."); return; }
    setFolderLoading(true); setFolderError("");
    folderRequestId = crypto.randomUUID();
    sendWS({ type: "browse_folders", path: path || "~", requestId: folderRequestId });
  }
  function requestReview(detail = false, background = false) {
    if (!activeSessionId() || !wsOpen()) return;
    if (detail && !background) { setReviewOpen(true); setReviewLoading(true); setReviewError(""); }
    reviewRequestId = crypto.randomUUID();
    sendWS({ type: "get_changes", sessionId: activeSessionId(), detail, requestId: reviewRequestId });
  }
  function keepChanges() {
    const review = taskReview();
    if (!review || sessionStatus() === "running" || !wsOpen()) return;
    setReviewLoading(true); setReviewError("");
    reviewRequestId = crypto.randomUUID();
    sendWS({type:"keep_changes", sessionId:activeSessionId(), reviewId:review.id, requestId:reviewRequestId});
  }
  async function undoChanges(path = "") {
    const review = taskReview();
    if (!review || sessionStatus() === "running" || !wsOpen()) return;
    const yes = await showConfirm({ title: path ? "Undo this file?" : "Undo pending changes?", message: "Restore the captured files to their state before the pending changes. Later manual edits will be preserved.", confirmText: "Undo changes" });
    if (!yes) return;
    setReviewLoading(true); setReviewError("");
    reviewRequestId = crypto.randomUUID();
    sendWS({ type: "undo_changes", sessionId: activeSessionId(), reviewId: review.id, path, detail: reviewOpen(), requestId: reviewRequestId });
  }

  // Hosts & Pairing
  const [hosts, setHosts] = createSignal<RemoteHostDto[]>([]);
  const [activeHostId, setActiveHostId] = createSignal<string>("");
  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairingData, setPairingData] = createSignal<RemotePairDto | null>(null);
  const [pairingLoading, setPairingLoading] = createSignal(false);

  // Gateway Models (Fetched live from /api/me/models)
  const [gatewayModels, setGatewayModels] = createSignal<
    GatewayModel[]
  >([]);

  // UI-only state. Projects / sessions / config are NOT signals here: they
  // are SignalDB collections mirroring the daemon (IndexedDB per host), so
  // they paint instantly from cache and self-correct on every change ping.
  // The page never owns this data — reconnecting from any device/domain
  // shows the very same truth.
  const [activeSessionId, setActiveSessionId] = createSignal<string>("");
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  // New conversations remain local drafts until their first message is sent.

  // Projects (Antigravity-style: pasta no host agrupa conversas)
  const [activeProjectId, setActiveProjectId] = createSignal<string>("");
  const [showNewProjectModal, setShowNewProjectModal] = createSignal(false);
  const [newProjectPath, setNewProjectPath] = createSignal("");
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);

  function pickProject(id: string) {
    setActiveProjectId(id);
  }
  function openNewProjectModal() {
    setShowNewProjectModal(true);
    requestFolders(activeProject()?.path || "~");
  }
  function wsOpen() {
    try {
      return !!ws && (ws as WebSocket).readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  }
  // SignalDB data layer (see store/sessions.ts). One store per host, persisted.
  const dataLayer = createDataLayer({
    send: (payload) => sendWS(payload),
    isOpen: wsOpen,
  });
  const store = createMemo(() => {
    const hid = activeHostId();
    return hid ? dataLayer.storeFor(hid) : null;
  });
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = activeHostId();
    return st.sessions
      .find({ hostId: hid })
      .fetch()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  const projects = createMemo<Project[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = activeHostId();
    return projectsByActivity(st.projects.find({ hostId: hid }).fetch(), sessions());
  });
  const configDoc = createMemo(() => {
    const st = store();
    if (!st) return null;
    return st.config.find({ hostId: activeHostId() }).fetch()[0] ?? null;
  });

  // Chat Transcript & In-Flight State
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("");
  const [yoloMode, setYoloMode] = createSignal(true);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [turnActivity, setTurnActivity] = createSignal<TurnActivity | null>(null);
  const [todos, setTodos] = createSignal<TodoItem[]>([]);
  const [todosOpen, setTodosOpen] = createSignal(true);
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
    const label = turn.status === "running" && pendingQuestion() ? "Waiting for your answers" : turn.status === "running" && pendingApproval() ? "Waiting for approval" : {running:"Working", cancelling:"Stopping turn", cancelled:"Turn cancelled", completed:"Turn completed", failed:"Turn failed"}[turn.status];
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
    if (!question || !wsOpen() || questionSubmitting()) return;
    setQuestionSubmitting(true);
    setQuestionError("");
    sendWS({type:"question_response", sessionId:activeSessionId(), questionId:question.id, answers});
  }
  // Live usage per session (from daemon usage/turn_end events).
  const [sessionUsage, setSessionUsage] = createSignal<Record<string, SessionUsage>>({});
  /** Usage of the active session, or null — keeps "" session ids out of the union. */
  const activeUsage = createMemo<SessionUsage | null>(() => {
    const id = activeSessionId();
    return id ? (sessionUsage()[id] ?? null) : null;
  });
  const [sessionContexts, setSessionContexts] = createSignal<Record<string, SessionContext | null>>({});
  const activeContext = createMemo(() => contextDisplay(
    sessionContexts()[activeSessionId()] ?? null,
    gatewayModels().find((model) => model.id === activeModel()),
  ));
  // Live tool progress text per tool call id (cleared on result/turn_end).
  const [toolStarts, setToolStarts] = createSignal<Record<string, number>>({});
  const [toolProgress, setToolProgress] = createSignal<Record<string, string>>({});
  // Expanded tool rows / groups (Antigravity chevrons).
  const [toolOpen, setToolOpen] = createSignal<Record<string, boolean>>({});
  const [toolGroupOpen, setToolGroupOpen] = createSignal<Record<string, boolean>>({});
  function toggleToolOpen(key: string) {
    setToolOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }
  function toggleToolGroup(key: string) {
    setToolGroupOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }
  // Expanded thinking blocks: reasoning never starts open by itself —
  // the exception is the live one (auto-opens while it streams, then keeps
  // the user's toggle state after it ends).
  const [expandedThinking, setExpandedThinking] = createSignal<Record<string, boolean>>({});
  // Copied-message feedback.
  const [copiedMsgId, setCopiedMsgId] = createSignal<string | null>(null);

  // Appearance (Antigravity-style, persisted per browser).
  const [verboseChat, setVerboseChat] = createSignal(
    (() => {
      try {
        return localStorage.getItem("llmgw-rc-verbose") !== "0";
      } catch {
        return true;
      }
    })(),
  );
  const [convWidth, setConvWidth] = createSignal<"narrow" | "default" | "wide">(
    (() => {
      try {
        return (localStorage.getItem("llmgw-rc-width") as any) || "default";
      } catch {
        return "default";
      }
    })(),
  );
  const convWidthClass = createMemo(() => {
    const w = convWidth();
    if (w === "narrow") return "max-w-xl";
    if (w === "wide") return "max-w-5xl";
    return "max-w-3xl";
  });

  const [historyView, setHistoryView] = createSignal(false);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = createSignal(false);
  const [addContextOpen, setAddContextOpen] = createSignal(false);
  const [filesMenuOpen, setFilesMenuOpen] = createSignal(false);

  // Custom dropdowns use the shared ui.tsx <Select> (floating-ui Portal).
  // Local popovers below use the module-level <FloatMenu> (same layer).
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [usageOpen, setUsageOpen] = createSignal(false);
  const [modelFilter, setModelFilter] = createSignal("");
  /** Fresh snapshot on every open: stale scroll position/filter never linger. */
  createEffect(() => {
    if (modelMenuOpen()) setModelFilter("");
  });
  const filteredGatewayModels = createMemo(() => {
    const q = modelFilter().trim().toLowerCase();
    const all = gatewayModels();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q),
    );
  });
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal("");
  const [isAtBottom, setIsAtBottom] = createSignal(true);

  // Attachments (chatbot-style): picked in the browser, stored on the daemon.
  const [pendingAttachments, setPendingAttachments] = createSignal<PendingAttachment[]>([]);
  const uploadWaiters = new Map<string, { ok: (id: string) => void; fail: (msg: string) => void }>();

  // Advanced search (daemon full-text over local transcripts).
  const [searchResults, setSearchResults] = createSignal<SearchHit[]>([]);
  let searchTimer: any = null;



  // Choice modal: like showConfirm but returns the picked option id
  // (or null on cancel). Used for fork-vs-resend on edit/regenerate.
  const [choiceState, setChoiceState] = createSignal<{ title: string; message: string; options: ChoiceOption[]; resolve: (id: string | null) => void } | null>(null);
  function showChoice(opts: { title: string; message: string; options: ChoiceOption[] }): Promise<string | null> {
    return new Promise((resolve) => {
      setChoiceState({ ...opts, resolve: (id) => { setChoiceState(null); resolve(id); } });
    });
  }

  // Promise-based confirm modal (chatbot showConfirm, no native confirm()).
  const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);
  function showConfirm(opts: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmState({
        title: opts.title || "Confirm",
        message: opts.message || "",
        confirmText: opts.confirmText || "Confirm",
        cancelText: opts.cancelText || "Cancel",
        danger: !!opts.danger,
        resolve,
      });
    });
  }

  // Mobile: drawer below 768px regardless of touch (small desktop windows too).
  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.innerWidth <= 768 : false,
  );

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

  // Inline message editing (chatbot editingMessageIndex).
  const [editingMsgIdx, setEditingMsgIdx] = createSignal<number | null>(null);
  const [editingMsgText, setEditingMsgText] = createSignal("");

  // Selection mode for bulk ops (chatbot thread selection).
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedSessions, setSelectedSessions] = createSignal<Set<string>>(new Set());

  // Stored attachments per session (from session_data + uploads).
  const [sessionFiles, setSessionFiles] = createSignal<Record<string, StoredAttachment[]>>({});
  // Fetched bytes cache for preview (attachmentId -> data).
  const [previewCache, setPreviewCache] = createSignal<
    Record<string, { name: string; mime: string; dataB64: string; text?: string }>
  >({});
  // File preview modal target.
  const [previewFile, setPreviewFile] = createSignal<PreviewFile | null>(null);
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  // Agent Configuration & MCP Center
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    temperature: 0.7,
    autoCompactPercent: 80,
    noAutoTitle: false,
    jailByDefault: false,
    autoSwarmEnabled: false,
    insecureTls: false,
    httpProxy: "",
    maxExecutionTimeSec: 600,
  });
  const [mcpServers, setMcpServers] = createSignal<Record<string, MCPServerConfig>>({});
  const [skills, setSkills] = createSignal<Record<string, SkillConfig>>({});

  // Autocomplete Palette
  const [slashIndex, setSlashIndex] = createSignal(0);

  // UI state
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [chatContainerRef, setChatContainerRef] = createSignal<HTMLDivElement | null>(null);

  let ws: WebSocket | null = null;
  const [connectionState, setConnectionState] = createSignal<"connecting" | "connected" | "disconnected">("disconnected");
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  let hostBtn: HTMLButtonElement | undefined;
  let contextBtn: HTMLButtonElement | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let disposed = false;
  let initialScrollSession = "";
  let transcriptRequestId = "";
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
  onCleanup(() => {
    disposed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    stopThinkingTimer();
    transcriptScroll.dispose();
    dataLayer.disconnect();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    confirmState()?.resolve(false);
  });
  // Anchor refs for floating menus (floating-ui positions them in a Portal).
  let newProjBtn: HTMLButtonElement | undefined;
  let modelBtn: HTMLButtonElement | undefined;
  let projBtn: HTMLButtonElement | undefined;
  let addBtn: HTMLButtonElement | undefined;
  let filesBtn: HTMLButtonElement | undefined;
  let heartbeatTimer: any = null;

  const activeHost = createMemo(() => {
    const list = hosts();
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.find((h) => h.id === activeHostId()) ?? list[0] ?? null;
  });

  const activeSession = createMemo(() => {
    return sessions().find((s) => s.id === activeSessionId()) ?? null;
  });

  const activeProject = createMemo(() => {
    const list = projects();
    if (list.length === 0) return null;
    return list.find((p) => p.id === activeProjectId()) ?? list[0] ?? null;
  });

  const currentProject = createMemo(() => activeSessionId() ? projectForDirectory(activeSession()?.cwd || "", projects()) : activeProject());
  const [workspace, setWorkspace] = createSignal<WorkspaceStatus | null>(null);
  const workspacePath = createMemo(() => activeSessionId() ? activeSession()?.cwd || "" : currentProject()?.path || "");
  const workspaceState = () => workspace()?.path === workspacePath() ? workspace()?.status : currentProject()?.folderStatus;
  const workspaceBlocked = () => workspaceState() === "missing" || workspaceState() === "unavailable";
  let workspaceRequest = "";
  function checkWorkspace() {
    if (!wsOpen() || !workspacePath()) return;
    workspaceRequest = crypto.randomUUID();
    sendWS({type:"check_workspace", requestId:workspaceRequest, sessionId:activeSessionId(), projectId:currentProject()?.id});
  }
  createEffect(() => {
    workspacePath(); activeHostId(); connectionState();
    setWorkspace(null);
    untrack(checkWorkspace);
    const timer = setInterval(checkWorkspace, 15000);
    const focus = () => checkWorkspace();
    window.addEventListener("focus", focus);
    onCleanup(() => { clearInterval(timer); window.removeEventListener("focus", focus); });
  });

  function visibleSessions(key: string, list: SessionSummary[]) {
    if (expandedSessionLists()[key]) return list;
    return sortedSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10));
  }
  function sessionListToggle(key: string, count: number) {
    return <Show when={count > 10}><button class="px-3 py-2 text-xs text-ink-500 hover:text-ink-200 cursor-pointer" aria-expanded={!!expandedSessionLists()[key]}
      onClick={() => setExpandedSessionLists((prev) => ({ ...prev, [key]: !prev[key] }))}>{expandedSessionLists()[key] ? "Show less" : `See all (${count})`}</button></Show>;
  }
  function sessionsOfProject(projectId: string) {
    return sessions().filter((s) => projectForDirectory(s.cwd, projects())?.id === projectId);
  }

  /** Removes local leftovers of a session that vanished from the mirror. */
  function purgeSessionTrace(id: string) {
    setSessionUsage((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionFiles((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      localStorage.removeItem(`llmgw-draft:${id}`);
    } catch {}
  }


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

  // --- Fetch Gateway Models ---
  async function loadGatewayModels() {
    try {
      const res = await api<{ models: GatewayModel[] }>("GET", "/api/me/models");
      if (disposed) return;
      const models = (res.models || []).filter((m) => m.proto !== "anthropic");
      setGatewayModels(models);
      if (!models.some((m) => m.id === activeModel())) {
        setActiveModel(models[0]?.id || "");
      }
    } catch {
      toast("Could not refresh the gateway model catalog", "err");
    }
  }

  // --- Fetch Hosts ---
  async function loadHosts() {
    try {
      const res = await api<{ success: boolean; hosts: RemoteHostDto[] }>(
        "GET",
        "/api/remote/hosts",
      );
      const list = Array.isArray(res?.hosts) ? res.hosts : [];
      setHosts(list);
      if (list.length > 0) {
        if (!activeHostId() || !list.some((h) => h.id === activeHostId())) {
          const online = list.find((h) => h.status === "online");
          setActiveHostId(online ? online.id : list[0].id);
        }
      } else {
        setActiveHostId("");
      }
    } catch (e: any) {
      console.warn("Failed to load remote hosts:", e);
      toast("Failed to load remote hosts: " + (e?.message || e), "err");
    }
  }

  async function removeHost() {
    const host = activeHost();
    if (!host) return;
    setHostMenuOpen(false);
    const confirmed = await showConfirm({title:`Remove ${host.name || host.hostname || "host"}?`,
      message:"This disconnects the host and revokes its gateway access. Conversations and project files remain on that machine. Pair the daemon again to reconnect.",
      confirmText:"Remove host", danger:true});
    if (!confirmed) return;
    try {
      await api("DELETE", `/api/remote/hosts/${encodeURIComponent(host.id)}`);
      await loadHosts();
      toast("Host removed", "ok");
    } catch (error:any) { toast(error?.message || "Could not remove host", "err"); }
  }

  // --- WebSocket Connection ---
  function connectWebSocket(hostId: string) {
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    dataLayer.disconnect();
    if (disposed || !hostId) { setConnectionState("disconnected"); return; }
    const session = currentSession();
    if (!session) return;
    setConnectionState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/api/remote/ws?token=${encodeURIComponent(session.accessToken)}`);
    ws = socket;
    socket.onopen = () => {
      if (socket !== ws || disposed) return;
      reconnectAttempt = 0;
      setConnectionState("connected");
      void loadGatewayModels();
      dataLayer.storeFor(hostId).syncAll();
      if (activeSessionId()) { sendWS({ type: "get_session", sessionId: activeSessionId() }); requestReview(reviewOpen()); }
      heartbeatTimer = setInterval(() => sendWS({ type: "ping", ts: Date.now() }), 15000);
    };
    socket.onmessage = (ev) => {
      if (socket !== ws || disposed) return;
      try { batch(() => handleIncomingMessage(JSON.parse(ev.data))); }
      catch (err) { console.error("Remote Code message error:", err); }
    };
    socket.onclose = () => {
      if (socket !== ws || disposed) return;
      pendingSessionChoice = undefined;
      setForking(false); forkRequestId = "";
      clearInterval(heartbeatTimer);
      setConnectionState("disconnected");
      setCreatingSession(false);
      setFolderLoading(false);
      setReviewLoading(false);
      dataLayer.disconnect();
      stopThinkingTimer();
      const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
      reconnectTimer = setTimeout(async () => {
        // An authenticated request refreshes an expired dashboard token first.
        await loadHosts();
        if (!disposed && activeHostId() === hostId) connectWebSocket(hostId);
      }, delay);
    };
  }

  function sendWS(payload: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!payload.hostId && activeHostId()) {
        payload.hostId = activeHostId();
      }
      if (payload.type === "get_session") {
        transcriptRequestId = crypto.randomUUID();
        payload.requestId = transcriptRequestId;
      }
      ws.send(JSON.stringify(payload));
    }
  }

  // --- Message Handling ---
  // The daemon speaks two dialects on the wire: Anthropic-style blocks
  // ({type:"text"|"tool_use"|"tool_result"}) and raw Go structs
  // ({text}, {id,name,arguments}, {call_id,content,is_error},
  // {reasoning_id,summary}, {mime_type,data}). Parse both.
  function applySessionContent(sessionId: string, rawMsgs: any[]) {
    const out: ChatMessage[] = [];
    let carrier: ChatMessage | null = null;
    const TOOLS_IMAGE_MARKER = "Tool output included the following image content:";
    const ensureCarrier = (srcIdx: number): ChatMessage => {
      if (!carrier || carrier.role !== "assistant") {
        carrier = {
          id: `tools_${srcIdx}`,
          role: "assistant",
          blocks: [],
          time: Date.now(),
          srcIdx,
        };
        out.push(carrier);
      }
      return carrier;
    };
    (rawMsgs || []).forEach((m: any, idx: number) => {
      const blocks = parseContentBlocks(m);
      const firstText = blocks.find((b) => b.type === "text")?.text || "";
      const system =
        m?.meta?.compaction === "true" ||
        firstText.startsWith("## Context Summary (compacted)");
      const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
      if (role === "assistant") {
        const reason: ContentBlock[] = [];
        const rest: ContentBlock[] = [];
        for (const b of blocks) (b.type === "reasoning" ? reason : rest).push(b);
        const msg: ChatMessage = {
          id: `msg_${idx}`,
          role,
          blocks: [...reason, ...rest],
          thinkingDuration: Number(m.meta?.thinking_ms) > 0 ? Math.max(1, Math.ceil(Number(m.meta.thinking_ms)/1000)) : undefined,
          time: Date.now(),
          system,
          srcIdx: idx,
        };
        out.push(msg);
        carrier = msg;
        return;
      }
      // user / tool envelope: split tool results away from real content.
      const rest: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") ensureCarrier(idx).blocks.push(b);
        else rest.push(b);
      }
      // Daemon's image mirror: the tool already shows a collapsible row with
      // its output — the mirror carries the SAME bytes, so drop it (keeping
      // a duplicate caption under the tool would just repeat the tool). The
      // image blocks here and the ones folded from tool results both die
      // together with their carrier row.
      if (
        rest.length > 0 &&
        rest[0].type === "text" &&
        (rest[0].text || "").trim().startsWith(TOOLS_IMAGE_MARKER)
      ) {
        return;
      }
      if (role === "tool" || rest.length === 0) {
        // "tool" envelopes never become bubbles; a user envelope holding
        // only tool results must not render as an empty user bubble.
        if (rest.length > 0) ensureCarrier(idx).blocks.push(...rest);
        return;
      }
      const msg: ChatMessage = {
        id: `msg_${idx}`,
        role: "user",
        blocks: rest,
        time: Date.now(),
        system,
        srcIdx: idx,
      };
      out.push(msg);
      carrier = msg;
    });
    setMessages(out);
    if (initialScrollSession === sessionId) {
      initialScrollSession = "";
      scrollToBottom(true);
    } else {
      scrollToBottom();
    }
  }
  function applyUsage(sessionId: string, u: any, cum: any) {
    if (!sessionId) return;
    const src = cum || u || {};
    setSessionUsage((prev) => ({
      ...prev,
      [sessionId]: {
        inTok: src.input_tokens ?? src.inTok ?? prev[sessionId]?.inTok ?? 0,
        outTok: src.output_tokens ?? src.outTok ?? prev[sessionId]?.outTok ?? 0,
        cacheTok:
          (src.cache_read_tokens ?? 0) + (src.cache_write_tokens ?? src.cache_creation_tokens ?? 0),
        reasoningTok: src.reasoning_tokens ?? prev[sessionId]?.reasoningTok ?? 0,
        costUsd: src.cost_usd ?? prev[sessionId]?.costUsd ?? 0,
      },
    }));
  }
  function handleIncomingMessage(msg: any) {
    // SignalDB sync protocol messages (pull responses / change pings) are
    // owned by the data layer; everything else is event-driven below.
    if (dataLayer.handleMessage(msg)) return;
    // The relay fans out every host; foreground events belong to the selected host only.
    if (msg.type !== "host_status" && msg.hostId && msg.hostId !== activeHostId()) return;
    if (msg.type === "error" && msg.requestId === forkRequestId) setForking(false);
    switch (msg.type) {
      case "relay_connected":
        break;
      case "host_status": {
        if (msg.hostId === activeHostId() && msg.status === "online") {
          dataLayer.storeFor(msg.hostId).syncAll();
          if (activeSessionId()) sendWS({ type: "get_session", sessionId: activeSessionId() });
        }
        if (msg.hostId && msg.status) {
          setHosts((prev) =>
            prev.map((h) => (h.id === msg.hostId ? { ...h, status: msg.status } : h)),
          );
        }
        break;
      }

      // NOTE: sessions/projects/config lists never arrive as events — the
      // SignalDB sync owns them (daemon change ping → pull → collection).
      // The events below are action acks that drive local continuation.

      case "session_forked": {
        if (!forking() || msg.requestId !== forkRequestId || !msg.session?.id) break;
        setForking(false);
        dataLayer.storeFor(activeHostId()).syncAll();
        selectSession(msg.session.id);
        if (msg.resent) {
          setSessionStatus("running");
          toast("Fork created — resending with edited text", "ok");
        } else {
          toast("Conversation fork created", "ok");
        }
        break;
      }
      case "session_created": {
        if (!creatingSession() || msg.requestId !== creationRequestId) break;
        const r = msg.session;
        if (!r?.id) break;
        setCreatingSession(false);
        setDraftMode(false);
        const firstDraft = inputPrompt();
        setActiveSessionId(r.id);
        setInputPrompt(firstDraft);
        try { localStorage.setItem(`llmgw-draft:${r.id}`, firstDraft); } catch {}
        applyOptions(lastLocalSelection || r.options);
        // Attachments stay in the draft until upload succeeds on this new session.
        void sendPrompt();
        break;
      }
      case "project_created": {
        if (msg.requestId !== projectCreationId) break;
        const p = msg.project;
        if (!p?.id) break;
        setShowNewProjectModal(false);
        setPendingProjectId(p.id);
        dataLayer.storeFor(activeHostId()).syncAll();
        toast(`Project '${p.name || "Project"}' added`, "ok");
        break;
      }
      case "folders": {
        if (msg.requestId !== folderRequestId) break;
        setFolderLoading(false);
        if (msg.error) { setFolderError(msg.error); break; }
        setFolderEntries(msg.folders || []);
        setFolderParent(msg.parent || "");
        setFolderCurrent(msg.path || "");
        setNewProjectPath(msg.path || "");
        break;
      }
      case "session_changes": {
        if (msg.sessionId !== activeSessionId() || (msg.requestId && msg.requestId !== reviewRequestId)) break;
        if (msg.requestId) setReviewLoading(false);
        if (msg.error) { setReviewError(msg.error); if (!reviewOpen()) toast(msg.error, "err"); break; }
        if (reviewOpen() && !msg.detail && !msg.requestId) { refreshReview(); break; }
        setTaskReview(msg.review || null);
        break;
      }
      case "changes_updated": {
        if (msg.sessionId === activeSessionId()) refreshReview();
        break;
      }

      case "attachment_uploaded": {
        const a = msg.attachment;
        if (!a?.id) break;
        if (msg.sessionId) {
          setSessionFiles((prev) => {
            const list = prev[msg.sessionId] || [];
            if (list.some((x) => x.id === a.id)) return prev;
            return {
              ...prev,
              [msg.sessionId]: [...list, { id: a.id, name: a.name, mime: a.mime, size: a.size || 0 }],
            };
          });
        }
        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.uploadKey === msg.requestId || (!p.serverId && p.name === a.name)
              ? { ...p, serverId: a.id, uploading: false }
              : p,
          ),
        );
        const w = msg.requestId ? uploadWaiters.get(msg.requestId) : undefined;
        if (w) {
          uploadWaiters.delete(msg.requestId);
          w.ok(a.id);
        }
        break;
      }

      case "search_results": {
        if (typeof msg.query === "string" && msg.query.trim() !== sessionFilter().trim()) break;
        const raw = Array.isArray(msg.results) ? msg.results : [];
        setSearchResults(
          raw.map((r: any) => ({
            sessionId: r.sessionId || r.session_id,
            title: r.title || "",
            cwd: r.cwd || "",
            updatedAt: r.updatedAt ?? r.updated_at ?? 0,
            snippet: r.snippet || "",
            matchCount: r.matchCount ?? r.match_count ?? 0,
          })),
        );
        break;
      }

      case "notice": {
        if (msg.message) toast(msg.message, "ok");
        break;
      }

      case "attachment_data": {
        const a = msg.attachment;
        if (!a?.id || (!a.data && !a.text)) break;
        setPreviewCache((prev) => ({
          ...prev,
          [a.id]: { name: a.name, mime: a.mime, dataB64: a.data || "", text: a.text },
        }));
        openStoredPreview(msg.sessionId, a.id);
        break;
      }

      case "session_data": {
        if (msg.requestId && msg.requestId !== transcriptRequestId) break;
        // Historic full-record shape; render it like session_content.
        const r = msg.session;
        if (!r) break;
        const sid = r.id || msg.sessionId;
        if (sid) {
          const atts = r.attachments || r.Attachments || [];
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
        if (sid && sid === activeSessionId()) {
          if (r.workspace) setWorkspace(r.workspace);
          setSessionStatus(r.status === "running" ? "running" : "idle");
          setTurnActivity(r.turn || null);
          setTurnClock(Date.now());
          setTodos(r.todos || []);
          showQuestion(r.question || null);
          setToolProgress(r.toolProgress || {});
          setToolStarts(r.toolStarts || {});
          setPendingApproval(r.pendingApproval ? {...r.pendingApproval, args:prettyArgs(r.pendingApproval.args)} : null);
          if (r.thinkingStartedAt && r.status === "running") startThinkingTimer(r.thinkingStartedAt);
          else stopThinkingTimer();
          // Older configure acknowledgements must not overwrite a newer choice
          // while multiple changes are travelling to/from the daemon.
          const pending = pendingSessionChoice?.sessionId === sid ? pendingSessionChoice : undefined;
          if (!pending || matchesChoice({model:r.model, ...r.options}, pending.choice)) {
            pendingSessionChoice = undefined;
            if (r.model) setActiveModel(gatewayModels().some((m) => m.id === r.model) ? r.model : gatewayModels()[0]?.id || "");
            applyOptions(r.options);
          }
          if (r.usage) applyUsage(sid, r.usage, null);
          setSessionContexts((prev) => ({ ...prev, [sid]: r.context ?? null }));
          applySessionContent(sid, r.messages || r.Messages || []);
        }
        break;
      }

      case "session_truncated": {
        // Authoritative tail cut after edit/regenerate (daemon broadcast).
        // keepIndex is the last RAW message to keep; drop rendered messages
        // whose srcIdx exceeds it, then let the following session_content
        // (or the new turn) repaint.
        if (msg.sessionId !== activeSessionId()) break;
        const keep = typeof msg.keepIndex === "number" ? msg.keepIndex : -1;
        if (keep >= 0) {
          setMessages((prev: ChatMessage[]) => {
            const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keep);
            return cut < 0 ? prev : prev.slice(0, cut);
          });
          showQuestion(null);
        }
        break;
      }
      case "session_content": {
        if (msg.sessionId !== activeSessionId()) break;
        applySessionContent(msg.sessionId, msg.messages || []);
        break;
      }

      case "session_status": {
        // Composer responsiveness only (stop button state) — the collections
        // get the same truth via the sessions change ping.
        if (msg.sessionId === activeSessionId()) {
          setSessionStatus(msg.status === "running" ? "running" : "idle");
          if (msg.turn) setTurnActivity(msg.turn);
          if (msg.status === "idle") {
            showQuestion(null);
            setTurnActivity((turn) => turn && !turn.endedAt ? {...turn, endedAt:Date.now(), status:turn.status === "cancelling" ? "cancelled" : turn.status === "running" ? "completed" : turn.status} : turn);
            requestReview(reviewOpen());
            setPendingApproval(null);
            setToolProgress({}); setToolStarts({});
            if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
          }
        }
        break;
      }

      case "session_cleared": {
        if (msg.sessionId === activeSessionId()) {
          setMessages([]);
          toast("Transcript cleared", "ok");
        }
        break;
      }

      case "session_compacted": {
        if (msg.sessionId === activeSessionId()) {
          setSessionContexts((prev) => ({ ...prev, [msg.sessionId]: msg.context ?? null }));
          applySessionContent(msg.sessionId, msg.messages || []);
          toast(
            msg.auto
              ? "Context auto-compacted — older turns summarized, recent context preserved"
              : "Transcript compacted successfully",
            "ok",
          );
        }
        break;
      }

      case "workspace_status": {
        if (msg.requestId === workspaceRequest && msg.workspace?.path === workspacePath()) setWorkspace(msg.workspace);
        break;
      }
      case "question_request": {
        if (msg.sessionId === activeSessionId()) showQuestion(msg.question);
        break;
      }
      case "question_resolved": {
        if (msg.sessionId === activeSessionId() && pendingQuestion()?.id === msg.questionId) showQuestion(null);
        break;
      }
      case "question_error": {
        if (msg.sessionId === activeSessionId() && pendingQuestion()?.id === msg.questionId) {
          setQuestionSubmitting(false);
          setQuestionError(msg.message || "Could not submit answers");
        }
        break;
      }
      case "tool_approval_request": {
        if (msg.sessionId === activeSessionId()) {
          setPendingApproval({
            callId: msg.callId,
            tool: msg.tool,
            args:
              typeof msg.args === "string"
                ? msg.args
                : JSON.stringify(msg.args, null, 2),
          });
        }
        break;
      }

      case "agent_event": {
        if (msg.sessionId !== activeSessionId()) break;
        const ev = msg.event;
        if (!ev) break;

        if (ev.type === "turn_start") {
          setSessionStatus("running");
          setTurnActivity((turn) => !turn || turn.endedAt ? {startedAt:Date.now(), status:"running"} : turn);
        } else if (ev.type === "todo_update") {
          setTodos(ev.items || []);
        } else if (ev.type === "assistant_message") {
          if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
          const blocks = parseContentBlocks(ev.message);
          const normalized = [...blocks.filter((b) => b.type === "reasoning"), ...blocks.filter((b) => b.type !== "reasoning")];
          const duration = Number(ev.message?.meta?.thinking_ms);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            const message: ChatMessage = {id:last?.role === "assistant" ? last.id : `msg_${ev.index}`, role:"assistant", blocks:normalized, time:Date.now(), srcIdx:ev.index,
              thinkingDuration:duration > 0 ? Math.max(1, Math.ceil(duration/1000)) : last?.thinkingDuration};
            return last?.role === "assistant" ? [...prev.slice(0,-1), message] : [...prev, message];
          });
        } else if (ev.type === "assistant_start") {
          // Each model step gets its own carrier. Tool loops cannot merge new
          // thinking into the previous assistant response.
          setMessages((prev) => [...prev, {
            id: `asst_${crypto.randomUUID()}`, role: "assistant", blocks: [], time: Date.now(),
          }]);
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
          setToolStarts((prev) => ({...prev, [ev.id]:ev.startedAt}));
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
          appendToolResult(ev.id, ev.result ?? ev.content, ev.isError, ev.startedAt, ev.durationMs);
          setToolStarts((prev) => { const next = {...prev}; delete next[ev.id]; return next; });
        } else if (ev.type === "usage") {
          applyUsage(msg.sessionId, ev.usage, ev.cumulative);
          if (ev.context) {
            setSessionContexts((prev) => ({ ...prev, [msg.sessionId]: ev.context }));
            const configured = gatewayModels().find((m) => m.id === ev.context.model)?.limit?.context ?? 0;
            if (configured !== ev.context.windowTokens) void loadGatewayModels();
          }
        } else if (ev.type === "compact_progress") {
          if (ev.text === "Compacting older context…") toast(ev.text, "ok");
        } else if (ev.type === "turn_end") {
          // This ends one model call; tools and subsequent steps may still run.
          if (thinkingStart() !== null) {
            const dur = stopThinkingTimer();
            stampThinkingDuration(dur);
          }
          if (ev.usage || ev.cumulative) applyUsage(msg.sessionId, ev.usage, ev.cumulative);
          if (ev.cancelled || ev.stop === "aborted" || /context cancel(?:led|ed)/i.test(ev.error || "")) {
            showQuestion(null);
            setTurnActivity((turn) => turn ? {...turn, status:"cancelled", endedAt:Date.now()} : null);
            setPendingApproval(null);
          } else if (ev.error) toast(ev.error, "err");
          // The daemon sends the final snapshot and idle status after the task.
        } else if (ev.type === "done") {
          // Compatibility with daemons that predate final session snapshots.
          sendWS({ type: "get_session", sessionId: msg.sessionId });
        } else if (ev.type === "error") {
          toast(ev.message || "Agent error", "err");
          setSessionStatus("idle");
        }
        scrollToBottom();
        break;
      }

      case "error": {
        if (msg.requestId === creationRequestId) { setCreatingSession(false); }
        if (msg.requestId === folderRequestId) { setFolderLoading(false); setFolderError(msg.message || "Could not browse folders"); break; }
        if (msg.requestId === projectCreationId && showNewProjectModal()) { setFolderError(msg.message || "Could not create project"); break; }
        if (msg.sessionId && msg.sessionId !== activeSessionId()) break;
        if (msg.requestId && uploadWaiters.has(msg.requestId)) {
          const w = uploadWaiters.get(msg.requestId)!;
          uploadWaiters.delete(msg.requestId);
          w.fail(msg.message || "Upload failed");
          break;
        }
        if (msg.replyTo === "create_session") setCreatingSession(false);
        if (["get_changes", "undo_changes", "keep_changes"].includes(msg.replyTo)) { setReviewLoading(false); setReviewError(msg.message || "Host unavailable"); }
        if (msg.message === "Remote host is offline") {
          setHosts((prev) => prev.map((h) => h.id === activeHostId() ? { ...h, status: "offline" } : h));
          if (msg.replyTo === "browse_folders") { setFolderLoading(false); setFolderError("The host went offline. Reconnect to browse its folders."); }
          break;
        }
        // Sync pulls on an offline host are expected background noise.
        if (msg.replyTo === "pull") break;

        toast(msg.message || "Daemon returned an error", "err");
        if (activeSessionId()) sendWS({ type: "get_session", sessionId: activeSessionId() });
        break;
      }
    }
  }

  function appendReasoningDelta(delta: string) {
    if (!delta) return;
    if (thinkingStart() === null) startThinkingTimer();
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        const blocks = [...last.blocks];
        // Merge into the existing thinking panel; a fresh one goes in front
        // so the live view already matches the normalized refresh (top).
        const ri = blocks.findIndex((b) => b.type === "reasoning");
        if (ri >= 0) {
          const merged = {
            ...blocks[ri],
            reasoning: (blocks[ri].reasoning || "") + delta,
          };
          const next = [...blocks];
          // Keep the merged panel at the top so text never overtakes it.
          next.splice(ri, 1);
          next.unshift(merged);
          return [...prev.slice(0, -1), { ...last, blocks: next }];
        }
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [{ type: "reasoning", reasoning: delta }, ...blocks] },
        ];
      }
      return [
        ...prev,
        {
          id: `asst_${Date.now()}`,
          role: "assistant",
          blocks: [{ type: "reasoning", reasoning: delta }],
          time: Date.now(),
        },
      ];
    });
    // The live clock/ticks belong to this message's first reasoning block.
    setThinkingIndex(0);
  }

  function stampThinkingDuration(dur: number) {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "assistant") {
          const m = { ...prev[i], thinkingDuration: dur };
          return [...prev.slice(0, i), m, ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
  }

  function downloadPreviewFile() {
    const f = previewFile();
    if (!f?.dataB64) {
      toast("Original bytes unavailable for download", "err");
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
      toast("Download failed", "err");
    }
  }

  function truncatePreviewFile() {
    const f = previewFile();
    const maxChars = (truncateTokens() || 16000) * 4;
    if (!f?.text || f.text.length <= maxChars) {
      toast("File is already within the token limit", "err");
      return;
    }
    setPreviewFile({
      ...f,
      fullText: f.fullText || f.text,
      text: f.text.substring(0, maxChars),
      truncated: true,
    });
    toast(`Truncated to ~${truncateTokens().toLocaleString()} tokens`, "ok");
  }

  function restorePreviewFile() {
    const f = previewFile();
    if (f?.fullText) {
      setPreviewFile({ ...f, text: f.fullText, fullText: undefined, truncated: false });
      toast("Original content restored", "ok");
    }
  }

  function previewPending(a: { name: string; mime: string; text?: string; objectUrl?: string; dataB64?: string; size?: number }) {    if (a.objectUrl) {
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
      if (wsOpen()) {
        sendWS({ type: "get_attachment", sessionId, attachmentId });
        toast("Loading attachment...", "ok");
      } else {
        toast("Not connected to host", "err");
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

  function appendStreamingDelta(delta: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        const blocks = [...last.blocks];
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.type === "text") {
          blocks[blocks.length - 1] = {
            ...lastBlock,
            text: (lastBlock.text || "") + delta,
          };
        } else {
          blocks.push({ type: "text", text: delta });
        }
        return [...prev.slice(0, -1), { ...last, blocks }];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [{ type: "text", text: delta }],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function appendToolCall(callId: string, name: string, args: any) {
    const argsStr = prettyArgs(args);
    setMessages((prev) => {
      // Upsert: tool_use_start pre-creates the card, tool_call finalizes it.
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const bi = m.blocks.findIndex(
          (b) => b.type === "tool_call" && b.toolId === callId,
        );
        if (bi >= 0) {
          const blocks = [...m.blocks];
          blocks[bi] = { ...blocks[bi], toolName: name || blocks[bi].toolName, toolArgs: argsStr || blocks[bi].toolArgs };
          return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
        }
        break;
      }
      const toolBlock: ContentBlock = {
        type: "tool_call",
        toolId: callId,
        toolName: name,
        toolArgs: argsStr,
      };

      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [...last.blocks, toolBlock] },
        ];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [toolBlock],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function appendToolArgsDelta(callId: string, delta: string) {
    if (!delta) return;
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const bi = m.blocks.findIndex(
          (b) => b.type === "tool_call" && b.toolId === callId,
        );
        if (bi >= 0) {
          const blocks = [...m.blocks];
          blocks[bi] = { ...blocks[bi], toolArgs: (blocks[bi].toolArgs || "") + delta };
          return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
        }
        break;
      }
      return prev;
    });
  }

  function appendToolResult(callId: string, result: string, isError?: boolean, startedAt?:number, durationMs?:number) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const resBlock: ContentBlock = {
        type: "tool_result",
        toolId: callId,
        toolResult: result,
        toolStartedAt:startedAt, toolDurationMs:startedAt ? durationMs || 0 : undefined,
        isError: !!isError,
      };

      if (last && last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [...last.blocks, resBlock] },
        ];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [resBlock],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function scrollToBottom(force = false) { transcriptScroll.schedule(force); }
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

  function selectSession(id: string) {
    if (creatingSession()) return;
    pendingSessionChoice = undefined;
    showQuestion(null);
    setDraftMode(false);
    setTurnActivity(null); setTodos([]); setToolProgress({}); setToolStarts({});
    setTaskReview(null);
    setReviewOpen(false);
    setAppNotice(null);
    initialScrollSession = id;
    transcriptScroll.reset();
    resetWindow();
    setMessages([]);
    setSessionStatus("idle");
    setActiveSessionId(id);
    setPendingApproval(null);
    setSearchResults([]);
    cancelEditMsg();
    stopThinkingTimer();
    for (const p of pendingAttachments()) {
      if (p.objectUrl) {
        try {
          URL.revokeObjectURL(p.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments([]);
    const s = sessions().find((x) => x.id === id);
    if (s) {
      setSessionStatus(s.status);
      if (s.model) setActiveModel(s.model);
    }
    sendWS({ type: "get_session", sessionId: id });
    requestReview();
  }

  // Open a centered draft without creating a conversation on the host.
  function startNewConversation(projectId?: string) {
    if (creatingSession()) return;
    showQuestion(null);
    setDraftMode(true);
    setTurnActivity(null); setTodos([]); setToolProgress({}); setToolStarts({});
    setHistoryView(false);
    setActiveSessionId("");
    setMessages([]);
    setInputPrompt("");
    setSessionStatus("idle");
    setPendingApproval(null);
    setTaskReview(null);
    setReviewOpen(false);
    setAppNotice(null);
    applyOptions(lastLocalSelection || configDoc()?.lastSelection);
    stopThinkingTimer();
    transcriptScroll.reset();
    for (const p of pendingAttachments()) if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
    setPendingAttachments([]);
    if (projectId) setActiveProjectId(projectId);
    if (isMobile()) setSidebarOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus());
  }

  function createProject() {
    const rawPath = newProjectPath().trim();
    if (!rawPath) {
      toast("Project folder cannot be empty", "err");
      return;
    }
    if (!activeHostId()) {
      toast("Connect a host first", "err");
      return;
    }
    if (!wsOpen()) {
      // Frontend holds no state of its own — no offline project shadow copies.
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    // Daemon is the source of truth; ack arrives as project_created.
    projectCreationId = crypto.randomUUID();
    sendWS({ type: "create_project", path: rawPath, requestId: projectCreationId });
  }

  async function deleteProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    const ok = await showConfirm({
      title: "Delete project?",
      message: "The project AND all of its conversations (transcripts and attached files) are permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    // The daemon cascades (wipes every conversation inside, then pings) —
    // the collections converge on their own; nothing local to purge by hand.
    if (wsOpen()) sendWS({ type: "delete_project", projectId: id });
  }

  function quickStartProject() {
    // Quick Start: project rooted at the host home dir + immediate conversation.
    if (!activeHostId()) {
      toast("Connect a host first", "err");
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    projectCreationId = crypto.randomUUID();
    sendWS({ type: "create_project", path: "~", requestId: projectCreationId });
  }

  async function deleteSession(id: string, e?: MouseEvent) {
    e?.stopPropagation();
    const ok = await showConfirm({
      title: "Delete conversation?",
      message: "This conversation will be permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) sendWS({ type: "delete_session", sessionId: id });
  }

  /** Session choices, also remembered by the daemon for the next draft. */
  function modelPickerBody() {
    return (
      <>
        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider flex items-center justify-between">
          <span>Model</span>
          <button
            onClick={async () => {
              await loadGatewayModels();
              toast("Models refreshed", "ok");
            }}
            class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
            data-rc-tip="Refresh models" aria-label="Refresh models"
          >
            <Iconify icon="lucide:refresh-cw" size={11} />
          </button>
        </div>
        <div class="px-2 pb-1">
          <input
            type="text"
            placeholder="Search models..."
            class="w-full bg-ink-950 border border-line/60 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            value={modelFilter()}
            onInput={(e) => setModelFilter(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            ref={(el) => setTimeout(() => el?.focus(), 40)}
          />
        </div>
        <div class="max-h-56 overflow-y-auto overflow-x-auto [scrollbar-gutter:stable]">
          <div class="min-w-full w-max flex flex-col">
            <For
              each={filteredGatewayModels()}
              fallback={
                <div class="px-2.5 py-2 text-[11px] text-ink-600 whitespace-nowrap">
                  {gatewayModels().length ? "No models match." : "No compatible models configured in the gateway."}
                </div>
              }
            >
              {(m) => (
                <button
                  onClick={() => {
                    const id = m.id;
                    setActiveModel(id);
                    setModelMenuOpen(false);
                    configureSession();
                  }}
                  class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-3 cursor-pointer ${
                    m.id === activeModel()
                      ? "bg-ink-800 text-ink-100"
                      : "text-ink-300 hover:bg-ink-800/60"
                  }`}
                >
                  <span class="whitespace-nowrap">{m.name || m.id}</span>
                  <Show when={m.id === activeModel()}>
                    <Iconify icon="lucide:check" size={13} class="shrink-0" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="mt-1.5 pt-1.5 border-t border-line/60">
          <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
            Reasoning effort
          </div>
          <div class="grid grid-cols-7 gap-1 p-1 rounded-lg bg-ink-950 border border-line/50">
            <For each={REASONING_LEVELS}>
              {(lvl) => (
                <button
                  onClick={() => {
                    setEffort(lvl);
                    configureSession();
                    setModelMenuOpen(false);
                  }}
                  class={`py-1 rounded-md text-center text-[10px] sm:text-[11px] font-medium uppercase cursor-pointer ${
                    effort() === lvl
                      ? "bg-ink-100 text-ink-950"
                      : "text-ink-400 hover:text-ink-200"
                  }`}
                >
                  {formatEffort(lvl)}
                </button>
              )}
            </For>
          </div>
        </div>

      </>
    );
  }


  // --- Attachments (chatbot-style; bytes live on the daemon) ---
  const MAX_ATTACHMENTS = 5;
  const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files || []);
    if (list.length === 0) return;

    const room = MAX_ATTACHMENTS - pendingAttachments().length;
    if (room <= 0) {
      toast(`Max ${MAX_ATTACHMENTS} attachments per message`, "err");
      return;
    }
    const { sniffFile, extractText, uint8ToB64 } = await import("../office");
    for (const file of list.slice(0, room)) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        toast(`Could not read '${file.name}'`, "err");
        continue;
      }
      const sniff = sniffFile(file, bytes);
      if (sniff.blocked) {
        toast(sniff.blocked, "err");
        continue;
      }
      const kind = sniff.kind || "text";
      const isImage = kind === "image";
      const cap = isImage ? MAX_IMAGE_BYTES : 12 * 1024 * 1024;
      if (bytes.length > cap) {
        toast(`'${file.name}' too large (max ${isImage ? "2.5MB" : "12MB"})`, "err");
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
          toast(`Could not extract '${file.name}': ${e?.message || e}`, "err");
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
      sendWS({
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

  function copyMsg(id: string, text: string) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    copyWithToast(trimmed);
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1500);
  }

  // Rendered position → raw daemon transcript index (normalization merges
  // tool envelopes, so naive For indices mismatch the raw array).
  function rawIdx(idx: number): number {
    return messages()[idx]?.srcIdx ?? idx;
  }

  const [forking, setForking] = createSignal(false);
  let forkRequestId = "";
  function forkMessage(block: RenderBlock) {
    if (!activeSessionId() || !wsOpen() || forking()) return;
    const last = block.kind === "series" ? block.extras.at(-1) || block.msg : block.msg;
    if (last.srcIdx == null) return;
    forkRequestId = crypto.randomUUID();
    setForking(true);
    sendWS({type:"fork_session", sessionId:activeSessionId(), index:last.srcIdx, requestId:forkRequestId});
  }

  // Regenerate from message idx: the daemon drops that message and everything
  // after it, then re-runs the turn (chatbot regenerateMessage semantics).
  // Offers fork-vs-resend: fork preserves the current timeline in a copy.
  async function regenerateMsg(idx: number) {
    const sid = activeSessionId();
    if (!sid || !wsOpen()) return;
    if (sessionStatus() === "running") {
      toast("Stop the current turn first", "err");
      return;
    }
    const choice = await showChoice({
      title: "Regenerate response?",
      message: "Everything from this point down will be discarded and the turn re-runs from the previous user message.\n\nFork keeps the current timeline in a copy and regenerates there instead.",
      options: [
        { id: "resend", label: "Discard & regenerate", hint: "Apaga a cauda e reenvia aqui", primary: true },
        { id: "fork", label: "Fork & regenerate", hint: "Preserva aqui, regenera numa cópia" },
      ],
    });
    if (!choice) return;
    if (choice === "fork") {
      forkRequestId = crypto.randomUUID();
      setForking(true);
      sendWS({ type: "fork_session", sessionId: sid, index: rawIdx(idx), requestId: forkRequestId });
      return;
    }
    // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated).
    cutLiveTail(rawIdx(idx) - 1);
    sendWS({ type: "regenerate", sessionId: sid, index: rawIdx(idx), model: activeModel(), yolo: yoloMode() });
  }

  // Drop rendered messages below a raw keep-index (optimistic edit/regen cut).
  function cutLiveTail(keepRawIdx: number) {
    setMessages((prev: ChatMessage[]) => {
      const cut = prev.findIndex((m) => (m.srcIdx ?? -1) > keepRawIdx);
      return cut < 0 ? prev : prev.slice(0, cut);
    });
    showQuestion(null);
  }

  // Inline edit (chatbot startEditMessage): user edits resubmit, assistant
  // edits just save.
  function startEditMsg(idx: number, m: ChatMessage) {
    setEditingMsgIdx(idx);
    setEditingMsgText(messageText(m));
  }
  function cancelEditMsg() {
    setEditingMsgIdx(null);
    setEditingMsgText("");
  }
  async function saveEditMsg(idx: number, m: ChatMessage) {
    const sid = activeSessionId();
    const text = editingMsgText().trim();
    if (!sid || !wsOpen()) {
      cancelEditMsg();
      return;
    }
    if (!text) {
      toast("Message cannot be empty", "err");
      return;
    }
    const regen = m.role === "user";
    if (regen && sessionStatus() === "running") {
      toast("Stop the current turn first", "err");
      return;
    }
    if (regen) {
      const choice = await showChoice({
        title: "Resend edited message?",
        message: "Everything from this message down will be discarded and the turn re-runs with your edited text.\n\nFork keeps the current timeline in a copy and resends there instead.",
        options: [
          { id: "resend", label: "Discard & resend", hint: "Apaga a cauda e reenvia aqui", primary: true },
          { id: "fork", label: "Fork & resend", hint: "Preserva aqui, reenvia numa cópia" },
        ],
      });
      if (!choice) return;
      if (choice === "fork") {
        // Fork at this message carrying the edited text: the daemon
        // applies it to the boundary user message and resends from there.
        forkRequestId = crypto.randomUUID();
        setForking(true);
        sendWS({ type: "fork_session", sessionId: sid, index: rawIdx(idx), requestId: forkRequestId, editText: text, editModel: activeModel(), editYolo: yoloMode() });
        cancelEditMsg();
        return;
      }
      // Optimistic cut: drop rendered tail now (daemon reconciles via session_truncated).
      cutLiveTail(rawIdx(idx));
    }
    sendWS({
      type: "edit_message",
      sessionId: sid,
      index: rawIdx(idx),
      text,
      model: activeModel(),
      yolo: yoloMode(),
      regenerate: regen,
    });
    cancelEditMsg();
    if (regen) setSessionStatus("running");
  }

  async function deleteMsg(idx: number) {
    const sid = activeSessionId();
    if (!sid || !wsOpen()) return;
    const ok = await showConfirm({
      title: "Delete message?",
      message: "This message will be permanently deleted from the transcript.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) sendWS({ type: "delete_message", sessionId: sid, index: rawIdx(idx) });
  }



  function togglePin(id: string, e: MouseEvent) {
    e.stopPropagation();
    // Command only — the daemon's change ping brings the new pin state.
    if (wsOpen()) sendWS({ type: "toggle_pin", sessionId: id });
  }

  function toggleSessionSelect(id: string) {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Nested sidebar state: expanded projects (default all expanded).
  const [expandedProjects, setExpandedProjects] = createSignal<Record<string, boolean>>({});
  function isProjectExpanded(p: { id: string }) {
    return expandedProjects()[p.id] !== false;
  }
  function toggleProjectExpanded(id: string) {
    setExpandedProjects((prev) => ({ ...prev, [id]: !(prev[id] !== false) }));
  }

  /**
   * One thinking panel (button + collapsible body). Rendered from the
   * dedicated "thinking" parts (never from the text path), so reasoning is
   * always ABOVE its own tool group, live-streaming or persisted. The block
   * carries its own id so two thinkings inside one series never collide.
   */

  function matchQuery(s: SessionSummary) {
    const q = sessionFilter().toLowerCase().trim();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q)
    );
  }
  function projectSessions(projectId: string) {
    return sortedSessions(sessionsOfProject(projectId));
  }
  function looseSessions() {
    return sortedSessions(sessions().filter((s) => !projectForDirectory(s.cwd, projects())));
  }

  function closeSidebarOnMobile() {
    if (isMobile()) setSidebarOpen(false);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedSessions(new Set<string>());
  }

  async function pinSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const allPinned = ids.every((id) => sessions().find((s) => s.id === id)?.pinned);
    const target = !allPinned;
    for (const id of ids) {
      const cur = sessions().find((s) => s.id === id);
      if (!cur || !!cur.pinned === target) continue;
      if (wsOpen()) sendWS({ type: "toggle_pin", sessionId: id });
    }
    toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} ${target ? "pinned" : "unpinned"}`, "ok");
    exitSelectionMode();
  }

  async function deleteSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const ok = await showConfirm({
      title: `Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}?`,
      message: `This will permanently delete ${ids.length} conversation${ids.length === 1 ? "" : "s"} from the host.\n\nThis action cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    for (const id of ids) sendWS({ type: "delete_session", sessionId: id });
    toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} deleted`, "ok");
    exitSelectionMode();
  }

  function submitRename(id: string) {
    const t = renameText().trim();
    if (!t) {
      setRenamingId(null);
      return;
    }
    sendWS({ type: "rename_session", sessionId: id, title: t });
    setRenamingId(null);
  }

  function sortedSessions(list: SessionSummary[]) {
    const arr = [...list];
    arr.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return arr;
  }

  // Debounced daemon full-text search (transcripts live on the host).
  function queueDaemonSearch(q: string) {
    clearTimeout(searchTimer);
    const query = q.trim();
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimer = setTimeout(() => {
      if (wsOpen()) sendWS({ type: "search", query, limit: 30 });
    }, 300);
  }

  // No session is ever a dead end: typing + Enter auto-starts a
  // conversation inside the active project, then the text is delivered.
  function beginConversationWith() {
    const proj = activeProject();
    if (!proj) {
      toast("Create a project first", "err");
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    if (creatingSession()) return;
    setCreatingSession(true);
    creationRequestId = crypto.randomUUID();
    sendWS({ type: "create_session", requestId: creationRequestId, cwd: proj.path, title: "", model: activeModel(), options: sessionOptions() });
  }

  async function sendPrompt() {
    if (workspaceBlocked()) { checkWorkspace(); return; }
    if (!wsOpen() || activeHost()?.status !== "online") {
      toast("Reconnect the host before sending a message", "err");
      return;
    }
    if (creatingSession()) return;
    if (!activeModel()) { toast("Configure a compatible model in the gateway first", "err"); return; }
    const text = inputPrompt().trim();
    const sid = activeSessionId();
    const hostId = activeHostId();
    // Slash fast-path: UI commands resolve locally, transcript ops go down.
    if (text.startsWith("/")) {
      try {
        if (sid) localStorage.removeItem(`llmgw-draft:${sid}`);
      } catch {}
      if (routeSlash(text)) { setInputPrompt(""); return; }
      if (!sid) {
        beginConversationWith();
        return;
      }
    }
    if (!text && pendingAttachments().length === 0) return;
    if (!sid) {
      beginConversationWith();
      return;
    }
    if (sessionStatus() === "running") return;

    // Upload pending attachments first so the daemon owns the bytes.
    let attachmentIds: string[] = [];
    const pending = pendingAttachments();
    if (pending.some((a) => a.loading)) {
      toast("Wait for files to finish extracting", "err");
      return;
    }
    if (pending.length > 0) {
      setSessionStatus("running");
      try {
        attachmentIds = await Promise.all(pending.map((a) => uploadOneAttachment(sid, a)));
      } catch (e: any) {
        if (activeHostId() === hostId && activeSessionId() === sid) {
          setSessionStatus("idle");
          toast(e?.message || "Attachment upload failed", "err");
        }
        return;
      }
    }
    if (disposed || activeHostId() !== hostId || activeSessionId() !== sid) return;
    // Options may have changed while attachments were uploading.
    const model = activeModel();
    const options = sessionOptions();
    const attachmentNames = pending.map((a) => a.name);

    const displayText = text || attachmentNames.map((n) => `[Attached ${n}]`).join("\n");
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text: displayText }],
      time: Date.now(),
      attachments: attachmentNames.length > 0 ? attachmentNames : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputPrompt("");
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
    setSessionStatus("running");
    setIsAtBottom(true);
    setTurnActivity({startedAt:Date.now(), status:"running"});
    scrollToBottom(true);

    sendWS({
      type: "prompt",
      sessionId: sid,
      text: text || "(see attachments)",
      model,
      yolo: options.access === "full",
      options,
      attachmentIds,
    });
  }

  function cancelTurnForSession(sessionId: string, e?: MouseEvent | KeyboardEvent) {
    e?.stopPropagation();
    if (!sessionId || !wsOpen()) return;
    sendWS({ type: "cancel", sessionId });
    if (sessionId === activeSessionId()) {
      setTurnActivity((turn) => turn ? {...turn, status:"cancelling"} : null);
      stopThinkingTimer();
      transcriptScroll.detach();
    }
  }

  function cancelCurrentTurn() {
    cancelTurnForSession(activeSessionId());
  }

  function respondApproval(approved: boolean, always = false) {
    const p = pendingApproval();
    if (!p || !activeSessionId()) return;
    sendWS({
      type: "tool_approval_response",
      sessionId: activeSessionId(),
      callId: p.callId,
      approved,
      always,
    });
    setPendingApproval(null);
  }

  // (executeSlashCommand: dead since the palette/help runtimes were removed —
  // the composer is the only entry point now, and it routes through routeSlash.)

  // Normalizes UI-visible effort labels to the daemon's canonical guess.
  // Matches NormalizeReasoning's aliases (off/min/med/hi/maximum) plus a
  // grid-friendly "none". Unknown input passes through: the provider layer
  // clamps it to the nearest supported level of the active model.

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
        startNewConversation();
        return true;
      case "/model":
        if (!arg) {
          toast(`Current model: ${activeModel()}`, "ok");
          return true;
        }
        setActiveModel(arg);
        configureSession();
        toast(`Model set to ${arg}`, "ok");
        return true;
      case "/reasoning": {
        const lvl = normalizeEffort(arg);
        if (!lvl || !(REASONING_LEVELS as readonly string[]).includes(lvl)) {
          toast(`Reasoning: ${formatEffort(effort())}`, "ok");
          return true;
        }
        setEffort(lvl);
        configureSession();
        toast(`Reasoning effort set to ${formatEffort(lvl)}`, "ok");
        return true;
      }
      default:
        return false;
    }
  }

  // --- Pairing Flow ---
  async function generatePairingToken() {
    setPairingLoading(true);
    try {
      const res = await api<RemotePairDto>("POST", "/api/remote/pair");
      setPairingData(res);
      setShowPairModal(true);
    } catch (err: any) {
      toast("Pairing request failed: " + (err?.message || err), "err");
    } finally {
      setPairingLoading(false);
    }
  }

  // Settings revert snapshot (chatbot backupForRevert): Cancel restores.
  const [settingsSnapshot, setSettingsSnapshot] = createSignal<string | null>(null);
  function openSettings(sectionId?: string) {
    try {
      setSettingsSnapshot(
        JSON.stringify({
          settings: daemonSettings(),
          mcp: mcpServers(),
          skills: skills(),
        }),
      );
    } catch {}
    setShowConfigModal(true);
    if (sectionId) {
      setTimeout(() => {
        try {
          document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {}
      }, 80);
    }
  }
  function cancelSettings() {
    try {
      const raw = settingsSnapshot();
      if (raw) {
        const s = JSON.parse(raw);
        if (s.settings) setDaemonSettings(s.settings);
        if (s.mcp) setMcpServers(s.mcp);
        if (s.skills) setSkills(s.skills);


      }
    } catch {}
    setShowConfigModal(false);
  }

  // Save Settings to Daemon (translate UI keys to the daemon's Go keys).
  function saveDaemonConfig() {
    if (!wsOpen() || activeHost()?.status !== "online") { toast("Reconnect the host before saving settings", "err"); return false; }
    const s = daemonSettings();
    sendWS({
      type: "update_config",
      requestId: "upd_" + Date.now(),
      settings: {
        temperature: s.temperature,
        auto_compact_threshold: s.autoCompactPercent,
        no_auto_title: s.noAutoTitle,
        jail_by_default: s.jailByDefault,
        auto_swarm_enabled: s.autoSwarmEnabled,
        insecure: s.insecureTls,
        http_proxy: s.httpProxy,
      },
      mcpServers: mcpServers(),
      skills: skills(),
    });
    return true;
  }

  // Add MCP Server
  const [newMcpName, setNewMcpName] = createSignal("");
  const [newMcpCmd, setNewMcpCmd] = createSignal("");
  const [newMcpArgs, setNewMcpArgs] = createSignal("");
  const [newMcpTransport, setNewMcpTransport] = createSignal("stdio");
  const [newMcpUrl, setNewMcpUrl] = createSignal("");

  function handleAddMcpServer() {
    const name = newMcpName().trim();
    const cmd = newMcpCmd().trim();
    if (!name || (!cmd && newMcpTransport() === "stdio")) {
      toast("Name and command are required", "err");
      return;
    }
    const current = { ...mcpServers() };
    current[name] = {
      command: cmd,
      args: newMcpArgs().trim() ? newMcpArgs().trim().split(/\s+/) : [],
      transport: newMcpTransport(),
      url: newMcpUrl().trim(),
    };
    setMcpServers(current);
    setNewMcpName("");
    setNewMcpCmd("");
    setNewMcpArgs("");
    setNewMcpUrl("");
    toast(`MCP Server '${name}' added`, "ok");
  }

  function handleDeleteMcpServer(name: string) {
    const current = { ...mcpServers() };
    delete current[name];
    setMcpServers(current);
    toast(`MCP Server '${name}' removed`, "ok");
  }

  // Add Skill
  const [newSkillName, setNewSkillName] = createSignal("");
  const [newSkillDesc, setNewSkillDesc] = createSignal("");
  const [newSkillBody, setNewSkillBody] = createSignal("");

  function handleAddSkill() {
    const name = newSkillName().trim();
    if (!name || !newSkillBody().trim()) {
      toast("Skill name and instruction prompt body are required", "err");
      return;
    }
    if (skills()[name]) { toast("A skill with this name already exists. Choose a different name.", "err"); return; }
    const current = { ...skills() };
    current[name] = {
      name,
      description: newSkillDesc().trim(),
      body: newSkillBody().trim(),
      enabled: true,
    };
    setSkills(current);
    setNewSkillName("");
    setNewSkillDesc("");
    setNewSkillBody("");
    toast(`Skill '${name}' created`, "ok");
  }

  function toggleSkill(name: string) {
    const current = { ...skills() };
    if (current[name]) {
      current[name] = { ...current[name], enabled: !current[name].enabled };
      setSkills(current);
    }
  }

  function handleDeleteSkill(name: string) {
    const current = { ...skills() };
    delete current[name];
    setSkills(current);
    toast(`Skill '${name}' removed`, "ok");
  }

  // Mount logic
  onMount(() => {
    void Promise.allSettled([loadGatewayModels(), loadHosts()]).then(() => {
      if (!disposed && hosts().length === 0) generatePairingToken();
    });
    // Sidebar starts closed on mobile (chatbot useMobile).
    if (isMobile()) setSidebarOpen(false);
    const onResize = () => {
      try {
        const mobile = window.innerWidth <= 768;
        if (mobile && !isMobile()) setSidebarOpen(false);
        setIsMobile(mobile);
      } catch {}
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    // Shortcuts: Ctrl/Cmd+K search, Ctrl/Cmd+N new conversation (chatbot).
    // Esc cascades: menus -> history -> editor -> preview -> confirm.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHistoryView(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        startNewConversation();
        return;
      }
      if (e.key === "Escape") {
        if (document.querySelector("[role=dialog]")) return;
        if (confirmState()) {
          confirmState()?.resolve(false);
          setConfirmState(null);
          return;
        }
        if (editingMsgIdx() != null) {
          cancelEditMsg();
          return;
        }
        if (previewFile()) {
          setPreviewFile(null);
          return;
        }
        if (historyView()) {
          setHistoryView(false);
          return;
        }
        closeMenus();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
    // Floating menus live in a Portal (outside the root div), so outside
    // clicks never reach the root closer — handle them at document level.
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("[data-floatmenu]") || t.closest("[data-menubtn]"))) return;
      closeMenus();
    };
    document.addEventListener("pointerdown", onDocDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDocDown));
  });

  createEffect(() => {
    const hid = activeHostId();
    {
      // Switching hosts swaps the whole world: nothing from the previous
      // daemon may bleed through (frontend = dumb monitor).
      untrack(() => {
        lastLocalSelection = undefined; pendingSessionChoice = undefined;
        forkRequestId = ""; setForking(false);
        setDraftMode(true);
        setCreatingSession(false);
        creationRequestId = "";
        setTaskReview(null);
        setReviewOpen(false);
        setTurnActivity(null); setTodos([]);
        showQuestion(null);
        setAppNotice(null);
        setActiveSessionId("");
        setActiveProjectId("");
        setMessages([]);
        setSessionStatus("idle");
        setPendingApproval(null);
        setSessionUsage({});
        setSessionContexts({});
        setToolProgress({}); setToolStarts({});
        for (const attachment of pendingAttachments()) {
          if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
        }
        setPendingAttachments([]);
        setInputPrompt("");
        stopThinkingTimer();
        transcriptScroll.reset();
        reconnectAttempt = 0;
        connectWebSocket(hid);
      });
    }
  });

  createEffect(() => {
    const id = pendingProjectId();
    if (id && projects().some((p) => p.id === id)) untrack(() => {
      setPendingProjectId("");
      if (draftMode()) setActiveProjectId(id);
      else startNewConversation(id);
    });
  });

  // Default project: the one holding the newest conversation (computed from
  // the mirrored data — same answer on every device), else the first one.
  const newestSessionProjectId = createMemo(() => {
    let best: SessionSummary | null = null;
    for (const s of sessions()) {
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    if (!best) return "";
    return projectForDirectory(best.cwd, projects())?.id || "";
  });
  createEffect(() => {
    const list = projects();
    if (list.length === 0) {
      if (activeProjectId()) setActiveProjectId("");
      return;
    }
    if (!list.some((p) => p.id === activeProjectId())) {
      const fallback = newestSessionProjectId();
      setActiveProjectId(list.some((p) => p.id === fallback) ? fallback : list[0].id);
    }
  });

  // A conversation that vanished from the mirror (deleted here or on
  // another device) must leave no trace: close the transcript, purge its
  // usage/files/draft leftovers and drop it from bulk selection.
  let knownSessionIds = new Set<string>();
  createEffect(() => {
    const cur = new Set(sessions().map((s) => s.id));
    for (const id of knownSessionIds) {
      if (cur.has(id)) continue;
      purgeSessionTrace(id);
      if (activeSessionId() === id) {
        setDraftMode(true);
        setActiveSessionId("");
        setMessages([]);
        setSessionStatus("idle");
      }
      if (selectedSessions().has(id)) {
        setSelectedSessions((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
    knownSessionIds = cur;
  });

  // Default open conversation: the newest one inside the active project.
  // If the project has none, stay blank — typing in the composer starts one.
  createEffect(() => {
    if (draftMode() || activeSessionId()) return;
    if (!activeProjectId()) return;
    const ap = activeProject();
    if (!ap) return;
    const fresh = sessionsOfProject(ap.id)[0];
    if (fresh) selectSession(fresh.id);
  });

  // Daemon config mirror → local settings signals. Never clobbers an open
  // Settings modal (that would fight the user's in-flight edits). Model and
  // effort are restored separately from each session's own options.
  createEffect(() => {
    const doc = configDoc();
    if (!doc || showConfigModal()) return;
    const s: any = doc.settings || {};
    setDaemonSettings({
      temperature: typeof s.temperature === "number" ? s.temperature : 0.7,
      autoCompactPercent:
        s.autoCompactPercent ??
        s.autoCompactThreshold ??
        s.auto_compact_threshold ??
        80,
      noAutoTitle: s.noAutoTitle ?? s.no_auto_title ?? false,
      jailByDefault: s.jailByDefault ?? s.jail_by_default ?? false,
      autoSwarmEnabled: s.autoSwarmEnabled ?? s.auto_swarm_enabled ?? false,
      insecureTls: s.insecureTls ?? s.insecure ?? false,
      httpProxy: s.httpProxy ?? s.http_proxy ?? "",
      maxExecutionTimeSec: s.maxExecutionTimeSec ?? 600,
    });

    if (doc.mcpServers && typeof doc.mcpServers === "object") setMcpServers(doc.mcpServers);
    if (doc.skills && typeof doc.skills === "object") setSkills(doc.skills);
  });

  createEffect(() => {
    const catalog = gatewayModels();
    const saved = configDoc()?.lastSelection;
    if (lastLocalSelection && matchesChoice(saved, lastLocalSelection)) lastLocalSelection = undefined;
    if (activeSessionId()) return;
    const selection = lastLocalSelection || saved;
    setActiveModel(catalog.find((m) => m.id === selection?.model)?.id || catalog[0]?.id || "");
    applyOptions(selection);
  });

  // Auto-poll hosts while waiting for initial daemon pairing
  createEffect(() => {
    if (hosts().length === 0 || showPairModal()) {
      const interval = setInterval(() => {
        loadHosts();
      }, 3000);
      onCleanup(() => clearInterval(interval));
    }
  });

  // Per-session composer drafts (survive session switches, like the Vue app).
  createEffect(() => {
    const sid = activeSessionId();
    if (!sid) return;
    try {
      setInputPrompt(localStorage.getItem(`llmgw-draft:${sid}`) || "");
    } catch {}
  });
  createEffect(() => {
    const text = inputPrompt();
    const sid = activeSessionId();
    if (!sid) return;
    try {
      if (text) localStorage.setItem(`llmgw-draft:${sid}`, text);
      else localStorage.removeItem(`llmgw-draft:${sid}`);
    } catch {}
  });

  // Close popover menus on outside click / Escape.
  function closeMenus() {
    setModeMenuOpen(false);
    setAccessMenuOpen(false);
    setHostMenuOpen(false);
    setNewProjectMenuOpen(false);
    setAddContextOpen(false);
    setFilesMenuOpen(false);
    setModelMenuOpen(false);
    setProjectMenuOpen(false);
    setUsageOpen(false);
  }


  // Antigravity-style tool rows: one line per call, expandable output,
  // clickable files, inline diffs for edits.

  // (openToolPreview modal: removed — every collapsible tool row already
  //  is the file/diff viewer with its own scroll. Copy stays inline.)



  /** Newest in-flight tool progress line inside a series (spinner sidecar). */
  function specialProgress(units: ToolUnit[]): string | undefined {
    for (let i = units.length - 1; i >= 0; i--) {
      const id = units[i].call?.toolId;
      const t = id ? toolProgress()[id] : undefined;
      if (t) return t;
    }
    return undefined;
  }

  // on every token remounted Markdown and collapsed its height before repaint.
  const [renderState, setRenderState] = createStore<{ blocks: (RenderBlock & { id: string })[] }>({ blocks: [] });
  createEffect(() => {
    const blocks = buildRenderBlocks(messages()).map((block) => ({ ...block, id: block.msg.id }));
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

  /** Raw daemon index of a render block's lead message. */
  function blockRawIdx(block: RenderBlock): number {
    const i = messages().findIndex((msg) => msg.id === block.msg.id);
    return i >= 0 ? i : 0;
  }

  const view: RemoteCodeViewCtx = {
    accessBtn,
    accessMenuOpen,
    activeContext,
    activeHost,
    activeHostId,
    activeModel,
    activeProject,
    activeSession,
    activeSessionId,
    activeUsage,
    addBtn,
    addContextOpen,
    agentMode,
    answerQuestion,
    appNotice,
    blockRawIdx,
    cancelCurrentTurn,
    cancelEditMsg,
    cancelSettings,
    cancelTurnForSession,
    checkWorkspace,
    choiceState,
    closeMenus,
    closeSidebarOnMobile,
    configureSession,
    confirmState,
    connectionState,
    contextBtn,
    convWidth,
    convWidthClass,
    copiedMsgId,
    copyMsg,
    createProject,
    creatingSession,
    currentProject,
    daemonSettings,
    deleteMsg,
    deleteProject,
    deleteSelected,
    deleteSession,
    downloadPreviewFile,
    draftMode,
    editingMsgIdx,
    editingMsgText,
    effort,
    elapsedLabel,
    exitSelectionMode,
    expandedThinking,
    filesBtn,
    filesMenuOpen,
    folderCurrent,
    folderEntries,
    folderError,
    folderLoading,
    folderParent,
    forkMessage,
    forking,
    generatePairingToken,
    growWindow,
    handleAddMcpServer,
    handleAddSkill,
    handleDeleteMcpServer,
    handleDeleteSkill,
    handleFiles,
    hiddenCount,
    historyView,
    hostBtn,
    hostMenuOpen,
    hosts,
    inputPrompt,
    isAtBottom,
    isMobile,
    isProjectExpanded,
    keepChanges,
    loadHosts,
    looseSessions,
    matchQuery,
    mcpServers,
    messages,
    modeBtn,
    modeMenuOpen,
    modelBtn,
    modelMenuOpen,
    modelPickerBody,
    newMcpArgs,
    newMcpCmd,
    newMcpName,
    newMcpTransport,
    newMcpUrl,
    newProjBtn,
    newProjectMenuOpen,
    newProjectPath,
    newSkillBody,
    newSkillDesc,
    newSkillName,
    onChatScroll,
    openNewProjectModal,
    openSettings,
    openStoredPreview,
    pairingData,
    pairingLoading,
    pendingApproval,
    pendingAttachments,
    pendingQuestion,
    pickProject,
    pickSlash,
    pinSelected,
    previewCopied,
    previewFile,
    previewPending,
    projBtn,
    projectMenuOpen,
    projectSessions,
    projects,
    questionError,
    questionSubmitting,
    queueDaemonSearch,
    quickStartProject,
    rawIdx,
    regenerateMsg,
    removeHost,
    removePendingAttachment,
    renameText,
    renamingId,
    renderBlocks,
    requestFolders,
    requestReview,
    respondApproval,
    restorePreviewFile,
    reviewError,
    reviewLoading,
    reviewOpen,
    saveDaemonConfig,
    saveEditMsg,
    scrollToBottom,
    searchResults,
    selectSession,
    selectedSessions,
    selectedSkills,
    selectionMode,
    sendPrompt,
    sessionFiles,
    sessionFilter,
    sessionListToggle,
    sessionStatus,
    sessions,
    setAccessMenuOpen,
    setActiveHostId,
    setAddContextOpen,
    setAgentMode,
    setAppNotice,
    setChatContainerRef,
    setChatContentRef,
    setConfirmState,
    setConvWidth,
    setDaemonSettings,
    setEditingMsgText,
    setExpandedThinking,
    setFilesMenuOpen,
    setHistoryView,
    setHostMenuOpen,
    setInputPrompt,
    setIsAtBottom,
    setModeMenuOpen,
    setModelMenuOpen,
    setNewMcpArgs,
    setNewMcpCmd,
    setNewMcpName,
    setNewMcpTransport,
    setNewMcpUrl,
    setNewProjectMenuOpen,
    setNewProjectPath,
    setNewSkillBody,
    setNewSkillDesc,
    setNewSkillName,
    setPreviewCopied,
    setPreviewFile,
    setProjectMenuOpen,
    setRenameText,
    setRenamingId,
    setReviewOpen,
    setSearchResults,
    setSelectedSkills,
    setSelectionMode,
    setSessionFilter,
    setShowConfigModal,
    setShowNewProjectModal,
    setShowPairModal,
    setShowTruncateInput,
    setSidebarOpen,
    setSlashIndex,
    setTodosOpen,
    setTruncateTokens,
    setUsageOpen,
    setVerboseChat,
    setYoloMode,
    showConfigModal,
    showNewProjectModal,
    showPairModal,
    showTruncateInput,
    sidebarOpen,
    skills,
    slashIndex,
    slashMatches,
    sortedSessions,
    specialProgress,
    startEditMsg,
    startNewConversation,
    submitRename,
    taskReview,
    thinkingElapsed,
    thinkingIndex,
    thinkingStart,
    timeAgo,
    toast,
    todos,
    todosOpen,
    togglePin,
    toggleProjectExpanded,
    toggleSessionSelect,
    toggleSkill,
    toggleToolGroup,
    toggleToolOpen,
    toolGroupOpen,
    toolOpen,
    toolProgress,
    toolStarts,
    transcriptScroll,
    truncatePreviewFile,
    truncateTokens,
    turnActivity,
    turnClock,
    turnLabel,
    undoChanges,
    usageOpen,
    verboseChat,
    visibleBlocks,
    visibleSessions,
    workspace,
    workspaceBlocked,
    workspacePath,
    workspaceState,
    wsOpen,
    yoloMode,
  };

  const simpleCtx = view as unknown as SimpleModalsCtx;

  return (
    <div class="fixed inset-0 w-full h-dvh flex flex-col bg-ink-950 text-ink-100 overflow-hidden font-sans select-none z-50">
      <RemoteHints />
      {/* Main Workspace Layout or Connect Host Onboarding */}
      <Show
        when={hosts().length > 0}
        fallback={<Onboarding {...view} />}
      >
        <div class="flex-1 flex min-h-0 overflow-hidden relative">
          <WorkspaceSidebar {...view} />
          <main class="flex-1 flex flex-col min-w-0 bg-ink-950 relative">
            <TranscriptView {...view} />
            <Composer {...view} />
          </main>
        </div>
      </Show>

      <NewProjectModal {...simpleCtx} />
      <ReviewModal {...simpleCtx} />
      <PreviewModal
        previewFile={previewFile} setPreviewFile={setPreviewFile} previewCopied={previewCopied}
        setPreviewCopied={setPreviewCopied} downloadPreviewFile={downloadPreviewFile}
        restorePreviewFile={restorePreviewFile} truncatePreviewFile={truncatePreviewFile}
        showTruncateInput={showTruncateInput} setShowTruncateInput={setShowTruncateInput}
        truncateTokens={truncateTokens} setTruncateTokens={setTruncateTokens}
      />
      <ChoiceModal {...simpleCtx} />
      <ConfirmModal {...simpleCtx} />
      <PairModal {...simpleCtx} />
      <SettingsModal {...(view as unknown as import("./modals/SettingsModal").SettingsModalCtx)} />
    </div>
  );
}
