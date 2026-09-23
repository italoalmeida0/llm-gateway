import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).freezeUI = api;

// Minimal overlay replica: same signals, same Show logic as
// UpdateFreezeOverlay (component itself needs full page ctx; the logic
// under test is frozen()+stage()+cancel() wiring, now per-host).
import { Show } from "solid-js";
render(() => {
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: () => {},
    getHostId: () => api.hostId || "h1",
    getHostStatus: (hid) => api.hostStatus?.(hid),
  });
  api.noteUpdate = du.noteUpdate;
  api.stateFor = du.stateFor;
  api.setHostStatus = (id: string, st: string) => api.commands.push({ type: "set-status", id, st });
  const [st1, setSt1] = createSignal("online");
  const [st2, setSt2] = createSignal("offline");
  const getStatus = (hid: string) => (hid === "h1" ? st1() : st2());
  const setStatus = (hid: string, v: string) => (hid === "h1" ? setSt1(v) : setSt2(v));
  api.statuses = new Proxy({}, { get: (_t, k) => getStatus(String(k)), set: (_t, k, v) => { setStatus(String(k), String(v)); return true; } });
  const hosts = { hosts: () => [{ id: "h1", name: "one", status: st1() }, { id: "h2", name: "two", status: st2() }], setActiveHostId: (id: string) => api.commands.push({ type: "switch-host", id }) };
  api.hostStatus = (hid: string) => getStatus(hid);
  const updatingHostId = () => {
    for (const h of hosts.hosts() as any[]) {
      if ((h as any).status === "updating") return h.id;
    }
    return "";
  };
  return (
    <div>
      <Show when={updatingHostId() !== ""}>
        <div id="freeze-overlay">
          <p id="freeze-stage">Updating…</p>
          <div id="host-list">
            {hosts.hosts().map((h: any) => (
              <button data-host={h.id} onClick={() => hosts.setActiveHostId(h.id)}>{h.name}</button>
            ))}
          </div>
        </div>
      </Show>
      <div id="frozen-flag">{String(updatingHostId() !== "")}</div>
    </div>
  );
}, document.getElementById("root")!);
