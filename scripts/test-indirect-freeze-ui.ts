// Freeze overlay fixture test: full-screen update block in a real browser.
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-freeze-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-freeze-ui.tsx",import.meta.url).pathname],
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
 await page.waitForFunction(()=>(window as any).freezeUI?.noteUpdate);
 const settle=()=>page.waitForTimeout(80);
 const frozen=()=>page.evaluate(()=>((document.querySelector("#frozen-flag") as HTMLElement).innerText));
 const overlay=()=>page.evaluate(()=>!!document.querySelector("#freeze-overlay"));

 // 1. Not frozen: no overlay.
 assert.equal(await frozen(), "false", "starts unfrozen");
 assert.equal(await overlay(), false, "no overlay initially");

 // 2. Host goes updating -> overlay shows (per-host: updating host drives it).
 await page.evaluate(() => { (window as any).freezeUI.statuses["h1"] = "updating"; (window as any).freezeUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 1, autoUpdate: true }); });
 await settle();
 assert.equal(await frozen(), "true", "updating flag");
 assert.equal(await overlay(), true, "overlay visible");
 assert.equal(await page.evaluate(()=>((document.querySelector("#freeze-stage") as HTMLElement).innerText)), "Updating…", "static text");

 // 3. Lifecycle follows the relay status (updating while status says so).
 await page.evaluate(() => (window as any).freezeUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 2, autoUpdate: true }));
 await settle();
 assert.equal(await frozen(), "true", "still updating");

 // 4. Host switching works while updating.
 await page.locator('[data-host="h2"]').click(); await settle();
 const cmds = await page.evaluate(()=>(window as any).freezeUI.commands);
 assert(cmds.some((c:any)=>c.type==="switch-host" && c.id==="h2"), "host switch allowed");

 // 5. Host back to online -> overlay hides.
 await page.evaluate(() => { (window as any).freezeUI.statuses["h1"] = "online"; (window as any).freezeUI.noteUpdate("h1", { current: "1.1.0", available: "", checkedAt: 3, autoUpdate: true }); });
 await settle();
 assert.equal(await overlay(), false, "overlay hidden after online");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: updating overlay show/switch/hide");
 } finally { await browser.close(); server.stop(); }
})();
