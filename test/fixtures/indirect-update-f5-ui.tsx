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
  const [menuAnchor, setMenuAnchor] = createSignal<string | null>(null);
  api.setHostId = setHostId;
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => hostId(),
    getHostStatus: (hid) => api.hostStatus?.(hid),
  });
  api.noteUpdate = du.noteUpdate;
  api.stateFor = du.stateFor;
  api.info = du.info;
  const [st1, setSt1] = createSignal("online");
  const [st2, setSt2] = createSignal("offline");
  const getStatus = (hid: string) => (hid === "h1" ? st1() : st2());
  const setStatus = (hid: string, v: string) => (hid === "h1" ? setSt1(v) : setSt2(v));
  api.statuses = new Proxy({}, { get: (_t, k) => getStatus(String(k)), set: (_t, k, v) => { setStatus(String(k), String(v)); return true; } });
  api.setOnline = (hid: string) => { setStatus(hid, "online"); };
  api.hostStatus = (hid: string) => getStatus(hid);
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
    hostMenuAnchor: () => menuAnchor(),
    setHostMenuAnchor: (v: string | null) => setMenuAnchor(v),
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
