import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { WcoTitlebar } from "../../web/src/indirect-code/IndirectCodePage";
import { ModalCtx, UICtx } from "../../web/src/indirect-code/ctx";

const api: any = { commands: [] as any[] };
(window as any).wcoUI = api;

// REAL WcoTitlebar (same component as the page) with stubbed contexts:
// asserts the slim drag strip renders only the sidebar/settings controls
// and they fire through the real callbacks.
render(() => {
  const [sbOpen, setSbOpen] = createSignal(true);
  api.sbOpen = sbOpen;
  const modal: any = {
    openSettings: () => { api.commands.push({ type: "open-settings" }); },
  };
  const ui: any = {};
  return (
    <ModalCtx.Provider value={modal}>
      <UICtx.Provider value={ui}>
        <WcoTitlebar sbOpen={sbOpen} toggleSb={() => setSbOpen(!sbOpen())} sbVisible={sbOpen} />
      </UICtx.Provider>
    </ModalCtx.Provider>
  );
}, document.getElementById("root")!);
