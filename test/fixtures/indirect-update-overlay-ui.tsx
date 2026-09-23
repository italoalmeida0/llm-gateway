import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { UpdateFreezeOverlay } from "../../web/src/indirect-code/IndirectCodePage";
import { HostCard } from "../../web/src/indirect-code/components/HostCard";
import { HostCtx, ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).overlayUI = api;

// REAL UpdateFreezeOverlay (same component as the page) with stubbed
// contexts: real hook + real brand + real host card + real FloatMenu.
render(() => {
  const [hostId, setHostId] = createSignal("h1");
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<string | null>(null);
  api.setHostId = setHostId;
  const [st1, setSt1] = createSignal("online");
  const [st2, setSt2] = createSignal("offline");
  const getStatus = (hid: string) => (hid === "h1" ? st1() : st2());
  const setStatus = (hid: string, v: string) => (hid === "h1" ? setSt1(v) : setSt2(v));
  api.statuses = new Proxy({}, { get: (_t, k) => getStatus(String(k)), set: (_t, k, v) => { setStatus(String(k), String(v)); return true; } });
  api.hostStatus = (hid: string) => getStatus(hid);
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => hostId(),
    getHostStatus: (hid) => getStatus(hid),
  });
  api.noteUpdate = du.noteUpdate;
  api.stateFor = du.stateFor;
  const hosts: any = {
    hosts: () => [
      { id: "h1", name: "one", hostname: "one", status: st1() },
      { id: "h2", name: "two", hostname: "two", status: st2() },
    ],
    activeHostId: () => hostId(),
    activeHost: () => hosts.hosts().find((h: any) => h.id === hostId()) ?? null,
    setActiveHostId: (id: string) => { setHostId(id); api.commands.push({ type: "switch-host", id }); },
    hostMenuOpen: () => menuOpen(),
    setHostMenuOpen: (v: boolean) => setMenuOpen(v),
    // Opener-gated anchor (mirrors the real useHosts): each HostCard
    // instance owns its id; the menu shows only for the opener.
    hostMenuAnchor: () => menuAnchor(),
    setHostMenuAnchor: (v: string | null) => setMenuAnchor(v),
    connectionState: () => "connected",
    loadHosts: () => { api.commands.push({ type: "load-hosts" }); return Promise.resolve(); },
    // Mirrors the real removeHost: closes the menu synchronously, then
    // asks for confirm (stubbed as a command here). Without the close,
    // the floating menu would stay open over Cancel.
    removeHost: () => { setMenuOpen(false); api.commands.push({ type: "remove-host" }); return Promise.resolve(); },
  };
  const modal: any = { generatePairingToken: () => { api.commands.push({ type: "pair" }); return Promise.resolve(); } };
  const ui: any = { daemonUpdate: du, closeMenus: () => { setMenuOpen(false); setMenuAnchor(null); } };
  return (
    <HostCtx.Provider value={hosts}>
      <ModalCtx.Provider value={modal}>
        <UICtx.Provider value={ui}>
          <UpdateFreezeOverlay />
          {/* Second HostCard instance, like the real sidebar bottom:
              proves two cards share one menu state without stealing
              each other's anchor (the "menu lá em cima" regression). */}
          <div id="sidebar-card">
            <HostCard id="sidebar" />
          </div>
          <div id="active-host">{hostId()}</div>
        </UICtx.Provider>
      </ModalCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
