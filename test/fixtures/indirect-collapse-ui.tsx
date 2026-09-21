import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Composer } from "../../web/src/indirect-code/components/Composer";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";

// Browser regression fixture: the composer minimize toggle, driven by flips
// of draft/session/workspace state rather than by the real daemon.
const api: any = {};
(window as any).collapseUI = api;
render(() => {
  const [active, setActive] = createSignal("s1");
  const [draft, setDraft] = createSignal(false);
  const [collapsed, setCollapsed] = createSignal(false);
  const [blocked, setBlocked] = createSignal(false);
  const [turn, setTurn] = createSignal<any>({ startedAt: Date.now() - 5000, status: "running" });
  const [todos, setTodos] = createSignal<any[]>([
    { text: "First task", status: "completed" },
    { text: "Second task", status: "in_progress" },
  ]);
  const session: any = {
    creatingSession: () => false,
    activeSessionId: active,
    draftMode: draft,
    activeProject: () => ({ id: "project" }),
    activeSession: () => null,
    currentProject: () => ({ id: "project", name: "Project", path: "/work" }),
    workspaceBlocked: blocked,
    workspaceState: () => "ok",
    workspacePath: () => "/work",
    checkWorkspace: () => {},
    projects: () => [],
    projectMenuOpen: () => false,
    setProjectMenuOpen: () => {},
    pickProject: () => {},
    openNewProjectModal: () => {},
  };
  const transcript: any = {
    sessionStatus: () => "running",
    turnActivity: turn,
    turnLabel: () => "Working · 5s",
    turnHint: () => "",
    todos,
    todosOpen: () => true,
    toggleTodosOpen: () => {},
    pendingQuestion: () => null,
    pendingApproval: () => null,
    cancelCurrentTurn: () => {},
    activeUsage: () => null,
    messages: () => [],
    isAtBottom: () => true,
    pinAtBottom: () => {},
  };
  const composer: any = {
    inputPrompt: () => "",
    setInputPrompt: () => {},
    pendingAttachments: () => [],
    preparingAttachments: () => 0,
    sending: () => false,
    sendPrompt: () => {},
    mentions: { open: () => false, index: () => 0, files: () => [], pick: () => {}, setFocused: () => {}, setCaret: () => {}, keyDown: () => false },
    slashMatches: () => [],
    slashIndex: () => 0,
    setSlashIndex: () => {},
    dismissSlash: () => {},
    pickSlash: () => {},
    activeModel: () => "m",
    activeModelName: () => "Model",
    effort: () => "high",
    activeContext: () => ({ label: "1.2K", window: 100000, percent: 1 }),
    modelPickerBody: () => null,
    handleFiles: () => {},
    removePendingAttachment: () => {},
    addContextOpen: () => false,
    setAddContextOpen: () => {},
    agentMode: () => "build",
    setAgentMode: () => {},
    selectedSkills: () => [],
    setSelectedSkills: () => {},
    yoloMode: () => false,
    setYoloMode: () => {},
    modeMenuOpen: () => false,
    setModeMenuOpen: () => {},
    accessMenuOpen: () => false,
    setAccessMenuOpen: () => {},
    configureSession: () => {},
  };
  const ui: any = {
    appNotice: () => null,
    setAppNotice: () => {},
    historyView: () => false,
    isMobile: () => false,
    composerCollapsed: collapsed,
    setComposerCollapsed: setCollapsed,
    toggleComposerCollapsed: () => setCollapsed((v: boolean) => !v),
    modelMenuOpen: () => false,
    setModelMenuOpen: () => {},
    usageOpen: () => false,
    setUsageOpen: () => {},
    closeMenus: () => {},
  };
  Object.assign(api, { setActive, setDraft, setCollapsed, setBlocked, setTodos, setTurn, active, draft, collapsed });
  return (
    <RemoteCodeProvider
      host={{ activeHost: () => ({ status: "online", name: "Host" }), connectionState: () => "connected", loadHosts: () => {} } as any}
      session={session}
      transcript={transcript}
      turnChanges={{} as any}
      composer={composer}
      queue={{} as any}
      background={{} as any}
      modal={{} as any}
      ui={ui}
    >
      <Composer />
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
