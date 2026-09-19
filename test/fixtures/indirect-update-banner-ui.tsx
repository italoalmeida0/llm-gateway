import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { StatusBanners } from "../../web/src/indirect-code/components/composer/StatusBanners";
import { HostCtx, SessionCtx, TranscriptCtx, UICtx } from "../../web/src/indirect-code/ctx";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).bannerUI = api;

render(() => {
  // Reactive host id (mirrors hosts.activeHostId() in the real page:
  // switching hosts re-renders the world through this signal).
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
    hosts: () => [], activeHost: () => null, activeHostId: () => hostId(),
    connectionState: () => "connected", wsOpen: () => true,
  };
  const session: any = { draftMode: () => false, activeSessionId: () => "s1" };
  const transcript: any = { turnActivity: () => null, sessionStatus: () => "idle", turnLabel: () => "", turnHint: () => null, todos: () => [], todosOpen: () => false, toggleTodosOpen: () => {} };
  const ui: any = { daemonUpdate: du, appNotice: () => null, setAppNotice: () => {} };
  return (
    <HostCtx.Provider value={host}>
      <SessionCtx.Provider value={session}>
        <TranscriptCtx.Provider value={transcript}>
          <UICtx.Provider value={ui}>
            <StatusBanners />
          </UICtx.Provider>
        </TranscriptCtx.Provider>
      </SessionCtx.Provider>
    </HostCtx.Provider>
  );
}, document.getElementById("root")!);
