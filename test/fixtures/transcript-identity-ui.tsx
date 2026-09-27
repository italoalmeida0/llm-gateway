import { For, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { AssistantTurnContent, type TranscriptRenderCtx } from "../../web/src/indirect-code/components/TranscriptBlocks";

render(()=>{
 const [sid,setSid]=createSignal("s");
 const [host,setHost]=createSignal("h");
 const sent:unknown[]=[];
 const t=createTranscript({send:p=>sent.push(p),isOpen:()=>true,getSessionId:sid,getHostId:host,
  toast:()=>{},showChoice:async()=>null,onTurnIdle:()=>{},onUsageContext:()=>{}});
 const ctx: TranscriptRenderCtx = {
  renderBlocks: t.renderBlocks, messages: t.messages, sessionStatus: t.sessionStatus,
  isPinned: t.transcriptScroll.isPinned,
  thinkingStart: t.thinkingStart, thinkingElapsed: t.thinkingElapsed, thinkingIndex: t.thinkingIndex,
  toolProgress: t.toolProgress, toolStarts: t.toolStarts, turnClock: t.turnClock,
  elapsedLabel: () => "1s", specialProgress: t.specialProgress,
  backgroundJobs: () => [], bgOutput: () => ({}), bgClock: () => 0,
  verboseChat: () => true, hideToolMessages: () => false,
  setPreviewFile: () => {}, activeSession: () => null, pendingApproval: t.pendingApproval, projects: () => [],
 };
 Object.assign(window,{transcriptTest:{t,sent,setSid,setHost}});
 return <><div id="viewport" ref={t.setChatContainerRef} onScroll={t.onChatScroll}
  style={{height:"320px",overflow:"auto","overflow-anchor":"none"}}>
  <div ref={t.setChatContentRef}><For each={t.renderBlocks()}>{block=><div data-transcript-id={block.msg.id}
   style={{"min-height":"80px",border:"1px solid transparent"}}>
   <For each={block.kind==="series"?[block.msg,...block.extras]:[block.msg]}>{msg=><div data-message-id={msg.id}>
    <For each={msg.blocks}>{b=><div data-block-type={b.type} data-tool-id={b.toolId}>{b.text || b.reasoning || b.toolName || b.toolResult}</div>}</For>
   </div>}</For>
  </div>}</For></div>
 </div><div id="actual"><For each={t.renderBlocks()}>{block =>
  <AssistantTurnContent ctx={ctx} block={block} finished={t.sessionStatus() !== "running"} />
 }</For></div></>;
},document.getElementById("root")!);
