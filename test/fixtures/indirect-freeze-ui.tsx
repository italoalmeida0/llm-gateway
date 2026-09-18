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
  });
  api.noteUpdate = du.noteUpdate;
  api.cancel = du.cancel;
  api.stateFor = du.stateFor;
  const ui = { daemonUpdate: du } as any;
  const hosts = { hosts: () => [{ id: "h1", name: "one", status: "online" }, { id: "h2", name: "two", status: "offline" }], setActiveHostId: (id: string) => api.commands.push({ type: "switch-host", id }) };
  const frozenHostId = () => {
    for (const h of hosts.hosts() as any[]) {
      if (ui.daemonUpdate.stateFor(h.id)?.frozen) return h.id;
    }
    return "";
  };
  return (
    <div>
      <Show when={frozenHostId() !== ""}>
        <div id="freeze-overlay">
          <p id="freeze-stage">{(frozenHostId() ? ui.daemonUpdate.stateFor(frozenHostId())?.freezeStage : "") || "preparing update"}</p>
          <button id="btn-cancel-update" onClick={() => ui.daemonUpdate.cancel(frozenHostId())}>
            Cancel update
          </button>
          <div id="host-list">
            {hosts.hosts().map((h: any) => (
              <button data-host={h.id} onClick={() => hosts.setActiveHostId(h.id)}>{h.name}</button>
            ))}
          </div>
        </div>
      </Show>
      <div id="frozen-flag">{String(frozenHostId() !== "")}</div>
    </div>
  );
}, document.getElementById("root")!);
