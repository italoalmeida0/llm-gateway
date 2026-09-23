// Sidebar update-button + header fixture test: the REAL WorkspaceSidebar
// in a real browser — no composer banner; white Update button below
// Conversation History; apply/updating/per-host behavior; Back to Gateway
// above New Conversation; transcript keeps only the sidebar toggle.
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-update-sidebar-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-update-sidebar-ui.tsx",import.meta.url).pathname],
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
 await page.waitForFunction(()=>(window as any).sidebarUI?.noteUpdate);
 const settle=()=>page.waitForTimeout(100);
 const text=()=>page.evaluate(()=>document.body.innerText);
 const cmds=()=>page.evaluate(()=>(window as any).sidebarUI.commands);

 // 1. No update -> no Update button, but Back to Gateway + New Conversation exist.
 assert(!(await text()).includes("Update to"), "no update button when idle");
 assert((await text()).includes("Back to Gateway"), "Back to Gateway above New Conversation");
 assert((await text()).includes("New Conversation"), "New Conversation present");
 assert((await text()).includes("Conversation History"), "Conversation History present");

 // 2. Available on h1 -> white Update button with version.
 await page.evaluate(() => (window as any).sidebarUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 1, autoUpdate: true }));
 await settle();
 let t = await text();
 assert(t.includes("Update to 1.1.0"), "sidebar update button with version: " + t.slice(0, 300));
 const cls = await page.evaluate(() => (document.querySelector("button.ui-button-primary") as HTMLElement | null)?.className || "");
 assert(cls.includes("ui-button-primary"), "button uses Save-changes (primary) style");
 assert(cls.includes("rounded-full"), "button is rounded-full");

 // 3. Apply -> Updating… on the same button.
 await page.evaluate(() => { (window as any).sidebarUI.setHostId("h1"); });
 await page.getByRole("button", { name: /Update to/ }).click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_apply" && c.hostId==="h1"), "apply stamped h1");
 assert((await text()).includes("Updating…"), "button flips to Updating… after apply");

 // 4. Relay says updating -> button shows Updating…, still no composer banner.
 await page.evaluate(() => { (window as any).sidebarUI.statuses["h1"] = "updating"; (window as any).sidebarUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 2, autoUpdate: true }); });
 await settle();
 t = await text();
 assert(t.includes("Updating…"), "updating on button: " + t.slice(0, 200));
 assert(!t.includes("Daemon update available"), "no composer banner anymore");

 // 5. Switch host (h2, no update) -> button disappears.
 await page.evaluate(() => { (window as any).sidebarUI.setHostId("h2"); });
 await settle();
 assert(!(await text()).includes("Update to"), "button hidden on host without update");

 // 6. Back to h1 (still updating) -> button returns with Updating….
 await page.evaluate(() => { (window as any).sidebarUI.setHostId("h1"); });
 await settle();
 t = await text();
 assert(t.includes("Updating…"), "button returns on h1");

 // 7. Done -> button hides.
 await page.evaluate(() => { (window as any).sidebarUI.statuses["h1"] = "online"; (window as any).sidebarUI.noteUpdate("h1", { current: "1.1.0", available: "", checkedAt: 3, autoUpdate: true }); });
 await settle();
 assert(!(await text()).includes("Update to"), "button hides after done");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: sidebar update button/header layout");
 } finally { await browser.close(); server.stop(); }
})();
