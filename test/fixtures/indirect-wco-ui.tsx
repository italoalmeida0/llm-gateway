import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WorkspaceLayout } from "../../web/src/indirect-code/IndirectCodePage";
import { WorkspaceSidebar } from "../../web/src/indirect-code/components/WorkspaceSidebar";
import { HostCtx, SessionCtx, TranscriptCtx, ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

// Real workspace shell and sidebar with a scrollable conversation placeholder.
const api: any = { commands: [] as any[] };
(window as any).wcoUI = api;

render(() => {
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [mobile, setMobile] = createSignal(false);
  Object.assign(api, { setSidebarOpen, setMobile });
  const [hostId, setHostId] = createSignal("h1");
  api.setHostId = setHostId;
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => hostId(),
  });
  api.noteUpdate = du.noteUpdate;
  api.apply = du.apply;
  api.applying = du.applying;
  api.info = du.info;
  const host: any = {
    hosts: () => [],
    activeHost: () => null,
    activeHostId: () => hostId(),
    setActiveHostId: () => {},
    loadHosts: () => Promise.resolve(),
    connectionState: () => "connected",
    hostMenuOpen: () => false,
    setHostMenuOpen: () => {},
    hostMenuAnchor: () => null,
    setHostMenuAnchor: () => {},
  };
  const session: any = {
    activeSessionId: () => "session",
    activeSession: () => ({ title: "Review workspace layout" }),
    currentProject: () => ({ name: "llm-gateway" }),
    draftMode: () => false,
    startNewConversation: () => {},
    projects: () => [],
    looseSessions: () => [],
    visibleSessions: () => [],
    newestSessionProjectId: () => null,
    selectionMode: () => false,
    selectedSessions: () => new Set(),
    newProjectMenuOpen: () => false,
    setNewProjectMenuOpen: () => {},
    openNewProjectModal: () => {},
    quickStartProject: () => {},
  };
  const transcript: any = {};
  const modal: any = { generatePairingToken: () => Promise.resolve() };
  const ui: any = {
    daemonUpdate: du,
    isMobile: mobile,
    sidebarOpen,
    setSidebarOpen,
    closeSidebarOnMobile: () => {},
    setHistoryView: () => {},
    historyView: () => false,
    closeMenus: () => {},
  };
  return (
    <HostCtx.Provider value={host}>
      <ModalCtx.Provider value={modal}>
        <SessionCtx.Provider value={session}>
          <TranscriptCtx.Provider value={transcript}>
            <UICtx.Provider value={ui}>
              <div class="fixed inset-0 flex flex-col bg-ink-950 text-ink-100 overflow-hidden">
                <WorkspaceLayout sidebar={<WorkspaceSidebar />}>
                  <div id="conversation" class="flex-1 min-h-0 overflow-y-auto px-4 md:px-8">
                    <div id="messages" class="max-w-3xl mx-auto pt-6 pb-10">
                      {Array.from({ length: 80 }, (_, i) => <p class="py-4">Conversation message {i + 1}</p>)}
                    </div>
                  </div>
                  <div class="shrink-0 px-4 md:px-8 py-2">
                    <div id="composer" class="max-w-3xl mx-auto rounded-lg border border-line p-4">
                      <textarea aria-label="Message" class="w-full" placeholder="Ask anything" />
                    </div>
                  </div>
                </WorkspaceLayout>
              </div>
            </UICtx.Provider>
          </TranscriptCtx.Provider>
        </SessionCtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
