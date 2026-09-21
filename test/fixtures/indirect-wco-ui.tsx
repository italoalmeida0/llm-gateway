import { render } from "solid-js/web";
import { WcoTitlebar } from "../../web/src/indirect-code/IndirectCodePage";

const api: any = { commands: [] as any[] };
(window as any).wcoUI = api;

// REAL WcoTitlebar (same component as the page): asserts the drag strip is
// empty — no icon, no title, no buttons — and renders without providers.
render(() => <WcoTitlebar />, document.getElementById("root")!);
