import { createEffect, createSignal, For } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { renderTurnAggregate, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";
import { TurnChangesBalloon } from "../../web/src/indirect-code/components/TurnChangesBalloon";
import { createTurnChanges } from "../../web/src/indirect-code/hooks/useTurnChanges";
import { buildRenderBlocks } from "../../web/src/indirect-code/transcript";
import type { ChatMessage, RenderBlockSeries } from "../../web/src/indirect-code/types";

// Browser regression fixture: real Solid components, deterministic daemon events.
const api: any = {};
(window as any).turnUI = api;
render(() => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [running, setRunning] = createSignal(true);
  const [thinking, setThinking] = createSignal<number | null>(100);
  const [starts, setStarts] = createSignal<Record<string, number>>({});
  const [verbose, setVerbose] = createSignal(true);
  const [state, setState] = createStore<{ blocks: (RenderBlockSeries & {id:string})[] }>({blocks:[]});
  createEffect(() => setState("blocks", reconcile(buildRenderBlocks(messages()).map((b) => ({...b,id:b.msg.id})) as any, {merge:true})));
  const ctx: TranscriptRenderCtx = {
    renderBlocks: () => state.blocks, messages, sessionStatus: () => running() ? "running" : "idle",
    thinkingStart: thinking, thinkingElapsed: () => 3, thinkingIndex: () => 0,
    toolProgress: () => ({}), toolStarts: starts,
    turnClock: () => 1100, elapsedLabel: () => "1s", specialProgress: () => undefined,
    verboseChat: verbose, hideToolMessages: () => false,
    setPreviewFile: () => {}, activeSession: () => null, pendingApproval: () => null, projects: () => [],
  };
  const changes = createTurnChanges({send: () => {}, getSessionId: () => "test", toast: () => {}});
  Object.assign(api, {setMessages, setRunning, setThinking, setStarts, setVerbose, changes});
  return <>
    <div id="aggregate"><For each={state.blocks}>{(b) => renderTurnAggregate(ctx,b,true)}</For></div>
    <div id="changes"><For each={changes.balloons()}>{(b) => <TurnChangesBalloon balloon={b}
      expanded={changes.isExpanded(String(b.turnIndex))} onToggle={() => changes.toggleExpanded(String(b.turnIndex))}
      undoBusy={false} onUndo={() => {}} live={b.live} />}</For></div>
  </>;
}, document.getElementById("root")!);
