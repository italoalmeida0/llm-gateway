import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createBackground } from "../../web/src/indirect-code/hooks/useBackground";
import { BackgroundCard } from "../../web/src/indirect-code/components/BackgroundCard";
import { ToolSearchBodies } from "../../web/src/indirect-code/components/tool/ToolSearchBodies";
import { ToolUnitHeader } from "../../web/src/indirect-code/components/tool/ToolUnitHeader";
import { useToolUnitModel } from "../../web/src/indirect-code/components/tool/toolUnitModel";
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

// Minimal TranscriptRenderCtx for tool rows (static signals are fine:
// bodies render from the unit, not the clock).
const [toolProgress] = createSignal<Record<string, string>>({});
const _toolStartsSeed: Record<string, number> = { "c-detach": Date.now() - 3000 };
const [toolStarts] = createSignal(_toolStartsSeed);
const [turnClock, setTurnClock] = createSignal(Date.now());
setInterval(() => setTurnClock(Date.now()), 500);
const renderCtx: any = {
  renderBlocks: () => [],
  sessionStatus: () => "idle",
  messages: () => [],
  thinkingStart: () => null,
  thinkingElapsed: () => 0,
  toolProgress,
  elapsedLabel: (ms: number) => `${Math.round(ms / 1000)}s`,
  specialProgress: () => undefined,
  thinkingIndex: () => 0,
  verboseChat: () => true,
  hideToolMessages: () => false,
  setPreviewFile: () => {},
  turnClock,
  toolStarts,
  activeSession: () => null,
  pendingApproval: () => null,
  projects: () => [],
  backgroundJobs: () => bg.sessionJobs(),
  bgOutput: () => bg.output(),
  bgClock: () => bg.clock(),
};

function ToolRow(props: { unit: any }) {
  const m = useToolUnitModel(renderCtx, "msg1", props.unit, 0, () => false, () => false);
  return (
    <>
      <ToolUnitHeader ctx={renderCtx} msgId="msg1" u={props.unit} m={m} running={false} active={false} />
      <ToolSearchBodies ctx={renderCtx} msgId="msg1" u={props.unit} m={m} running={false} active={false} />
    </>
  );
}

function ToolRows() {
  return (
    <>
      <div data-testid="row-sleep">
        <ToolRow
          unit={{
            call: { type: "tool_call", toolId: "c-sleep", toolName: "sleep", toolArgs: JSON.stringify({ seconds: 90, waitingFor: "bg_1", summary: "waiting for build" }) },
            result: { type: "tool_result", toolId: "c-sleep", toolResult: "waiting for build\nSlept 1m30s." },
          }}
        />
      </div>
      <div data-testid="row-bgcheck">
        <ToolRow
          unit={{
            call: { type: "tool_call", toolId: "c-check", toolName: "bg_check", toolArgs: JSON.stringify({ job_id: "bg_1" }) },
            result: { type: "tool_result", toolId: "c-check", toolResult: "Background Task (bash) — running\nCommand: sleep 30\nLines 1–2 of 100\n1:hello\n2:world\nStatus: still running." },
          }}
        />
      </div>
      <div data-testid="row-detach">
        <ToolRow
          unit={{
            call: { type: "tool_call", toolId: "c-detach", toolName: "bash", toolArgs: JSON.stringify({ command: "sleep 30" }) },
            result: { type: "tool_result", toolId: "c-detach", toolResult: "Command moved to background (still running).", toolDetails: { background_job_id: "bg_window" } },
          }}
        />
      </div>
      <div data-testid="row-bgcancel">
        <ToolRow
          unit={{
            call: { type: "tool_call", toolId: "c-cancel", toolName: "bg_cancel", toolArgs: JSON.stringify({ job_id: "bg_9" }) },
            result: { type: "tool_result", toolId: "c-cancel", toolResult: "cancelled" },
          }}
        />
      </div>
    </>
  );
}

render(() => (
  <BackgroundCtx.Provider value={bg}>
    <UICtx.Provider value={uiStub}>
      <BackgroundCard />
      <ToolRows />
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
    output(jobId: string, text: string, from?: number) {
      bg.noteOutput(jobId, text, undefined, from);
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
