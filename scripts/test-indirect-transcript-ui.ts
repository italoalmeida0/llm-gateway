// Deterministic browser gate for transcript reconciliation and reading position.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-transcript-ui.ts
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle=await Bun.build({entrypoints:[new URL("../test/fixtures/transcript-identity-ui.tsx",import.meta.url).pathname],target:"browser",plugins:[iconifyPlugin,solidPlugin]});
const worker=await Bun.build({entrypoints:[new URL("../web/src/indirect-code/transcript/history-worker.ts",import.meta.url).pathname],target:"browser"});
if(!bundle.success || !worker.success) throw new Error([...bundle.logs,...worker.logs].join("\n"));
const workerSource=await worker.outputs[0].text();
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
 const path=new URL(req.url).pathname;
 if(path==="/bundle.js")return new Response(bundle.outputs[0]);
 if(path==="/workers/history-worker.js")return new Response(workerSource+'\nconst original = self.onmessage; self.onmessage = ev => setTimeout(() => original(ev), 100);',{headers:{"Content-Type":"text/javascript"}});
 return new Response('<!doctype html><div id="root"></div><script type="module" src="/bundle.js"></script>',{headers:{"Content-Type":"text/html"}});
}});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
try {
 const page=await browser.newPage();
 const errors:string[]=[];
 page.on("pageerror",(e:Error)=>errors.push(String(e)));
 await page.goto(server.url.toString());
 await page.waitForFunction(()=>(window as any).transcriptTest);
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.applySnapshot("s",{status:"running",messages:[{id:"u",role:"user",content:[{text:"hello"}]}],transcript:{stream:"one",seq:1}});
  t.handleAgentEvent("s",{type:"assistant_start",messageId:"a",index:1},{stream:"one",seq:2});
  t.handleAgentEvent("s",{type:"text_delta",messageId:"a",delta:"answer"},{stream:"one",seq:3});
  (window as any).originalAssistant=document.querySelector('[data-message-id="a"]');
  const snapshot={messages:[{id:"u",role:"user",content:[{text:"hello"}]},{id:"a",role:"assistant",content:[{text:"answer"},{id:"tool",name:"bash",arguments:{}}]}],transcript:{stream:"one",seq:3},status:"running"};
  t.applySnapshot("s",snapshot);
  t.handleAgentEvent("s",{type:"tool_result",messageId:"a",id:"tool",content:"done"},{stream:"one",seq:4});
  t.handleAgentEvent("s",{type:"tool_result",messageId:"a",id:"tool",content:"done"},{stream:"one",seq:4});
  t.applySnapshot("s",snapshot); // old snapshot must replay the result exactly once
 });
 await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-block-type="tool_result"]').count(),1);
 assert(await page.evaluate(()=>(window as any).originalAssistant===document.querySelector('[data-message-id="a"]')),"Solid remounted the same assistant identity");
 await page.evaluate(async()=>{
  const {t}=(window as any).transcriptTest;
  t.resetForSession();
  const messages=Array.from({length:60},(_,i)=>({id:`row-${i}`,role:i%2?"assistant":"user",content:[{text:`row ${i}`}]}));
  const p=t.applySessionContent("s",messages,undefined,undefined,{transcript:{stream:"two",seq:1}});
  t.handleAgentEvent("s",{type:"assistant_start",messageId:"live",index:60},{stream:"two",seq:2});
  t.handleAgentEvent("s",{type:"text_delta",messageId:"live",delta:"while worker normalizes"},{stream:"two",seq:3});
  await p;
 });
 assert.equal(await page.locator('[data-message-id="live"]').textContent(),"while worker normalizes");
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  const el=document.querySelector('#viewport') as HTMLElement;
  el.scrollTop=1200; t.transcriptScroll.detach();
  const anchor=document.querySelector('[data-message-id="row-16"]')!;
  (window as any).readingAnchor={node:anchor,top:anchor.getBoundingClientRect().top};
  const msgs=t.messages().filter((m:any)=>m.id!=="row-0").map((m:any)=>({id:m.id,role:m.role,content:m.blocks.map((b:any)=>({text:b.text || ""}))}));
  (window as any).pending=t.applySessionContent("s",msgs,undefined,undefined,{transcript:{stream:"two",seq:4}});
  t.handleStatusEvent({sessionId:"s",status:"idle",transcript:{stream:"two",seq:5}});
 });
 await page.evaluate(()=>(window as any).pending);
 await page.waitForTimeout(100);
 assert(await page.evaluate(()=>{
  const a=(window as any).readingAnchor;
  return a.node===document.querySelector('[data-message-id="row-16"]') && Math.abs(a.node.getBoundingClientRect().top-a.top)<2;
 }),"unpinned snapshot moved the reading anchor");
 await page.evaluate(async()=>{
  const {t,setSid}=(window as any).transcriptTest;
  const old=Array.from({length:60},(_,i)=>({id:`old-${i}`,role:"user",content:[{text:"old"}]}));
  const pending=t.noteHistoryPage(old,{firstIndex:0,oldestTurn:1});
  t.resetForSession(); setSid("other");
  t.applySnapshot("other",{messages:[{id:"other",role:"user",content:[{text:"correct session"}]}]});
  await pending;
 });
 assert.deepEqual(await page.locator('[data-message-id]').evaluateAll((nodes:Element[])=>nodes.map(n=>n.getAttribute('data-message-id'))),["other"]);
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.resetForSession();
  t.applySnapshot("other",{status:"running",messages:[
   {id:"kept",role:"user",content:[{text:"keep"}]},
   {id:"removed",role:"assistant",content:[{text:"discard"}]},
  ],transcript:{stream:"fork",seq:1}});
  t.handleTruncated("other",0,{stream:"fork",seq:2});
  // A reused raw index must belong to the regenerated response, not its predecessor.
  t.handleAgentEvent("other",{type:"assistant_start",messageId:"replacement",index:1},{stream:"fork",seq:3});
  t.handleStatusEvent({sessionId:"s",status:"idle",transcript:{stream:"unrelated",seq:90}});
  t.handleAgentEvent("other",{type:"text_delta",messageId:"replacement",delta:"new content"},{stream:"fork",seq:4});
  t.handleTruncated("other",-1,{stream:"fork",seq:2}); // duplicate must not clear the new response
 });
 assert.deepEqual(await page.locator('[data-message-id]').evaluateAll((nodes:Element[])=>nodes.map(n=>n.getAttribute('data-message-id'))),["kept","replacement"]);
 assert.equal(await page.locator('[data-message-id="replacement"]').textContent(),"new content");
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.resetForSession();
  t.applySnapshot("other",{status:"running",thinkingStartedAt:Date.now(),messages:[{id:"reading",role:"assistant",content:[{summary:"reading this reasoning"}]}],transcript:{stream:"reading",seq:1}});
 });
 const reasoning=page.locator('#actual [data-thinking-row] .rc-markdown');
 await reasoning.waitFor({state:"visible",timeout:5000}).catch(async e=>{throw new Error(String(e)+await page.locator("#actual").innerHTML());});
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.transcriptScroll.detach();
  t.handleStatusEvent({sessionId:"other",status:"idle",transcript:{stream:"reading",seq:2}});
 });
 await page.waitForTimeout(100);
 assert(await reasoning.isVisible(),"turn end collapsed the content being read while unpinned");
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.resetForSession();
  t.applySnapshot("other",{status:"running",messages:[{id:"answer",role:"assistant",streaming:true,content:[{summary:"thought"},{text:"reading this answer"}]}],transcript:{stream:"answer",seq:1}});
 });
 const answer=page.locator('#actual [data-text-row] .rc-markdown');
 await answer.waitFor({state:"visible",timeout:5000}).catch(async e=>{throw new Error(String(e)+await page.locator("#actual").innerHTML());});
 await page.evaluate(()=>{
  const {t}=(window as any).transcriptTest;
  t.transcriptScroll.detach();
  t.handleStatusEvent({sessionId:"other",status:"idle",transcript:{stream:"answer",seq:2}});
 });
 await page.waitForTimeout(100);
 assert(await answer.isVisible(),"turn end hid the answer being read while unpinned");
 assert.equal(await page.locator('#actual [data-turn-final]').count(),0,"turn end moved the answer while unpinned");
 assert.deepEqual(errors,[]);
 console.log("PASS: stable DOM identity, replayed tool results, async snapshot ordering, unpinned scroll anchor, stale history rejection, discard/index reuse, session isolation, unpinned turn-end disclosures");
} finally {await browser.close();server.stop(true);}
