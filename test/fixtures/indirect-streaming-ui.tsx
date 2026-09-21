import { createSignal, For, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { StreamingMarkdown } from "../../web/src/indirect-code/components/StreamingMarkdown";
import { DisclosureBody } from "../../web/src/indirect-code/components/Disclosure";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { AssistantTurnContent, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";
import { createRelayInbox } from "../../web/src/indirect-code/relayInbox";
import { batch } from "solid-js";
import { setMotionEnabled, USAL } from "../../web/src/motion";

import { AssistantMsgActions, UserMsgActions } from "../../web/src/indirect-code/components/MsgActions";
import { RemoteHints } from "../../web/src/indirect-code/presentation";

const responsive = new URLSearchParams(location.search).has("responsive");
const api: any = {};
(window as any).streamUI = api;
render(() => {
  const [text, setText] = createSignal("");
  const [streaming, setStreaming] = createSignal(true);
  const [open, setOpen] = createSignal(true);
  const [width, setWidth] = createSignal("max-w-3xl");
  const [copied, setCopied] = createSignal(false);
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
  Object.assign(api, { setWidth, setText, setStreaming, setOpen, setSid, t, inbox, setMotionEnabled, motionReady: USAL.initialized });
  setMotionEnabled(false);
  const onCopy = () => { void navigator.clipboard.writeText(text()).then(() => setCopied(true)); };
  return <main class={responsive ? "px-4 md:px-8 py-6 min-h-dvh" : ""}>
    <Show when={responsive}><RemoteHints /></Show>
    <section class={responsive ? `group/msg flex flex-col w-full ${width()} mx-auto items-end mb-6` : "hidden"}>
      <div class="bg-ink-900 border border-line/70 text-ink-100 px-3.5 py-2.5 rounded-2xl rounded-tr-md max-w-[90%] sm:max-w-[80%] text-sm">Review the streaming layout and copy controls.</div>
      <UserMsgActions canFork forking={false} showCopy copied={copied()} onCopy={onCopy} onFork={() => {}} onEdit={() => {}} />
    </section>
    <section class={responsive ? `group/msg flex flex-col w-full ${width()} mx-auto items-start` : ""}>
      <div id="markdown" class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto"><DisclosureBody open={open()}>
        <StreamingMarkdown streaming={streaming()}>{text()}</StreamingMarkdown>
      </DisclosureBody></div>
      <Show when={responsive && !streaming()}><AssistantMsgActions canFork forking={false} showCopy copied={copied()} onCopy={onCopy} onFork={() => {}} onRegenerate={() => {}} duration="12s" /></Show>
    </section>
    <div id="transcript" class={responsive ? `w-full ${width()} mx-auto mt-6` : ""}><For each={t.renderBlocks()}>{(b) => <AssistantTurnContent ctx={ctx} block={b} finished={t.sessionStatus() !== "running"} />}</For></div>
  </main>;
}, document.getElementById("root")!);
