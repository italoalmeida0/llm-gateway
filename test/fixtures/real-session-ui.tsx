import { For, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { createBackground } from "../../web/src/indirect-code/hooks/useBackground";
import { AssistantTurnContent, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";
import { BackgroundCtx, UICtx } from "../../web/src/indirect-code/ctx";

/** Renders a real daemon session JSONL through the production transcript. */
const sent: unknown[] = [];
(window as any).__sent = sent;
const [sid, setSid] = createSignal("real");
const [host] = createSignal("h");
const bg = createBackground({ send: (p) => sent.push(p), isOpen: () => true, getSessionId: () => sid(), toast: () => {} });
const uiStub = { convWidthClass: () => "max-w-3xl" } as any;

const t = createTranscript({
  send: (p) => sent.push(p),
  isOpen: () => true,
  getSessionId: sid,
  getHostId: host,
  toast: () => {},
  showChoice: async () => null,
  onTurnIdle: () => {},
  onUsageContext: () => {},
});

const ctx: TranscriptRenderCtx = {
  renderBlocks: t.renderBlocks,
  messages: t.messages,
  sessionStatus: t.sessionStatus,
  isPinned: t.transcriptScroll.isPinned,
  thinkingStart: t.thinkingStart,
  thinkingElapsed: t.thinkingElapsed,
  thinkingIndex: t.thinkingIndex,
  toolProgress: t.toolProgress,
  toolStarts: t.toolStarts,
  turnClock: t.turnClock,
  elapsedLabel: () => "1s",
  specialProgress: t.specialProgress,
  backgroundJobs: () => bg.sessionJobs(),
  bgOutput: () => bg.output(),
  bgClock: () => bg.clock(),
  verboseChat: () => true,
  hideToolMessages: () => false,
  setPreviewFile: () => {},
  activeSession: () => null,
  pendingApproval: t.pendingApproval,
  projects: () => [],
};

Object.assign(window, { realSession: { t, bg, sid, setSid } });

render(
  () => (
    <UICtx.Provider value={uiStub}>
      <BackgroundCtx.Provider value={bg as any}>
        <main class="px-4 py-6 max-w-3xl mx-auto">
          <div ref={t.setChatContainerRef} onScroll={t.onChatScroll} style={{ "overflow-anchor": "none" }}>
            <div ref={t.setChatContentRef}>
              <For each={t.renderBlocks()}>
                {(block) => (
                  <div data-transcript-id={block.msg.id} class="mb-6">
                    <AssistantTurnContent ctx={ctx} block={block} finished={t.sessionStatus() !== "running"} />
                  </div>
                )}
              </For>
            </div>
          </div>
        </main>
      </BackgroundCtx.Provider>
    </UICtx.Provider>
  ),
  document.getElementById("root")!,
);

// Feed the real session: one JSONL line per turn, messages flattened.
fetch("/session.jsonl")
  .then((r) => r.text())
  .then(async (text) => {
    const msgs: any[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      for (const m of o.messages || []) msgs.push(m);
    }
    await t.applySessionContent("real", msgs);
    (window as any).realSessionReady = true;
  });
