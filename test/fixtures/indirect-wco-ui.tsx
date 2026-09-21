import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WcoTitlebar } from "../../web/src/indirect-code/IndirectCodePage";
import { ModalCtx, SessionCtx, UICtx } from "../../web/src/indirect-code/ctx";

const api: any = { commands: [] as any[] };
(window as any).wcoUI = api;

// REAL WcoTitlebar (same component as the page) with stubbed contexts:
// asserts the OS-style bar renders the icon + active session title and the
// sidebar/settings controls toggle through the real callbacks.
render(() => {
  const [sbOpen, setSbOpen] = createSignal(true);
  api.sbOpen = sbOpen;
  const sessions: any = {
    activeSession: () => ({ id: "s1", title: "Fix login bug" }),
    draftMode: () => false,
  };
  const modal: any = {
    openSettings: () => { api.commands.push({ type: "open-settings" }); },
  };
  const ui: any = {};
  return (
    <SessionCtx.Provider value={sessions}>
      <ModalCtx.Provider value={modal}>
        <UICtx.Provider value={ui}>
          <WcoTitlebar
            sbOpen={sbOpen}
            toggleSb={() => setSbOpen(!sbOpen())}
          />
        </UICtx.Provider>
      </ModalCtx.Provider>
    </SessionCtx.Provider>
  );
}, document.getElementById("root")!);
