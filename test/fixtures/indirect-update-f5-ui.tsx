import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { UpdateFreezeOverlay } from "../../web/src/indirect-code/IndirectCodePage";
import { HostCtx, ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).f5UI = api;

// REAL UpdateFreezeOverlay + REAL persisted hook: localStorage survives
// page.reload(), so this fixture tests the F5 matrix end-to-end.
render(() => {
  const [hostId, setHostId] = createSignal("h1");
  const [menuOpen, setMenuOpen] = createSignal(false);
  api.setHostId = setHostId;
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => hostId(),
  });
  api.noteUpdate = du.noteUpdate;
  api.cancel = du.cancel;
  api.stateFor = du.stateFor;
  api.info = du.info;
  const hosts: any = {
    hosts: () => [
      { id: "h1", name: "one", hostname: "one", status: "online" },
      { id: "h2", name: "two", hostname: "two", status: "offline" },
    ],
    activeHostId: () => hostId(),
    activeHost: () => hosts.hosts().find((h: any) => h.id === hostId()) ?? null,
    setActiveHostId: (id: string) => { setHostId(id); api.commands.push({ type: "switch-host", id }); },
    hostMenuOpen: () => menuOpen(),
    setHostMenuOpen: (v: boolean) => setMenuOpen(v),
    hostBtn: undefined,
    connectionState: () => "connected",
    loadHosts: () => { api.commands.push({ type: "load-hosts" }); return Promise.resolve(); },
    removeHost: () => { setMenuOpen(false); api.commands.push({ type: "remove-host" }); return Promise.resolve(); },
  };
  const modal: any = { generatePairingToken: () => { api.commands.push({ type: "pair" }); return Promise.resolve(); } };
  const ui: any = { daemonUpdate: du, closeMenus: () => setMenuOpen(false) };
  return (
    <HostCtx.Provider value={hosts}>
      <ModalCtx.Provider value={modal}>
        <UICtx.Provider value={ui}>
          <UpdateFreezeOverlay />
          <div id="active-host">{hostId()}</div>
          <div id="lifecycle">{du.info()?.lifecycle ?? "none"}</div>
        </UICtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
