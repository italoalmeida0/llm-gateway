// Deterministic browser regression gate for Indirect Code hooks and mirror.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-flow-regressions-ui.ts
import assert from "node:assert/strict";

import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle=await Bun.build({entrypoints:[new URL('../test/fixtures/indirect-flow-regressions.ts',import.meta.url).pathname],target:"browser",plugins:[iconifyPlugin,solidPlugin]});
if(!bundle.success)throw new Error(bundle.logs.join('\n'));
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){return new URL(req.url).pathname==='/bundle.js'?new Response(bundle.outputs[0]):new Response('<html><script type="module" src="/bundle.js"></script></html>',{headers:{'content-type':'text/html'}})}});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
try {
 const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.url.toString());await page.waitForFunction(()=>!!(window as any).flowRegression);
 const mirror=await page.evaluate(async()=>{
   const a=(window as any).flowRegression;const store=a.layer.storeFor('h');await store.syncAll();
   const before=store.sessions.find({}).fetch().length;
   a.offline();let rejected=false;try{await store.syncAll()}catch{rejected=true;}
   return {rejected,before,afterOfflineError:store.sessions.find({}).fetch().length};
 });
 const freshAck=await page.evaluate(async()=>{
   const {t,sent}=(window as any).flowRegression;
   t.applySnapshot('s',{status:'idle',messages:[{id:'u',role:'user',turnIndex:1,content:[{text:'original'}]},{id:'old',role:'assistant',turnIndex:1,content:[{text:'old answer'}]}]});
   await t.regenerateMsg(1,()=>"m",()=>true);
   const req=sent.at(-1);
   t.handleTruncated('s',-1);
   await t.applySessionContent('s',[{id:'new-user',role:'user',turnIndex:1,content:[{text:'original'}]}]);
   t.handleAgentEvent('s',{type:'assistant_start',messageId:'new-answer',index:1,turnIndex:1});
   t.handleAgentEvent('s',{type:'text_delta',messageId:'new-answer',delta:'new response'});
   const before=t.messages().map((m:any)=>m.id);
   t.noteResendResult({ok:true,requestId:req.requestId,sessionId:'s'});
   return {before,after:t.messages().map((m:any)=>m.id)};
 });
 const lateAck=await page.evaluate(async()=>{
   const a=(window as any).flowRegression;const {t,sent}=a;t.resetForSession();
   t.applySnapshot('s',{status:'idle',messages:[{id:'u',role:'user',turnIndex:1,content:[{text:'first'}]},{id:'a',role:'assistant',turnIndex:1,content:[{text:'answer'}]}]});
   await t.regenerateMsg(1,()=>"m",()=>true);const req=sent.at(-1);
   t.resetForSession();a.setSid('other');
   t.applySnapshot('other',{status:'idle',messages:[{id:'o-u',role:'user',turnIndex:1,content:[{text:'other'}]},{id:'o-a',role:'assistant',turnIndex:1,content:[{text:'other answer'}]}]});
   const before=t.messages().length;t.noteResendResult({ok:true,sessionId:'s',requestId:req.requestId});
   return {before,after:t.messages().length};
 });
 const background=await page.evaluate(()=>{
   const a=(window as any).flowRegression;a.setSid('s');const bg=a.bg;
   bg.noteSessionTaskEvent({type:'bg_task_registered',sessionId:'s',jobId:'job',kind:'bash'});
   // Current dispatcher supplies the daemon byte offset, sequence and total.
   bg.noteOutput('job','line one\n','s',0,1,9,true);
   bg.noteSessionTasks([{id:'job',kind:'bash',status:'done',content:'line one\n',totalLines:1,totalBytes:9,seq:1}],'s');
   return {snapshot:bg.sessionContent('job'),liveTailAlreadyInSnapshot:bg.liveTail('job')};
 });
 const undo=await page.evaluate(async()=>{
 const a=(window as any).flowRegression;a.setSid('original');const before=a.sent.length;const pending=a.undo.undoTurn(3);
 a.setSid('other-session');a.confirmUndo(true);await pending;
 return {before,after:a.sent.length};
 });
 const draft=await page.evaluate(()=>{
 const a=(window as any).flowRegression;const {t}=a;a.setSid('my-session');t.resetForSession();
 t.applySnapshot('my-session',{messages:[{id:'user',role:'user',turnIndex:1,content:[{text:'original'}]}]});
 t.startEditMsg(0,t.messages()[0]);t.updateEditingMsgText('unsaved important text');
 const before=t.editingMsgText();
 t.noteResendResult({ok:true,sessionId:'another-tab-session'});
 return {before,after:t.editingMsgText()};
 });


 const newerDraft=await page.evaluate(async()=>{
  const a=(window as any).flowRegression;const t=a.t;a.setSid('newer-draft');t.resetForSession();
  t.applySnapshot('newer-draft',{messages:[{id:'edit-a',role:'assistant',turnIndex:1,content:[{text:'answer'}]}]});
  t.startEditMsg(0,t.messages()[0]);t.updateEditingMsgText('submitted edit');
  await t.saveEditMsg(0,t.messages()[0],()=>"model",()=>false);
  const req=a.sent.at(-1);t.updateEditingMsgText('newer unsent edit');
  t.noteResendResult({ok:true,sessionId:'newer-draft',requestId:req.requestId});
  return t.editingMsgText();
 });
 assert.equal(newerDraft,'newer unsent edit','ACK must preserve changes typed after submit');

 const choiceDraft=await page.evaluate(async()=>{
  const a=(window as any).flowRegression;const t=a.t;a.setSid('choice-draft');t.resetForSession();
  t.applySnapshot('choice-draft',{messages:[{id:'choice-u',role:'user',turnIndex:1,content:[{text:'original'}]}]});
  t.startEditMsg(0,t.messages()[0]);t.updateEditingMsgText('submitted edit');
  a.deferChoice();const before=a.sent.length;
  const pending=t.saveEditMsg(0,t.messages()[0],()=>"model",()=>false);
  t.updateEditingMsgText('changed during confirmation');a.choose('resend');await pending;
  return {sent:a.sent.length-before,text:t.editingMsgText()};
 });
 assert.deepEqual(choiceDraft,{sent:0,text:'changed during confirmation'});
 const forkDraft=await page.evaluate(async()=>{
  const a=(window as any).flowRegression;const t=a.t;a.setSid('fork-draft');t.resetForSession();a.setChoice('fork');
  t.applySnapshot('fork-draft',{messages:[{id:'fork-u',role:'user',turnIndex:1,content:[{text:'original'}]}]});
  t.startEditMsg(0,t.messages()[0]);t.updateEditingMsgText('fork edit');
  await t.saveEditMsg(0,t.messages()[0],()=>"selected-model",()=>true);
  const req=a.sent.at(-1);const before=t.editingMsgText();
  t.updateEditingMsgText('new draft after fork');
  t.noteForkSessionResult({requestId:req.requestId,session:{id:'fork-result'}});
  const after=t.editingMsgText();t.resetForSession();
  return {before,after,model:req.model,yolo:req.yolo,forking:t.forking()};
 });
 assert.deepEqual(forkDraft,{before:'fork edit',after:'new draft after fork',model:'selected-model',yolo:true,forking:false});
 const byteJoin=await page.evaluate(()=>{
  const a=(window as any).flowRegression;a.setSid('bytes');const bg=a.bg;
  bg.noteSessionTasks([{id:'utf',status:'running',content:'á',totalBytes:2,seq:1}],'bytes');
  bg.noteOutput('utf','áβ!','bytes',0,2,5,true);
  bg.noteOutput('utf','áβ!','bytes',0,2,5,true);
  const joined=bg.sessionContent('utf')+bg.liveTail('utf');
  bg.noteSessionTasks([{id:'utf',status:'done',content:'áβ!',totalBytes:5,seq:2}],'bytes');
  const tail=bg.liveTail('utf');bg.purgeSession('bytes');
  const afterDelete=bg.sessionJobs().length;bg.reset();
  return {joined,tail,afterDelete};
 });
 assert.deepEqual(byteJoin,{joined:'áβ!',tail:'',afterDelete:0});

 const boundedOutput=await page.evaluate(()=>{
  const a=(window as any).flowRegression;a.setSid('bounded');const bg=a.bg;
  bg.noteSessionTasks([{id:'log',status:'running',content:'',totalBytes:0,seq:0}],'bounded');
  for(let i=0;i<100;i++) bg.noteOutput('log','x'.repeat(4096),'bounded',i*4096,i+1,(i+1)*4096,true);
  const bytes=new TextEncoder().encode(bg.liveTail('log')).length;bg.reset();return bytes;
 });
 assert(boundedOutput>0 && boundedOutput<=96*1024,'live segments must retain a bounded display tail');
 assert.equal(mirror.before,1);assert.equal(mirror.afterOfflineError,1);assert(mirror.rejected);
 assert.deepEqual(freshAck.after,freshAck.before);assert(freshAck.after.includes('new-answer'));
 assert.equal(lateAck.after,lateAck.before);assert.equal(lateAck.after,2);
 assert.equal(background.snapshot,'line one\n');assert.equal(background.liveTailAlreadyInSnapshot,'');
 assert.equal(undo.after,undo.before);assert.equal(draft.after,'unsaved important text');
 assert.deepEqual(errors,[]);
 console.log('PASS: mirror errors, stale ACKs, edit/fork draft preservation, confirmation races, UTF-8 snapshot joins, undo target, task cleanup.');
}finally{await browser.close();server.stop(true)}
