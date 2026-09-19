import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { UpdateFreezeOverlay } from "../../web/src/indirect-code/IndirectCodePage";
import { HostCtx, ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).overlayUI = api;

// REAL UpdateFreezeOverlay (same component as the page) with stubbed
// contexts: real hook + real brand + real host card + real FloatMenu.
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
    // Mirrors the real removeHost: closes the menu synchronously, then
    // asks for confirm (stubbed as a command here). Without the close,
    // the floating menu would stay open over Cancel.
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
        </UICtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
