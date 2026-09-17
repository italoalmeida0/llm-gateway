import {
  createSignal,
  createEffect,
  createMemo,
  batch,
  untrack,
  onMount,
  onCleanup,
  Show,
  For,
} from "solid-js";
import { useUI, useHost } from "./ctx";
import { RemoteHints } from "./presentation";
import { projectForDirectory } from "./paths";
import { contextDisplay, type GatewayModel } from "./context";
import { api } from "../api";
import { Onboarding } from "./components/Onboarding";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { TranscriptView } from "./components/TranscriptView";
import { Composer } from "./components/Composer";
import { ModelPickerBody } from "./components/ModelPickerBody";
import {
  NewProjectModal, ChoiceModal, ConfirmModal, PairModal,
} from "./modals/SimpleModals";
import { PreviewModal } from "./modals/PreviewModal";
import { SettingsModal } from "./modals/SettingsModal";
import {
  RemoteCodeProvider,
  type ComposerCtxValue, type HostCtxValue, type ModalCtxValue,
  type SessionCtxValue, type TranscriptCtxValue, type UICtxValue,
} from "./ctx";
import { parseDaemonMessage, type DaemonMessage } from "./daemon-protocol";
import { createNotice } from "./hooks/useNotice";
import { createTurnNotify } from "./hooks/useTurnNotify";
import { createPushSubscription } from "./hooks/usePushSubscription";
import { createConvert } from "./hooks/useConvert";
import { createQueue } from "./hooks/useQueue";
import { createBackground } from "./hooks/useBackground";
import { createDaemonUpdate } from "./hooks/useDaemonUpdate";
import { createModals } from "./hooks/useModals";
import { createRelay } from "./hooks/useRelay";
import { createMirror } from "./hooks/useMirror";
import { createTranscript } from "./hooks/useTranscript";
import { createSessionOptions } from "./hooks/useSessionOptions";
import { createReview } from "./hooks/useReview";
import { createTurnChanges } from "./hooks/useTurnChanges";
import { createComposer } from "./hooks/useComposer";
import { createProjects } from "./hooks/useProjects";
import { createWorkspace } from "./hooks/useWorkspace";
import { createHosts } from "./hooks/useHosts";
import { createSettings } from "./hooks/useSettings";

/** Full-screen update freeze: while the daemon handoff is frozen, block
 * everything on this host except switching hosts / connecting another /
 * cancelling the update. Stages stream from daemon_update.freezeStage. */
function UpdateFreezeOverlay() {
  const ui = useUI();
  const hosts = useHost();
  const frozen = () => ui.daemonUpdate.info()?.frozen ?? false;
  const stage = () => ui.daemonUpdate.info()?.freezeStage || "preparing update";
  return (
    <Show when={frozen()}>
      <div class="fixed inset-0 z-[80] flex items-center justify-center bg-ink-950/90 backdrop-blur-sm">
        <div class="w-[min(420px,90vw)] rounded-2xl border border-line bg-elev p-6 text-center shadow-2xl">
          <div class="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-2 border-line border-t-brand-500" />
          <h2 class="text-base font-semibold text-ink-100">Updating daemon…</h2>
          <p class="mt-1 text-xs text-ink-400">{stage()}</p>
          <p class="mt-3 text-[11px] text-ink-500">
            Sessions are paused safely — nothing is lost. You can switch hosts meanwhile.
          </p>
          <div class="mt-4 flex items-center justify-center gap-2">
            <button class="btn btn-xs" onClick={() => ui.daemonUpdate.cancel()}>
              Cancel update
            </button>
          </div>
          <div class="mt-4 border-t border-line pt-3 text-left">
            <p class="mb-2 text-[11px] font-medium text-ink-400">Other hosts</p>
            <For each={hosts.hosts()}>
              {(h) => (
                <button
                  class="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs hover:bg-ink-800 cursor-pointer"
                  onClick={() => hosts.setActiveHostId(h.id)}
                >
                  <span class="text-ink-200">{h.name || h.id}</span>
                  <span class="text-[11px] text-ink-500">{h.status}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}

export default function IndirectCodePage() {
  // --- Domains (each hook owns its state; the page orchestrates) ---
  const notice = createNotice();
  const modals = createModals({ toast: notice.toast });
  // Created early: only needs `send`, wired to the relay below.
  let relaySend: (payload: any) => void = () => {};
  const convert = createConvert({ send: (payload) => relaySend(payload) });

  const [draftMode, setDraftMode] = createSignal(true);
  const [creatingSession, setCreatingSession] = createSignal(false);
  let creationRequestId = "";
  const [activeSessionId, setActiveSessionId] = createSignal<string>("");
  let restoredHostId = "";
  let restoreTimeout: ReturnType<typeof setTimeout> | undefined;

  const hosts = createHosts({
    toast: notice.toast,
    showConfirm: modals.showConfirm,
    onHostRemoved: (id) => { void mirror.dataLayer.disposeHost(id); },
  });

  const relay = createRelay({
    getHostId: () => hosts.activeHostId(),
    onMessage: (data) => {
      const msg = parseDaemonMessage(data);
      if (!msg) {
        console.warn("[rc] ignoring malformed relay message");
        return;
      }
      batch(() => handleIncomingMessage(msg));
    },
    onOpen: (hostId) => {
      void loadGatewayModels();
      mirror.dataLayer.storeFor(hostId).syncAll().then(() => {
        const hid = hosts.activeHostId();
        if (hid === hostId && restoredHostId !== hid) {
          let saved: string | null = null;
          try { saved = localStorage.getItem(`llmgw-rc-session:${hid}`); } catch {}
          if (saved && saved !== "new") {
            const fresh = mirror.sessions();
            if (fresh.some((s) => s.id === saved)) {
              clearTimeout(restoreTimeout);
              restoredHostId = hid;
              selectSession(saved);
            } else {
              clearTimeout(restoreTimeout);
              restoredHostId = hid;
              startNewConversation();
              try { localStorage.setItem(`llmgw-rc-session:${hid}`, "new"); } catch {}
            }
          }
        }
      }).catch((e) => console.warn("[rc-sync] syncAll:", e));
      if (activeSessionId()) { transcript.fetchSession(activeSessionId()); turnChanges.requestBalloons(); background.refresh(); }
    },
    onClose: () => {
      options.resetPendingChoice();
      transcript.clearForkRequest();
      transcript.setForking(false);
      forkKind = null;
      pendingDiscardReloadSid = null;
      setCreatingSession(false);
      projects.setFolderLoading(false);
      mirror.dataLayer.disconnect();
      transcript.stopThinkingTimer();
      composer.cancelUploads();
      transcript.editAttachments.cancelUploads();
    },
    ensureAuth: () => hosts.loadHosts(),
    isActiveHost: (hostId) => hosts.activeHostId() === hostId,
  });
  const wsOpen = () => relay.wsOpen();
  relaySend = (payload) => relay.send(payload);
  const isHostOnline = () => hosts.activeHost()?.status === "online";

  const mirror = createMirror({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getHostId: () => hosts.activeHostId(),
  });

  const [verboseChat, setVerboseChat] = createSignal(
    (() => {
      try {
        return localStorage.getItem("llmgw-rc-verbose") !== "0";
      } catch {
        return true;
      }
    })(),
  );
  const [hideToolMessages, setHideToolMessages] = createSignal(
    (() => {
      try {
        return localStorage.getItem("llmgw-rc-hide-tool-messages") !== "0";
      } catch {
        return true;
      }
    })(),
  );

  const transcript = createTranscript({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getSessionId: () => activeSessionId(),
    getHostId: () => hosts.activeHostId(),
    getProjectId: () => projects.activeProject()?.id || "",
    toast: notice.toast,
    showChoice: modals.showChoice,
    onTurnIdle: () => turnChanges.requestBalloons(),
    onUsageContext: (ctx) => {
      const configured = gatewayModels().find((m) => m.id === ctx.model)?.context ?? 0;
      if (configured !== ctx.windowTokens) void loadGatewayModels();
    },
    onDiscardResendOrRegenerate: (sid: string) => {
      pendingDiscardReloadSid = sid;
    },
    onForkKind: (kind: "resend" | "regenerate" | "fork") => {
      forkKind = kind;
    },
  });

  const daemonUpdate = createDaemonUpdate({
    send: (payload) => relay.send(payload),
    toast: notice.toast,
  });

  const background = createBackground({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getSessionId: () => activeSessionId(),
    toast: notice.toast,
    onTerminalResult: (job) => transcript.foldBgResult(job),
  });

  const queue = createQueue({
    send: (payload) => relay.send(payload),
    getSessionId: () => activeSessionId(),
    isOpen: () => relay.wsOpen(),
    isHostOnline: () => hosts.activeHost()?.status === "online",
    toast: notice.toast,
  });

  const options = createSessionOptions({
    send: (payload) => relay.send(payload),
    getSessionId: () => activeSessionId(),
  });

  const review = createReview({
    getHostId: () => hosts.activeHostId(),
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getSessionId: () => activeSessionId(),
    isSessionRunning: () => transcript.sessionStatus() === "running",
    toast: notice.toast,
    showConfirm: modals.showConfirm,
    isHostOnline,
  });

  const turnChanges = createTurnChanges({
    send: (payload) => relay.send(payload),
    getSessionId: () => activeSessionId(),
    toast: notice.toast,
    showConfirm: modals.showConfirm,
  });

  const composer = createComposer({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    isDisposed: () => relay.isDisposed(),
    getSessionId: () => activeSessionId(),
    getHostId: () => hosts.activeHostId(),
    getProjectId: () => projects.activeProject()?.id || "",
    getModel: () => options.activeModel(),
    getAvailableModels: () => gatewayModels().map((m) => m.id),
    getOptions: () => options.sessionOptions(),
    isSessionRunning: () => transcript.sessionStatus() === "running",
    isWorkspaceBlocked: () => workspace.workspaceBlocked(),
    checkWorkspace: () => workspace.checkWorkspace(),
    isHostOnline,
    toast: notice.toast,
    t: transcript,
    o: {
      configureSession: () => options.configureSession(),
      setActiveModel: (v: string) => options.setActiveModel(v),
      setEffort: (v: string) => options.setEffort(v),
    },
    onClearConversation: () => startNewConversation(),
    onBeginConversation: () => beginConversationWith(),
    onQueueMessage: (text, attachmentIds, model, yolo) => {
      queue.addToQueue(text, attachmentIds, model, yolo);
      notice.toast("Queued — sends after agent finishes", "ok");
    },
    isCreatingSession: () => creatingSession(),
  });

  const projects = createProjects({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getHostId: () => hosts.activeHostId(),
    sessions: () => mirror.sessions(),
    projects: () => mirror.projects(),
    toast: notice.toast,
    showConfirm: modals.showConfirm,
    isHostOnline,
  });

  const activeSession = createMemo(() => {
    return mirror.sessions().find((s) => s.id === activeSessionId()) ?? null;
  });
  const currentProject = createMemo(() => activeSessionId() ? projectForDirectory(activeSession()?.cwd || "", mirror.projects()) : projects.activeProject());

  const workspace = createWorkspace({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getSessionId: () => activeSessionId(),
    getSessionCwd: () => activeSession()?.cwd || "",
    getProjectPath: () => projects.activeProject()?.path || "",
    getProjectId: () => projects.activeProject()?.id,
    getFolderStatus: () => projects.activeProject()?.folderStatus,
    getHostId: () => hosts.activeHostId(),
    isConnected: () => relay.connectionState() === "connected",
  });
  transcript.setWorkspaceSink(workspace.setWorkspace);

  const settings = createSettings({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    isHostOnline,
    toast: notice.toast,
    getConfigDoc: () => mirror.configDoc(),
 getHostId: () => hosts.activeHostId(),
 refreshConfig: () => mirror.dataLayer.storeFor(hosts.activeHostId()).syncAll(),
  });

  // Turn-end notifications (Camada A: tab open). Fed BEFORE the
  // active-host filter below so turns on any host/session notify.
  const turnNotify = createTurnNotify({
    hosts: () => hosts.hosts(),
    sessions: () => mirror.sessions(),
    toast: notice.toast,
    onOpenSession: (hostId, sessionId) => {
      try { window.focus(); } catch {}
      if (hostId !== hosts.activeHostId()) hosts.setActiveHostId(hostId);
      selectSession(sessionId);
      try {
        if (location.hash !== "#/code") location.hash = "#/code";
      } catch {}
    },
  });
  const pushSub = createPushSubscription({
    enabled: () => turnNotify.notifyOn(),
    toast: notice.toast,
  });

  // Register the push Service Worker once (Camada B: all tabs closed).
  // Registration is idempotent; failures degrade to Camada A only.
  // After registration, auto-sync the subscription (farm-game style): if
  // the master toggle is ON and permission is granted, ensure the server
  // knows this browser — no manual toggle dance required.
  onMount(() => {
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) {
        void navigator.serviceWorker
          .register("/push-sw.js")
          .then(() => {
            if (turnNotify.notifyOn()) void pushSub.sync();
          })
          .catch((e) => {
            console.warn("[push] service worker registration failed:", e);
          });
      }
    } catch {}
  });

  // --- Page's own state (orchestration + view) ---
  // Gateway Models (Fetched live from /api/me/models)
  const [gatewayModels, setGatewayModels] = createSignal<GatewayModel[]>([]);
  const activeModelObj = createMemo(() =>
    gatewayModels().find((model) => model.id === options.activeModel()),
  );
  const activeModelName = createMemo(() => {
    const found = activeModelObj();
    if (found?.name) return found.name;
    const raw = options.activeModel();
    if (!raw) return "Select model";
    return raw.split("/").pop() || raw;
  });
  const activeContext = createMemo(() => contextDisplay(
    transcript.sessionContexts()[activeSessionId()] ?? null,
    activeModelObj(),
  ));


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
        m.id.toLowerCase().includes(q) ||
        (m.name || "").toLowerCase().includes(q) ||
        (m.provider || "").toLowerCase().includes(q) ||
        (m.upstreamModel || "").toLowerCase().includes(q),
    );
  });

  // UI state
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  // Mobile: drawer below 768px regardless of touch (small desktop windows too).
  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.innerWidth <= 768 : false,
  );

  // Anchor refs for floating menus (floating-ui positions them in a Portal).
  let newProjBtn: HTMLButtonElement | undefined;
  let modelBtn: HTMLButtonElement | undefined;
  let projBtn: HTMLButtonElement | undefined;
  let addBtn: HTMLButtonElement | undefined;
  let contextBtn: HTMLButtonElement | undefined;

  let forkKind: "resend" | "regenerate" | "fork" | null = null;
  let pendingDiscardReloadSid: string | null = null;
  // Hidden-tab coalescing: while the tab is in background, agent_event
  // deltas accumulate here instead of rendering one by one (each would
  // schedule Solid renders + markdown/highlight + rAF frames that never
  // run hidden, then all flush at once on return = the 1-2s freeze).
  // Cheap status-ish events still apply live; text/tool streams wait.
  // On visible, text deltas for the same carrier are summed before a
  // single apply, then the queue drains in order.
  let hiddenEventQueue: { sessionId: string; event: any }[] = [];
  const HIDDEN_LIVE_TYPES = new Set([
    "turn_start", "turn_end", "usage", "todo_update", "compact_progress",
    "retry", "user_message",
  ]);
  function flushHiddenQueue() {
    if (hiddenEventQueue.length === 0) return;
    const q = hiddenEventQueue;
    hiddenEventQueue = [];
    // Coalesce consecutive text/reasoning deltas and tool-args deltas.
    const out: { sessionId: string; event: any }[] = [];
    for (const item of q) {
      const prev = out[out.length - 1];
      const t = item.event?.type;
      if (
        prev && prev.sessionId === item.sessionId &&
        (t === "text_delta" || t === "reasoning_delta" || t === "tool_use_args") &&
        prev.event?.type === t &&
        (t !== "tool_use_args" || prev.event?.id === item.event?.id)
      ) {
        prev.event = { ...prev.event, delta: (prev.event.delta || "") + (item.event.delta || ""), text: ((prev.event as any).text || "") + ((item.event as any).text || "") };
        continue;
      }
      out.push(item);
    }
    for (const item of out) transcript.handleAgentEvent(item.sessionId, item.event);
  }

  function reloadSessionFromDaemon(sid: string) {
    if (!sid || sid !== activeSessionId()) return;
    const s = mirror.sessions().find((x) => x.id === sid);
    if (s) {
      transcript.setSessionStatus(s.status);
      if (s.model) options.setActiveModel(s.model);
      if (s.options) options.applyOptions(s.options);
      if (typeof s.todosOpen === "boolean") transcript.applyTodosOpenFromRemote(s.todosOpen);
    }
    transcript.fetchSession(sid);
    turnChanges.requestBalloons();
  }

  // --- Fetch Gateway Models ---
  async function loadGatewayModels() {
    try {
      const res = await api<{ models: GatewayModel[] }>("GET", "/api/me/models");
      if (relay.isDisposed()) return;
      const models = res.models || [];
      setGatewayModels(models);
      if (!models.some((m) => m.id === options.activeModel())) {
        options.setActiveModel(models[0]?.id || "");
      }
    } catch {
      notice.toast("Could not refresh the gateway model catalog", "err");
    }
  }

  function closeSidebarOnMobile() {
    if (isMobile()) setSidebarOpen(false);
  }

  // --- Session orchestration (composes the domains) ---
  function selectSession(id: string) {
    if (creatingSession()) return;
    options.resetPending();
    setDraftMode(false);
    transcript.resetForSession();
    turnChanges.reset();
    notice.setAppNotice(null);
    transcript.beginLoad(id);
    setActiveSessionId(id);
    try {
      const hid = hosts.activeHostId();
      if (hid) localStorage.setItem(`llmgw-rc-session:${hid}`, id);
    } catch {}
    projects.setSearchResults([]);
    composer.clearAttachments();
    const s = mirror.sessions().find((x) => x.id === id);
    if (s) {
      transcript.setSessionStatus(s.status);
      if (s.model) options.setActiveModel(s.model);
      if (s.options) options.applyOptions(s.options);
      if (typeof s.todosOpen === "boolean") transcript.applyTodosOpenFromRemote(s.todosOpen);
    }
    transcript.fetchSession(id);
    turnChanges.requestBalloons();
    // The terminal snapshots that fold bg results into rows only arrive
    // on transitions — a freshly opened session needs its own, or
    // finished jobs would sit on the "still running" placeholder.
    background.refresh();
  }

  // Open a centered draft without creating a conversation on the host.
  function startNewConversation(projectId?: string) {
    if (creatingSession()) return;
    transcript.resetForSession();
    setDraftMode(true);
    setHistoryView(false);
    setActiveSessionId("");
    try {
      const hid = hosts.activeHostId();
      if (hid) localStorage.setItem(`llmgw-rc-session:${hid}`, "new");
    } catch {}
    turnChanges.reset();
    notice.setAppNotice(null);
    options.applyOptions(options.getLastLocalSelection() || mirror.configDoc()?.lastSelection);
    composer.clearAttachments();
    if (projectId) projects.setActiveProjectId(projectId);
    if (isMobile()) setSidebarOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus());
  }

  // No session is ever a dead end: typing + Enter auto-starts a
  // conversation inside the active project, then the text is delivered.
  function beginConversationWith() {
    const proj = projects.activeProject();
    if (!proj) {
      notice.toast("Create a project first", "err");
      return;
    }
    if (!relay.wsOpen()) {
      notice.toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    if (creatingSession()) return;
    setCreatingSession(true);
    creationRequestId = crypto.randomUUID();
    relay.send({ type: "create_session", requestId: creationRequestId, cwd: proj.path, title: "", model: options.activeModel(), options: options.sessionOptions() });
  }

  async function deleteSession(id: string, e?: MouseEvent) {
    e?.stopPropagation();
    const ok = await modals.showConfirm({
      title: "Delete conversation?",
      message: "This conversation will be permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) relay.send({ type: "delete_session", sessionId: id });
  }

  /** Removes local leftovers of a session that vanished from the mirror. */
  function purgeSessionTrace(id: string) {
    transcript.purgeSession(id);
    review.purgeSessionFiles(id);
    queue.purgeQueue(id);
    // Local drafts (composer + inline edits) live only in this browser:
    // drop them together with the session trace.
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === `llmgw-draft:${hosts.activeHostId()}:${id}` || k.startsWith(`llmgw-edit:${hosts.activeHostId()}:${id}:`))) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {}
  }

  // --- Message dispatcher (delegation by domain) ---
  // The daemon speaks two dialects on the wire: Anthropic-style blocks
  // ({type:"text"|"tool_use"|"tool_result"}) and raw Go structs
  // ({text}, {id,name,arguments}, {call_id,content,is_error},
  // {reasoning_id,summary}, {mime_type,data}). Parse both (utils/wire,
  // transcript/updaters).
  function handleIncomingMessage(msg: DaemonMessage) {
    // SignalDB sync protocol messages (pull responses / change pings) are
    // owned by the data layer; everything else is event-driven below.
    if (mirror.dataLayer.handleMessage(msg)) return;
    // Turn-end notifier sees every host/session (any-host coverage),
    // before the foreground-only filter below.
    turnNotify.noteMessage(msg);
    // The relay fans out every host; foreground events belong to the selected host only.
    if (msg.type !== "host_status" && msg.hostId && msg.hostId !== hosts.activeHostId()) return;
    if (msg.type === "error" && msg.requestId === transcript.forkRequestId()) {
      transcript.setForking(false);
      forkKind = null;
    }
    if (settings.handleSettingsMessage(msg)) return;
    switch (msg.type) {
      case "relay_connected":
        break;
      case "host_status": {
        if (msg.hostId === hosts.activeHostId() && msg.status === "online") {
          mirror.dataLayer.storeFor(msg.hostId).syncAll().catch((e) => console.warn("[rc-sync] syncAll:", e));
          if (activeSessionId()) transcript.fetchSession(activeSessionId());
          background.refresh();
        }
        hosts.noteHostStatus(msg.hostId, msg.status);
        break;
      }

      // NOTE: sessions/projects/config lists never arrive as events — the
      // SignalDB sync owns them (daemon change ping → pull → collection).
      // The events below are action acks that drive local continuation.

      case "session_forked": {
        if (!transcript.forking() || msg.requestId !== transcript.forkRequestId() || !msg.session?.id) break;
        transcript.setForking(false);
        mirror.dataLayer.storeFor(hosts.activeHostId()).syncAll().catch((e) => console.warn("[rc-sync] syncAll:", e));
        selectSession(msg.session.id);
        if (msg.resent) {
          transcript.setSessionStatus("running");
          if (forkKind === "regenerate") {
            notice.toast("Fork created — regenerating response", "ok");
          } else {
            notice.toast("Fork created — resending with edited text", "ok");
          }
        } else {
          notice.toast("Conversation fork created", "ok");
        }
        forkKind = null;
        break;
      }
      case "session_created": {
        if (!creatingSession() || msg.requestId !== creationRequestId) break;
        const r = msg.session;
        if (!r?.id) break;
        setCreatingSession(false);
        setDraftMode(false);
        const firstDraft = composer.inputPrompt();
        setActiveSessionId(r.id);
        try {
          const hid = hosts.activeHostId();
          if (hid) localStorage.setItem(`llmgw-rc-session:${hid}`, r.id);
        } catch {}
        composer.setInputPrompt(firstDraft);
        try { localStorage.removeItem(`llmgw-draft:${hosts.activeHostId()}:new`); } catch {}
        options.applyOptions(options.getLastLocalSelection() || r.options);
        // Attachments stay in the draft until upload succeeds on this new session.
        void composer.sendPrompt();
        break;
      }
      case "project_created": {
        const p = projects.noteProjectCreated(msg);
        if (!p) break;
        mirror.dataLayer.storeFor(hosts.activeHostId()).syncAll().catch((e) => console.warn("[rc-sync] syncAll:", e));
        notice.toast(`Project '${p.name || "Project"}' added`, "ok");
        break;
      }
      case "folders": {
        projects.noteFolders(msg);
        break;
      }
      case "turn_file_changes": {
        // Single event for both states: live=true while the turn runs
        // (balloon floats above the composer), live=false once finished
        // (balloon sits below its turn). The frontend only reads changes.
        if (msg.sessionId && msg.sessionId === activeSessionId() && msg.balloon) {
          turnChanges.noteBalloon(msg.balloon, msg.live === true);
        }
        break;
      }
      case "turn_changes": {
        if (msg.sessionId && msg.sessionId === activeSessionId()) {
          turnChanges.noteTurnChanges(msg);
        }
        break;
      }
      case "turn_changes_undone": {
        if (msg.sessionId && msg.sessionId === activeSessionId()) {
          turnChanges.noteUndone(msg);
        }
        break;
      }

      case "attachment_uploaded": {
        const a = msg.attachment;
        if (!a?.id) break;
        if (msg.sessionId) review.addSessionFile(msg.sessionId, a);
        composer.noteAttachmentUploaded(msg.requestId, a, msg.sessionId);
        transcript.editAttachments.noteAttachmentUploaded(msg.requestId, a, msg.sessionId);
        queue.editDraft.noteAttachmentUploaded(msg.requestId, a, msg.sessionId);
        break;
      }

      case "search_results": {
        projects.noteSearchResults(msg);
        break;
      }

      case "notice": {
        if (msg.message) notice.toast(msg.message, "ok");
        break;
      }

      case "file_matches": {
        composer.mentions.noteMatches(msg);
        transcript.editMentions.noteMatches(msg);
        break;
      }
      case "attachment_data": {
        review.noteAttachmentData(msg);
        break;
      }

      case "session_data": {
        if (transcript.noteSessionDataRequestGuard(msg.requestId)) break;
        // Historic full-record shape; render it like session_content.
        const r = msg.session;
        if (!r) break;
        const sid = r.id || msg.sessionId;
        if (sid) {
          const atts = r.attachments || r.Attachments || [];
          review.noteSessionFiles(sid, atts);
          queue.noteQueue(sid, r.queue);
        }
        if (sid && sid === activeSessionId()) {
          transcript.applySnapshot(sid, r);
          turnChanges.applySnapshot(r);
          options.reconcileServerSelection(sid, r.model, r.options, gatewayModels().map((m) => m.id), gatewayModels()[0]?.id || "");
        }
        break;
      }

      case "session_truncated": {
        // Authoritative tail cut after edit/regenerate (daemon broadcast).
        const keep = typeof msg.keepIndex === "number" ? msg.keepIndex : -1;
        transcript.handleTruncated(msg.sessionId, keep);
        if (msg.sessionId === activeSessionId() && keep >= 0) turnChanges.dropAbove(keep);
        break;
      }
      case "session_content": {
        if (msg.sessionId !== activeSessionId()) break;
        if ((msg as any).page) {
          transcript.noteHistoryPage(msg.messages || [], (msg as any).history);
          if ((msg as any).fileBalloons) turnChanges.noteHistoryBalloons((msg as any).fileBalloons);
          break;
        }
        transcript.applySessionContent(msg.sessionId, msg.messages || [], msg.compaction);
        break;
      }

      case "daemon_update": {
        const prev = daemonUpdate.info()?.available ?? "";
        daemonUpdate.noteUpdate(msg);
        const now = daemonUpdate.info()?.available ?? "";
        if (now && now !== prev) {
          notice.toast(`Daemon update available: ${now}`, "ok");
        }
        break;
      }

      case "update_failed": {
        daemonUpdate.noteFailed(String((msg as any).reason ?? "unknown error"));
        break;
      }
      case "update_done": {
        daemonUpdate.noteDone(String((msg as any).version ?? ""));
        break;
      }

      case "bg_update":
      case "bg_list": {
        background.noteJobs(msg.jobs);
        break;
      }

      case "bg_output": {
        if (typeof msg.jobId === "string") background.noteOutput(msg.jobId, typeof msg.text === "string" ? msg.text : "");
        break;
      }

      case "bg_tail": {
        if (typeof msg.jobId === "string") background.noteTail(msg.jobId, typeof msg.text === "string" ? msg.text : "");
        break;
      }

      case "session_queue": {
        queue.noteQueue(msg.sessionId, msg.queue);
        break;
      }

      case "session_status": {
        if (pendingDiscardReloadSid && pendingDiscardReloadSid === msg.sessionId && msg.status === "running") {
          const sid = pendingDiscardReloadSid;
          pendingDiscardReloadSid = null;
          reloadSessionFromDaemon(sid);
        }
        transcript.handleStatusEvent(msg);
        break;
      }

      case "session_compacted": {
        const sid = msg.sessionId;
        if (sid !== activeSessionId()) break;
        transcript.setSessionContexts((prev) => ({ ...prev, [sid]: msg.context ?? null }));
        if (msg.usage) {
          transcript.applyUsage(sid, msg.usage, null);
        }
        transcript.applySessionContent(sid, msg.messages || [], msg.compaction);
        notice.toast(
          msg.auto
            ? "Context auto-compacted — older turns summarized, recent context preserved"
            : "Transcript compacted successfully",
          "ok",
        );
        break;
      }

      case "workspace_status": {
        workspace.noteWorkspaceStatus(msg);
        break;
      }
      case "question_request": {
        if (msg.sessionId === activeSessionId()) transcript.showQuestion(msg.question);
        break;
      }
      case "question_resolved": {
        transcript.noteQuestionResolved(msg.sessionId, msg.questionId);
        break;
      }
      case "question_error": {
        transcript.noteQuestionError(msg.sessionId, msg.questionId, msg.message);
        break;
      }
      case "tool_approval_request": {
        transcript.noteApprovalRequest(msg);
        break;
      }
      case "convert_request": {
        convert.handleConvertRequest(msg);
        break;
      }
      case "convert_resolved": {
        break;
      }

      case "agent_event": {
        if (msg.sessionId !== activeSessionId()) break;
        const evType: string | undefined = msg.event?.type;
        if (typeof document !== "undefined" && document.hidden && !(evType && HIDDEN_LIVE_TYPES.has(evType)) && msg.sessionId) {
          hiddenEventQueue.push({ sessionId: msg.sessionId as string, event: msg.event });
          // Bound the queue: a very long background turn could enqueue
          // thousands of deltas; coalescing at flush keeps it small, but
          // cap anyway (drop oldest text of the same carrier is complex —
          // drop oldest non-structural events instead).
          if (hiddenEventQueue.length > 2000) hiddenEventQueue.splice(0, hiddenEventQueue.length - 2000);
          break;
        }
        if (pendingDiscardReloadSid && pendingDiscardReloadSid === msg.sessionId && msg.event?.type === "turn_start") {
          const sid = pendingDiscardReloadSid;
          pendingDiscardReloadSid = null;
          reloadSessionFromDaemon(sid);
        }
        transcript.handleAgentEvent(msg.sessionId, msg.event);
        break;
      }

      case "error": {
        if (msg.requestId === creationRequestId) { setCreatingSession(false); }
        if (projects.isFolderRequest(msg.requestId)) { projects.setFolderLoading(false); projects.setFolderError(msg.message || "Could not browse folders"); break; }
        if (projects.isProjectCreation(msg.requestId) && projects.showNewProjectModal()) { projects.setFolderError(msg.message || "Could not create project"); break; }
        if (msg.sessionId && msg.sessionId !== activeSessionId()) break;
        if (transcript.editAttachments.failUpload(msg.requestId, msg.message || "Upload failed")) break;
        if (queue.editDraft.failUpload(msg.requestId, msg.message || "Upload failed")) break;
        if (review.failPreview(msg.requestId, msg.message || "Preview failed")) break;
        if (composer.failUpload(msg.requestId, msg.message || "Upload failed")) break;
        if (msg.replyTo === "create_session") setCreatingSession(false);
        if (msg.message === "Remote host is offline") {
          hosts.markActiveHostOffline();
          if (msg.replyTo === "browse_folders") { projects.setFolderLoading(false); projects.setFolderError("The host went offline. Reconnect to browse its folders."); }
          break;
        }
        // Sync pulls on an offline host are expected background noise.
        if (msg.replyTo === "pull") break;

        notice.toast(msg.message || "Daemon returned an error", "err");
        if (activeSessionId()) transcript.fetchSession(activeSessionId());
        break;
      }
    }
  }

  /** Session choices, also remembered by the daemon for the next draft. */
  function modelPickerBody() {
    return (
      <ModelPickerBody
        models={gatewayModels}
        filtered={filteredGatewayModels}
        filter={modelFilter}
        setFilter={setModelFilter}
        activeModelId={options.activeModel}
        onPick={(id) => {
          options.setActiveModel(id);
          setModelMenuOpen(false);
          options.configureSession();
        }}
        effort={options.effort}
        onEffort={(lvl) => {
          options.setEffort(lvl);
          options.configureSession();
          setModelMenuOpen(false);
        }}
        onRefresh={async () => {
          await loadGatewayModels();
          notice.toast("Models refreshed", "ok");
        }}
      />
    );
  }

  // Mount logic
  onMount(() => {
    // Post-update reload toast (set by noteDone before location.reload;
    // consumed once here so no stale notice survives to the next update).
    daemonUpdate.consumePostReloadToast();
    void Promise.allSettled([loadGatewayModels(), hosts.loadHosts()]).then(() => {
      if (!relay.isDisposed() && hosts.hosts().length === 0) modals.generatePairingToken({ silent: true });
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
    // Hidden-tab coalescing flush: apply the queued stream as one batch
    // when the reader returns (single render instead of N catch-ups).
    const onVisibility = () => {
      if (!document.hidden) flushHiddenQueue();
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      hiddenEventQueue = [];
    });
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
        if (modals.confirmState()) {
          modals.confirmState()?.resolve(false);
          modals.setConfirmState(null);
          return;
        }
        if (transcript.editingMsgIdx() != null) {
          transcript.cancelEditMsg();
          return;
        }
        if (review.previewFile()) {
          review.setPreviewFile(null);
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
    const hid = hosts.activeHostId();
    clearTimeout(restoreTimeout);
    restoredHostId = "";
    knownSessionIds = new Set();
    {
      // Switching hosts swaps the whole world: nothing from the previous
      // daemon may bleed through (frontend = dumb monitor).
      untrack(() => {
        options.resetPending();
        transcript.clearForkRequest(); transcript.setForking(false);
        setDraftMode(true);
        setCreatingSession(false);
        creationRequestId = "";
        turnChanges.reset();
        transcript.resetForSession();
        transcript.resetCaches();
        notice.setAppNotice(null);
        setActiveSessionId("");
        projects.setActiveProjectId("");
        composer.clearAttachments();
        composer.setInputPrompt("");
        relay.resetBackoff();
        mirror.dataLayer.disconnect();
        relay.connect(hid);
      });
    }
  });

  createEffect(() => {
    const id = projects.pendingProjectId();
    if (id && mirror.projects().some((p) => p.id === id)) untrack(() => {
      projects.setPendingProjectId("");
      if (draftMode()) projects.setActiveProjectId(id);
      else startNewConversation(id);
    });
  });

  createEffect(() => {
    const list = mirror.projects();
    if (list.length === 0) {
      if (projects.activeProjectId()) projects.setActiveProjectId("");
      return;
    }
    if (!list.some((p) => p.id === projects.activeProjectId())) {
      const fallback = projects.newestSessionProjectId();
      projects.setActiveProjectId(list.some((p) => p.id === fallback) ? fallback : list[0].id);
    }
  });

  // A conversation that vanished from the mirror (deleted here or on
  // another device) must leave no trace: close the transcript, purge its
  // usage/files/draft leftovers and drop it from bulk selection.
  let knownSessionIds = new Set<string>();
  createEffect(() => {
    const cur = new Set(mirror.sessions().map((s) => s.id));
    for (const id of knownSessionIds) {
      if (cur.has(id)) continue;
      purgeSessionTrace(id);
      if (activeSessionId() === id) {
        startNewConversation();
      }
      projects.dropVanishedSession(id);
    }
    knownSessionIds = cur;
  });

  // Restore saved session from localStorage (or fallback to new conversation if not found)
  createEffect(() => {
    const hid = hosts.activeHostId();
    if (!hid) return;
    if (restoredHostId === hid) return;

    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`llmgw-rc-session:${hid}`);
    } catch {}

    if (!saved || saved === "new") {
      restoredHostId = hid;
      clearTimeout(restoreTimeout);
      startNewConversation();
      return;
    }

    const all = mirror.sessions();
    if (all.some((s) => s.id === saved)) {
      restoredHostId = hid;
      clearTimeout(restoreTimeout);
      selectSession(saved);
      return;
    }

    const st = mirror.store();
    if (st) {
      void st.sessions.isReady().then(() => {
        if (restoredHostId === hid) return;
        const fresh = mirror.sessions();
        if (fresh.some((s) => s.id === saved)) {
          restoredHostId = hid;
          clearTimeout(restoreTimeout);
          selectSession(saved);
        } else if (!isHostOnline() || !relay.wsOpen()) {
          restoredHostId = hid;
          clearTimeout(restoreTimeout);
          startNewConversation();
          try { localStorage.setItem(`llmgw-rc-session:${hid}`, "new"); } catch {}
        }
      });
    }

    clearTimeout(restoreTimeout);
    restoreTimeout = setTimeout(() => {
      if (restoredHostId === hid) return;
      const fresh = mirror.sessions();
      if (fresh.some((s) => s.id === saved)) {
        selectSession(saved);
      } else {
        startNewConversation();
        try { localStorage.setItem(`llmgw-rc-session:${hid}`, "new"); } catch {}
      }
      restoredHostId = hid;
    }, 2000);
  });

  // Sync active session state (todosOpen, options) from mirror to UI
  createEffect(() => {
    const s = activeSession();
    if (!s) return;
    if (typeof s.todosOpen === "boolean") {
      transcript.applyTodosOpenFromRemote(s.todosOpen);
    }
    if (s.model || s.options) {
      options.reconcileServerSelection(s.id, s.model, s.options, gatewayModels().map((m) => m.id), gatewayModels()[0]?.id || "");
    }
  });

  createEffect(() => {
    const catalog = gatewayModels();
    const saved = mirror.configDoc()?.lastSelection;
    if (options.getLastLocalSelection() && options.matchesChoice(saved, options.getLastLocalSelection())) options.clearLastLocalSelection();
    if (activeSessionId()) return;
    const selection = options.getLastLocalSelection() || saved;
    options.setActiveModel(catalog.find((m) => m.id === selection?.model)?.id || catalog[0]?.id || "");
    options.applyOptions(selection);
  });

  // Auto-poll hosts while waiting for initial daemon pairing
  createEffect(() => {
    if (hosts.hosts().length === 0 || modals.showPairModal()) {
      const interval = setInterval(() => {
        hosts.loadHosts();
      }, 3000);
      onCleanup(() => clearInterval(interval));
    }
  });

  // Close popover menus on outside click / Escape.
  function closeMenus() {
    options.setModeMenuOpen(false);
    options.setAccessMenuOpen(false);
    hosts.setHostMenuOpen(false);
    projects.setNewProjectMenuOpen(false);
    composer.setAddContextOpen(false);
    setModelMenuOpen(false);
    projects.setProjectMenuOpen(false);
    setUsageOpen(false);
  }

  // --- Contexts (the page assembles from hooks; components
  // consume per slice — without prop-drilling) ---
  const hostValue: HostCtxValue = {
    ...hosts,
    connectionState: relay.connectionState,
    wsOpen,
  };
  const sessionValue: SessionCtxValue = {
    ...projects,
    sessions: mirror.sessions,
    projects: mirror.projects,
    activeSession,
    currentProject,
    activeSessionId,
    draftMode,
    creatingSession,
    selectSession,
    startNewConversation,
    deleteSession,
    pendingProjectId: projects.pendingProjectId,
    setPendingProjectId: projects.setPendingProjectId,
    newestSessionProjectId: projects.newestSessionProjectId,
    workspace: workspace.workspace,
    workspaceBlocked: workspace.workspaceBlocked,
    workspacePath: workspace.workspacePath,
    workspaceState: workspace.workspaceState,
    checkWorkspace: workspace.checkWorkspace,
    newProjBtn,
    projBtn,
  };
  const transcriptValue: TranscriptCtxValue = {
    ...transcript,
    saveEditMsg: (idx, m) => transcript.saveEditMsg(idx, m, options.activeModel, options.yoloMode),
    regenerateMsg: (idx) => transcript.regenerateMsg(idx, options.activeModel, options.yoloMode),
  };
  const composerValue: ComposerCtxValue = {
    ...composer,
    activeModel: options.activeModel,
    activeModelName,
    effort: options.effort,
    agentMode: options.agentMode,
    setAgentMode: options.setAgentMode,
    selectedSkills: options.selectedSkills,
    setSelectedSkills: options.setSelectedSkills,
    yoloMode: options.yoloMode,
    setYoloMode: options.setYoloMode,
    modeMenuOpen: options.modeMenuOpen,
    setModeMenuOpen: options.setModeMenuOpen,
    accessMenuOpen: options.accessMenuOpen,
    setAccessMenuOpen: options.setAccessMenuOpen,
    modeBtn: options.modeBtn,
    accessBtn: options.accessBtn,
    configureSession: options.configureSession,
    modelPickerBody,
    activeContext,
    addBtn,
    modelBtn,
  };
  const modalValue: ModalCtxValue = {
    ...modals,
    ...review,
    ...settings,
  };
  const uiValue: UICtxValue = {
    ...notice,
    daemonUpdate,
    turnNotify,
    pushSub,
    sidebarOpen,
    setSidebarOpen,
    isMobile,
    historyView,
    setHistoryView,
    closeSidebarOnMobile,
    closeMenus,
    verboseChat,
    setVerboseChat,
    hideToolMessages,
    setHideToolMessages,
    convWidth,
    setConvWidth,
    convWidthClass,
    modelMenuOpen,
    setModelMenuOpen,
    usageOpen,
    setUsageOpen,
    contextBtn,
  };

  return (
    <RemoteCodeProvider
      host={hostValue}
      session={sessionValue}
      transcript={transcriptValue}
      turnChanges={turnChanges}
      composer={composerValue}
      queue={queue}
      background={background}
      modal={modalValue}
      ui={uiValue}
    >
    <div class="fixed inset-0 w-full h-dvh flex flex-col bg-ink-950 text-ink-100 overflow-hidden font-sans select-none z-50">
      <RemoteHints />
      {/* Main Workspace Layout or Connect Host Onboarding */}
      <Show
        when={hosts.hosts().length > 0}
        fallback={<Onboarding />}
      >
        <div class="flex-1 flex min-h-0 overflow-hidden relative">
          <WorkspaceSidebar />
          <main class="flex-1 flex flex-col min-w-0 bg-ink-950 relative">
            <TranscriptView />
            <Composer />
          </main>
        </div>
      </Show>

      <NewProjectModal />
      <PreviewModal />
      <ChoiceModal />
      <ConfirmModal />
      <PairModal />
      <SettingsModal />
      <UpdateFreezeOverlay />
    </div>
    </RemoteCodeProvider>
  );
}
