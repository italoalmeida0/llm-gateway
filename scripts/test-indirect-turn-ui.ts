// Run with an existing Playwright installation; no application dependency is added.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs bun scripts/test-indirect-turn-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-turn-ui.tsx",import.meta.url).pathname],
  target:"browser",plugins:[iconifyPlugin,solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: (req) => new URL(req.url).pathname === "/bundle.js" ? new Response(bundle.outputs[0]) :
  new Response('<html><head><style>body{font-family:sans-serif}.max-h-64{max-height:16rem}.max-h-96{max-height:24rem}.max-h-56{max-height:14rem}.overflow-auto,.overflow-y-auto{overflow-y:auto}.rc-markdown{white-space:pre-wrap}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"Content-Type":"text/html"}})});
import assert from "node:assert/strict";
(async()=> {
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
 try {
 const page=await browser.newPage();
 const errors:string[]=[];page.on('pageerror',(err:Error)=>errors.push(String(err)));
 await page.goto(server.url.toString());
 await page.waitForFunction(()=>(window as any).turnUI?.setMessages);
 const settle=()=>page.waitForTimeout(80);
 const send=async (blocks:any[])=>{await page.evaluate((blocks:any[])=> (window as any).turnUI.setMessages([{id:'a',role:'assistant',turnIndex:1,streaming:true,blocks}]),blocks);await settle();};
 const thought={type:'reasoning',reasoning:'Thinking now'};
 await send([thought]);
 const thinking=page.locator('[data-thinking-row] .rc-markdown');
 assert(await thinking.isVisible(),'thinking-only aggregate must render');
 await page.locator('#aggregate button').first().click();
 assert(!await thinking.isVisible(),'first click closes the auto-open aggregate');
 await page.locator('#aggregate button').first().click();
 await page.evaluate(()=>(window as any).thoughtNode=document.querySelector('[data-thinking-row]'));
 await send([{...thought,reasoning:'Thinking more'}]);
 assert(await page.evaluate(()=>(window as any).thoughtNode===document.querySelector('[data-thinking-row]')),'thinking retains DOM on delta');
 const call={type:'tool_call',toolName:'read',toolId:'r1',toolArgs:'{"path":"a.ts"}'};
 await page.evaluate(()=>{(window as any).turnUI.setThinking(null);(window as any).turnUI.setStarts({r1:1000});});
 await send([thought,call]);
 assert(!await thinking.isVisible(),'thinking closes when tool starts');
 assert(await page.locator('[data-toolseg="g:explore:r1"]').isVisible(),'current subgroup appears');
 const row=page.locator('[data-toolseg="g:explore:r1"] .group\\/tool').first();
 await page.evaluate(()=>(window as any).readNode=document.querySelector('[data-toolseg="g:explore:r1"] .group\\/tool'));
 await send([thought,call,{type:'tool_result',toolId:'r1',toolResult:'1:First line'}]);
 assert(await row.isVisible(),'a singleton has a directly accessible tool row');
 assert.equal(await page.locator('[data-toolseg="g:explore:r1"] > button').count(),0,'a singleton has no redundant group header');
 assert(!await page.locator('[data-toolseg="g:explore:r1"] .max-h-96').isVisible(),'completed singleton closes its body');
 const second={type:'tool_call',toolName:'glob',toolId:'r2',toolArgs:'{"pattern":"*.ts"}'};
 await page.evaluate(()=>(window as any).turnUI.setStarts({r2:1000}));
 await send([thought,call,{type:'tool_result',toolId:'r1',toolResult:'1:First line'},second]);
 assert(await page.evaluate(()=>(window as any).readNode===document.querySelector('[data-toolseg="g:explore:r1"] .group\\/tool')),'adding tool preserves prior row DOM');
 assert.equal(await page.locator('[data-toolseg="g:explore:r1"] .group\\/tool').count(),2,'new tool renders without retoggling aggregate');
 await page.evaluate(() => (window as any).turnUI.setStarts({}));await settle();
 assert(await row.isVisible(),'a subgroup stays open between sequential tools in the same batch');
 await page.evaluate(()=>(window as any).turnUI.setRunning(false));await settle();
 assert(!await page.locator('[data-toolseg="g:explore:r1"]').isVisible(),'turn end closes aggregate');
 await page.locator('#aggregate button').first().click();
 assert(!await row.isVisible(),'turn end also closes subgroup');
 await page.evaluate(()=>{(window as any).turnUI.setRunning(true);(window as any).turnUI.setStarts({q:1000});});
 await send([thought,{type:'tool_call',toolId:'q',toolName:'question',toolArgs:'{"questions":[{"question":"Choose?","options":[]}]}'}]);
 assert.equal(await page.getByText('Waiting for your answers…',{exact:true}).count(),0,'question detail never auto-opens');
 const files=[{path:'z.ts',status:'modified',diff:'@@ -1 +1 @@\n-old\n+new'}];
 await page.evaluate((files:any[])=>(window as any).turnUI.changes.noteBalloon({turnIndex:1,files},true),files);await settle();
 await page.locator('#changes button').first().click();
 await page.locator('#changes .cursor-pointer').filter({hasText:'z.ts'}).click();
 await settle();
 assert(await page.locator('#changes .font-mono.overflow-x-auto').isVisible(),'file diff opens');
 await page.evaluate(()=>(window as any).diffNode=document.querySelector('#changes .font-mono.overflow-x-auto'));
 await page.evaluate((files:any[])=>(window as any).turnUI.changes.noteBalloon({turnIndex:1,files:[{path:'a.ts',status:'new',diff:'+first'},...files]},true),files);await settle();
 assert(await page.evaluate(()=>(window as any).diffNode===document.querySelector('#changes .font-mono.overflow-x-auto')),'new file keeps prior diff DOM and expansion');
 await page.evaluate((files:any[]) => (window as any).turnUI.changes.noteTurnChanges({balloons:[],live:{turnIndex:1,files:[{path:'a.ts',status:'new',diff:'+first'},...files]}}), files);await settle();
 assert(await page.evaluate(()=>(window as any).diffNode===document.querySelector('#changes .font-mono.overflow-x-auto')),'full snapshot preserves the live diff');
 await page.evaluate((files:any[])=>(window as any).turnUI.changes.noteBalloon({turnIndex:1,files},false),files);await settle();
 assert(await page.evaluate(()=>(window as any).diffNode===document.querySelector('#changes .font-mono.overflow-x-auto')),'live-to-finished preserves diff DOM');
 assert(await page.locator('#changes .font-mono.overflow-x-auto').isVisible(),'finished diff stays open');
 await page.evaluate(() => (window as any).turnUI.changes.noteTurnChanges({balloons:null}));await settle();
 assert.equal(await page.locator('#changes button').count(),0,'an empty authoritative snapshot clears obsolete balloons');
 const mcpCall={type:'tool_call',toolId:'mcp1',toolName:'mcp__remote__inspect_item_abcdef012345',toolArgs:'{"path":"remote-file","query":"example"}'};
 await page.evaluate(()=>{(window as any).turnUI.setRunning(true);(window as any).turnUI.setStarts({mcp1:1000});});
 await send([mcpCall]);
 assert(await page.getByText('Arguments',{exact:true}).isVisible(),'MCP call exposes its arguments');
 assert(await page.getByText('remote / inspect_item',{exact:true}).isVisible(),'MCP name uses a short label and tool target');
 assert.equal(await page.locator('[data-rc-tip]').count(),0,'MCP paths are not local workspace file links');
 await send([mcpCall,{type:'tool_result',toolId:'mcp1',toolResult:'remote result\n'.repeat(300),toolDurationMs:700}]);
 await page.locator('#aggregate .group\\/tool').click();
 assert(await page.getByText('remote result',{exact:false}).last().isVisible(),'MCP result remains inspectable');
 assert.equal(await page.locator('[data-tool-duration]').textContent(),'1s','MCP duration uses persisted result timing');
 // Hidden progress notes do not split runs; append into stable chunks of five.
 await page.evaluate(()=>{(window as any).turnUI.setHideNotes(true);(window as any).turnUI.setVerbose(false);});
 const commands=Array.from({length:12},(_,i)=>[
   {type:'tool_call',toolId:`cmd${i}`,toolName:i%2?'python':'bash',toolArgs:'{}'},
   {type:'tool_result',toolId:`cmd${i}`,toolResult:'done'},
   {type:'text',text:`Step ${i} completed`},
 ]).flat();
 await send(commands);
 assert.deepEqual(await page.locator('[data-toolseg] > button').allTextContents(),['Ran 5 commands','Ran 5 commands','Ran 2 commands']);
 const firstGroup=page.locator('[data-toolseg="g:command:cmd0"]');
 await firstGroup.locator('> button').click();
 await firstGroup.locator('.group\\/tool').first().click();
 const longCommands=commands.map((b:any)=>b.type==='tool_result' && b.toolId==='cmd0' ? {...b,toolResult:'Command output\n'.repeat(300)} : b);
 await send(longCommands);
 await firstGroup.locator('pre.max-h-56').first().evaluate((el:HTMLElement)=>{el.scrollTop=80;(window as any).commandBody=el;});
 await send([...longCommands,{type:'tool_call',toolName:'bash',toolId:'cmd12',toolArgs:'{}'}]);
 assert(await firstGroup.locator('pre.max-h-56').first().evaluate((el:HTMLElement)=>el===(window as any).commandBody && el.scrollTop===80),'appending tools retains an inspected body and its scroll');
 // A reconciled carrier must switch from plain text to aggregate without a reload.
 await send([{type:'text',text:'First progress note'}]);
 assert.equal(await page.locator('[data-turn-final]').count(),0);
 await send([{type:'text',text:'First progress note'},call]);
 assert(await page.locator('[data-toolseg="g:explore:r1"]').isVisible(),'text carrier can acquire tools');
 await page.evaluate(()=>{
   (window as any).turnUI.setRunning(false);
   (window as any).turnUI.setMessages([
     {id:'a',role:'assistant',turnIndex:1,turnDurationMs:83000,blocks:[{type:'text',text:'Earlier answer'}]},
     {id:'a2',role:'assistant',turnIndex:1,turnDurationMs:83000,blocks:[{type:'text',text:'Chosen final answer'}]},
   ]);
 });await settle();
 assert.equal(await page.locator('[data-turn-final]').count(),1,'text-only multi-step turn has one featured final');
 assert.equal(await page.locator('[data-turn-final]').textContent(),'Chosen final answer');
 assert.equal(await page.getByText('Earlier answer',{exact:true}).filter({visible:true}).count(),0);
 assert.equal(await page.locator('#actions [data-turn-duration]').textContent(),'1m 23s');
 assert.equal(await page.locator('#aggregate [data-turn-duration]').count(),0);
 await page.evaluate(()=>(window as any).turnUI.setMessages([{id:'a',role:'assistant',turnIndex:1,turnDurationMs:83000,blocks:[{type:'text',text:'Single final answer'}]}]));await settle();
 assert.equal(await page.locator('#actions [data-turn-duration]').textContent(),'1m 23s','plain turn also has its duration');
 assert.deepEqual(errors,[]);
 console.log('PASS: live thinking, first-click collapse, DOM identity, tool result closure, subgroup growth, turn end, question, file refresh and finalization');
 } finally {await browser.close();server.stop(true);}
})().catch(err=>{console.error(err);server.stop(true);process.exitCode=1});
