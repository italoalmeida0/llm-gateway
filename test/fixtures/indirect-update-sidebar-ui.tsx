import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WorkspaceSidebar } from "../../web/src/indirect-code/components/WorkspaceSidebar";
import { HostCtx, SessionCtx, TranscriptCtx, ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

// Sidebar update-button fixture: the REAL WorkspaceSidebar in a real
// browser — no update -> no button; available -> white primary button
// (settings Save-changes style) below Conversation History; apply ->
// Updating…/frozen stage on the SAME button; per-host switch swaps it;
// sidebar top has Back to Gateway above New Conversation.
const api: any = { commands: [] as any[] };
(window as any).sidebarUI = api;

render(() => {
  // Reactive host id (mirrors hosts.activeHostId() in the real page).
  const [hostId, setHostId] = createSignal("h1");
  api.setHostId = setHostId;
  const [st1, setSt1] = createSignal("online");
  const [st2, setSt2] = createSignal("offline");
  const getStatus = (hid: string) => (hid === "h1" ? st1() : st2());
  const setStatus = (hid: string, v: string) => (hid === "h1" ? setSt1(v) : setSt2(v));
  api.statuses = new Proxy({}, { get: (_t, k) => getStatus(String(k)), set: (_t, k, v) => { setStatus(String(k), String(v)); return true; } });
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => hostId(),
    getHostStatus: (hid) => getStatus(hid),
  });
  api.noteUpdate = du.noteUpdate;
  api.apply = du.apply;
  api.applying = du.applying;
  api.info = du.info;
  const host: any = {
    hosts: () => [],
    activeHost: () => ({ id: hostId(), status: getStatus(hostId()) ?? "online" }),
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
    activeSessionId: () => null,
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
    isMobile: () => false,
    sidebarOpen: () => true,
    setSidebarOpen: () => {},
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
              <WorkspaceSidebar />
            </UICtx.Provider>
          </TranscriptCtx.Provider>
        </SessionCtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
