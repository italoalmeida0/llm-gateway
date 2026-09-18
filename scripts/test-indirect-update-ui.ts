// Update UI fixture test: daemon_update state machine in a real browser
// (hook + banner logic, per-host + persisted lifecycle), no gateway/daemon/model needed.
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-update-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-update-ui.tsx",import.meta.url).pathname],
  target:"browser",plugins:[iconifyPlugin,solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: (req) => new URL(req.url).pathname === "/bundle.js" ? new Response(bundle.outputs[0]) :
  new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"Content-Type":"text/html"}})});
import assert from "node:assert/strict";
(async()=> {
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
 try {
 const page=await browser.newPage();
 const errors:string[]=[];page.on('pageerror',(err:Error)=>errors.push(String(err)));
 await page.goto(server.url.toString());
 await page.waitForFunction(()=>(window as any).updateUI?.info);
 const settle=()=>page.waitForTimeout(80);
 const state=()=>page.evaluate(()=>JSON.parse((document.querySelector("#state") as HTMLElement).innerText || "null"));
 const cmds=()=>page.evaluate(()=>(window as any).updateUI.commands);
 const notes=()=>page.evaluate(()=>JSON.parse((document.querySelector("#notices") as HTMLElement).innerText || "[]"));

 // 1. Initial: no info.
 assert.equal(await state(), null, "starts null");

 // 2. daemon_update with available -> banner state (per-host: hostId first arg).
 await page.evaluate(() => (window as any).updateUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", staged: "", checkedAt: 1, autoUpdate: true }));
 await settle();
 let s = await state();
 assert.equal(s.available, "1.1.0", "available recorded");
 assert.equal(s.autoUpdate, true, "autoUpdate default true");

 // 3. Check button sends command (stamped with active host).
 await page.locator("#btn-check").click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_check" && c.hostId==="h1"), "check sends command with hostId");

 // 4. Toggle flips + sends.
 await page.locator("#btn-toggle").click(); await settle();
 s = await state();
 assert.equal(s.autoUpdate, false, "toggle optimistic");
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_toggle" && c.enabled===false), "toggle sends enabled=false");

 // 5. Apply without staged... in handoff model apply needs available.
 await page.locator("#btn-apply").click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_apply" && c.hostId==="h1"), "apply sends command with hostId");
 assert((await notes()).some((n:any)=>String(n.message).includes("1.1.0")), "apply toasts version");
 s = await state();
 assert.equal(s.lifecycle, "pending", "apply marks pending lifecycle");

 // 6. Freeze broadcast -> frozen state (loading screen driver) + updating lifecycle.
 await page.evaluate(() => (window as any).updateUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 2, autoUpdate: false, frozen: true, freezeStage: "copying sessions" }));
 await settle();
 s = await state();
 assert.equal(s.frozen, true, "frozen recorded");
 assert.equal(s.freezeStage, "copying sessions", "stage recorded");
 assert.equal(s.lifecycle, "updating", "freeze marks updating lifecycle");

 // 7. Other-host events must not bleed into the foreground host.
 await page.evaluate(() => (window as any).updateUI.noteUpdate("h2", { current: "9.9.9", available: "", checkedAt: 3, autoUpdate: true, frozen: false }));
 await settle();
 s = await state();
 assert.equal(s.current, "1.0.0", "other host state isolated");

 // 8. Failed -> toast err + failed lifecycle.
 await page.evaluate(() => (window as any).updateUI.noteFailed("h1", "boom"));
 await settle();
 assert((await notes()).some((n:any)=>n.kind==="err" && String(n.message).includes("boom")), "failed toasts err");
 s = await state();
 assert.equal(s.lifecycle, "failed", "failed lifecycle recorded");

 // 9. Done -> toast ok + done lifecycle.
 await page.evaluate(() => (window as any).updateUI.noteDone("h1", "1.1.0"));
 await settle();
 assert((await notes()).some((n:any)=>n.kind==="ok" && String(n.message).includes("1.1.0")), "done toasts ok");
 s = await state();
 assert.equal(s.lifecycle, "done", "done lifecycle recorded");

 // 10. Cancel sends command.
 await page.locator("#btn-cancel").click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_cancel"), "cancel sends command");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: update hook state machine, commands, freeze, toasts");
 } finally { await browser.close(); server.stop(); }
})();
