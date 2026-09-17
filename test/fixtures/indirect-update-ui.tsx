import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDaemonUpdate } from "../../web/src/indirect-code/hooks/useDaemonUpdate";

const api: any = { commands: [] as any[] };
(window as any).updateUI = api;
render(() => {
  const [notices, setNotices] = createSignal([] as any[]);
  api.notices = notices;
  const du = createDaemonUpdate({
    send: (c) => api.commands.push(c),
    toast: (message, kind) => setNotices((p) => [...p, { message, kind }]),
  });
  api.info = du.info;
  api.applying = du.applying;
  api.noteUpdate = du.noteUpdate;
  api.checkNow = du.checkNow;
  api.toggle = du.toggle;
  api.apply = du.apply;
  api.cancel = du.cancel;
  api.noteFailed = du.noteFailed;
  api.noteDone = du.noteDone;
  return (
    <div>
      <div id="state">{JSON.stringify(du.info() ?? null)}</div>
      <div id="applying">{String(du.applying())}</div>
      <button id="btn-check" onClick={() => du.checkNow()}>check</button>
      <button id="btn-toggle" onClick={() => du.toggle(!(du.info()?.autoUpdate ?? true))}>toggle</button>
      <button id="btn-apply" onClick={() => du.apply()}>apply</button>
      <button id="btn-cancel" onClick={() => du.cancel()}>cancel</button>
      <div id="notices">{JSON.stringify(notices())}</div>
    </div>
  );
}, document.getElementById("root")!);
