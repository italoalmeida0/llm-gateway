import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

// Real daemon + WebSocket relay + fake Anthropic provider. No credentials or external network.
const binary = process.env.DAEMON_BINARY || join(import.meta.dir, '../indirect-code-daemon/bin/indirect-code');
async function run(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `daemon-boundary-${label}-`));
  const work = join(dir, 'work'); mkdirSync(work);
  writeFileSync(join(work,'hello.txt'),'review fixture');
  const events:any[]=[]; const requests:any[]=[];
  let socket:any; let scenario='text'; let toolIssued=false;
  const sse=(name:string,input:unknown)=>{
    const items=[{type:'message_start',message:{id:'msg-review',model:'m',role:'assistant',usage:{input_tokens:10,output_tokens:0}}}];
    if(name){items.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool-review',name,input:{}}} as any);items.push({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}} as any);}
    else{items.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}} as any);items.push({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'review answer'}} as any);}
    items.push({type:'content_block_stop',index:0} as any,{type:'message_delta',delta:{stop_reason:name?'tool_use':'end_turn'},usage:{output_tokens:5}} as any,{type:'message_stop'} as any);
    return new Response(items.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
  };
  const server=Bun.serve({hostname:'127.0.0.1',port:0,
    async fetch(req,server){const u=new URL(req.url);
      if(u.pathname.endsWith('/daemon/ws')){if(server.upgrade(req))return;return new Response('bad ws',{status:400});}
      if(u.pathname==='/api/indirect-code/models')return Response.json({models:[{id:'m',limit:{context:1000000,output:1024}}]});
      if(req.method==='POST'&&u.pathname.endsWith('/messages')){
        const body=await req.json();requests.push({scenario,body});
        if((scenario==='approval'||scenario==='question')&&!toolIssued){toolIssued=true;return scenario==='approval'?sse('read',{path:join(work,'hello.txt')}):sse('question',{questions:[{header:'Choice',question:'Pick?',options:[{label:'One'}]}]});}
        if(scenario==='approval'||scenario==='question')return sse('mark_task_as_complete',{summary:'Done'});
        return sse('',null);
      }
      return Response.json({success:true});
    },
    websocket:{open(ws){socket=ws},message(_ws,data){try{events.push(JSON.parse(String(data)))}catch{}}}
  });
  writeFileSync(join(dir,'config.json'),JSON.stringify({gateway_url:`http://127.0.0.1:${server.port}`,daemon_token:'local-review-token',api_key:'local-review-key',host_id:'review-host',name:'Review',auto_update:false,settings:{no_auto_title:true,reasoning:'none',auto_compact_threshold:0}}));
  const proc=Bun.spawn([binary,'--slot','a','--data-dir',dir],{stdout:Bun.file(join(dir,'stdout.log')),stderr:Bun.file(join(dir,'stderr.log'))});
  const wait=async(pred:()=>any,ms=4000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const v=pred();if(v)return v;await Bun.sleep(10)}return null};
  const send=(m:any)=>socket.send(JSON.stringify({...m,hostId:'review-host'}));
  const create=async(id:string,mode='talk',access='full')=>{send({type:'create_session',requestId:id,cwd:work,title:'original',model:'m',options:{mode,access,effort:'none'}});const ev=await wait(()=>events.find(e=>e.type==='session_created'&&e.requestId===id));if(!ev)throw Error('create timeout');return ev.session.id;};
  const prompt=async(sid:string,text:string,extra={})=>{const from=events.length;send({type:'prompt',sessionId:sid,text,...extra});const result = await wait(()=>events.slice(from).find(e=>e.type==='session_status'&&e.sessionId===sid&&e.status==='idle')); assert.ok(result, 'turn did not finish'); return result;};
  try{
    if(!await wait(()=>socket,12000))throw Error('daemon did not connect: '+readFileSync(join(dir,'stderr.log'),'utf8'));
    const sid=await create('simple');
    send({type:'rename_session',sessionId:sid,title:'renamed'});
    await wait(()=>events.find(e=>e.type==='session_renamed'&&e.title==='renamed'));
    send({type:'pull',id:'pull-rename',collection:'sessions'});
    const mirror=await wait(()=>events.find(e=>e.type==='pull-response'&&e.id==='pull-rename'));
    const renamed=mirror?.items?.find((x:any)=>x.id===sid)?.title;
    send({type:'upload_attachment',sessionId:sid,requestId:'upload',name:'notes.txt',mime:'text/plain',data:Buffer.from('REVIEW_ATTACHMENT_SENTINEL').toString('base64')});
    const att=await wait(()=>events.find(e=>e.type==='attachment_uploaded'&&e.requestId==='upload'));
    if(!att)throw Error('upload timeout');
    await prompt(sid,'Read the attachment',{attachmentIds:[att.attachment.id]});
    const attachmentPresent=JSON.stringify(requests.at(-1)?.body).includes('REVIEW_ATTACHMENT_SENTINEL');
    for(let i=0;i<5;i++)await prompt(sid,`Next message ${i}`);
    const from=events.length;const fromReq=requests.length;
    send({type:'prompt',sessionId:sid,text:'/compact'});
    const compacted=!!await wait(()=>events.slice(from).find(e=>e.type==='session_compacted'&&e.sessionId===sid),4000);
    const compactSentAsPrompt=requests.slice(fromReq).some(r=>JSON.stringify(r.body.messages).includes('/compact'));
    scenario='approval';toolIssued=false;
    const approvalSID=await create('approval','build','ask');
    send({type:'prompt',sessionId:approvalSID,text:'Read hello.txt'});
    const approval=await wait(()=>events.find(e=>e.type==='tool_approval_request'&&e.sessionId===approvalSID));
    if(!approval)throw Error('approval not emitted');
    const n=requests.length;
    send({type:'tool_approval_response',sessionId:approvalSID,callId:approval.callId,approved:true});
    const approvalAdvanced=!!await wait(()=>requests.length>n,700);
    send({type:'cancel',sessionId:approvalSID});
    scenario='question';toolIssued=false;
    const questionSID=await create('question','build','full');
    send({type:'prompt',sessionId:questionSID,text:'Ask a question'});
    const question=await wait(()=>events.find(e=>e.type==='question_request'&&e.sessionId===questionSID));
    if(!question)throw Error('question not emitted');
    const questionHasID=typeof question.question?.id==='string';
    const questionRequests = requests.length;
    send({type:'question_response',sessionId:questionSID,questionId:question.question?.id,answers:[['One']]});
    const questionAdvanced = !!await wait(()=>requests.length > questionRequests);
    send({type:'cancel',sessionId:questionSID});
    const result = {renameMirror:renamed,attachmentPresent,compacted,compactSentAsPrompt,approvalAdvanced,questionHasID,questionAdvanced};
    console.log(JSON.stringify(result));
    assert.deepEqual(result, {renameMirror:'renamed',attachmentPresent:true,compacted:true,compactSentAsPrompt:false,approvalAdvanced:true,questionHasID:true,questionAdvanced:true});
  }finally{proc.kill('SIGKILL');await proc.exited;server.stop(true);rmSync(dir,{recursive:true,force:true})}
}
await run('current');
