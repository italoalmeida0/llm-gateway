import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createBackground } from "../../web/src/indirect-code/hooks/useBackground";
import { BackgroundCard } from "../../web/src/indirect-code/components/BackgroundCard";
import { BackgroundCtx } from "../../web/src/indirect-code/ctx";
import { UICtx } from "../../web/src/indirect-code/ctx";
import { toolSummary } from "../../web/src/indirect-code/transcript";

const sent: unknown[] = [];
(window as any).__sent = sent;
const bg = createBackground({
  send: (p) => sent.push(p),
  isOpen: () => true,
  getSessionId: () => "s1",
  toast: () => {},
});
const uiStub = { convWidthClass: () => "max-w-3xl" } as any;

render(() => (
  <BackgroundCtx.Provider value={bg}>
    <UICtx.Provider value={uiStub}>
      <BackgroundCard />
    </UICtx.Provider>
  </BackgroundCtx.Provider>
), document.getElementById("root")!);

Object.assign(window, {
  bgTest: {
    bg,
    // Session-owned tasks, as mirrored from session_data bgTasks.
    seed(tasks: any[]) {
      bg.noteSessionTasks(tasks);
    },
    event(msg: any) {
      bg.noteSessionTaskEvent(msg);
    },
    output(jobId: string, text: string) {
      bg.noteOutput(jobId, text);
    },
    // toolSummary probes (pure, no DOM).
    summary(toolName: string, args: any, result?: string) {
      return toolSummary({
        call: { type: "tool_call", toolId: "t", toolName, toolArgs: JSON.stringify(args) },
        result: result !== undefined ? { type: "tool_result", toolId: "t", toolResult: result } : undefined,
      } as any);
    },
  },
});
