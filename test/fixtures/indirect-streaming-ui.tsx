import { createSignal, For, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { StreamingMarkdown } from "../../web/src/indirect-code/components/StreamingMarkdown";
import { DisclosureBody } from "../../web/src/indirect-code/components/Disclosure";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { AssistantTurnContent, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";
import { createRelayInbox } from "../../web/src/indirect-code/relayInbox";
import { batch } from "solid-js";
import { setMotionEnabled, USAL } from "../../web/src/motion";

const api: any = {};
(window as any).streamUI = api;
render(() => {
  const [text, setText] = createSignal("");
  const [streaming, setStreaming] = createSignal(true);
  const [open, setOpen] = createSignal(true);
  const [sid, setSid] = createSignal("test");
  const t = createTranscript({ send: () => {}, isOpen: () => true, getSessionId: sid, getHostId: () => "host",
    toast: () => {}, showChoice: async () => null, onTurnIdle: () => {}, onUsageContext: () => {} });
  const ctx: TranscriptRenderCtx = {
    renderBlocks: t.renderBlocks, messages: t.messages, sessionStatus: t.sessionStatus,
    thinkingStart: t.thinkingStart, thinkingElapsed: t.thinkingElapsed, thinkingIndex: t.thinkingIndex,
    toolProgress: t.toolProgress, toolStarts: t.toolStarts, turnClock: t.turnClock,
    elapsedLabel: () => "1s", specialProgress: t.specialProgress,
    backgroundJobs: () => [], bgOutput: () => ({}), bgClock: () => 0,
    verboseChat: () => true, hideToolMessages: () => false,
    setPreviewFile: () => {}, activeSession: () => null, pendingApproval: t.pendingApproval, projects: () => [],
  };
  const inbox = createRelayInbox({
    apply: (messages) => batch(() => messages.forEach((m: any) => t.handleAgentEvent(m.sessionId, m.event))),
    schedule: (flush) => setTimeout(flush, 32), cancel: (timer) => clearTimeout(timer),
  });
  onCleanup(inbox.clear);
  Object.assign(api, { setText, setStreaming, setOpen, setSid, t, inbox, setMotionEnabled, motionReady: USAL.initialized });
  setMotionEnabled(false);
  return <>
    <div id="markdown" class="rc-markdown"><DisclosureBody open={open()}>
      <StreamingMarkdown streaming={streaming()}>{text()}</StreamingMarkdown>
    </DisclosureBody></div>
    <div id="transcript"><For each={t.renderBlocks()}>{(b) => <AssistantTurnContent ctx={ctx} block={b} finished={t.sessionStatus() !== "running"} />}</For></div>
  </>;
}, document.getElementById("root")!);
