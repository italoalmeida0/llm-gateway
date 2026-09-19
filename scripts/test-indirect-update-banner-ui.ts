// Update banner fixture test: the REAL StatusBanners component in a real
// browser — available banner renders, Update now applies, frozen hides the
// button and shows the stage, per-host switch swaps the world.
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-update-banner-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-update-banner-ui.tsx",import.meta.url).pathname],
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
 await page.waitForFunction(()=>(window as any).bannerUI?.noteUpdate);
 const settle=()=>page.waitForTimeout(100);
 const text=()=>page.evaluate(()=>document.body.innerText);
 const cmds=()=>page.evaluate(()=>(window as any).bannerUI.commands);

 // 1. No update -> no banner.
 assert(!(await text()).includes("Daemon update available"), "no banner when idle");

 // 2. Available on h1 -> banner with version + Update now button.
 await page.evaluate(() => (window as any).bannerUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 1, autoUpdate: true }));
 await settle();
 let t = await text();
 assert(t.includes("Daemon update available: 1.1.0"), "banner shows version: " + t.slice(0, 200));
 assert(t.includes("Update now"), "banner has Update now button");

 // 3. Click Update now -> apply command stamped with host + button flips to Updating…
 await page.evaluate(() => { (window as any).bannerUI.setHostId("h1"); });
 await page.getByRole("button", { name: "Update now" }).click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="daemon_update_apply" && c.hostId==="h1"), "apply stamped h1");
 t = await text();
 assert(t.includes("Updating…"), "button flips to Updating… after apply");

 // 4. Frozen -> button hidden, stage shown.
 await page.evaluate(() => (window as any).bannerUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 2, autoUpdate: true, frozen: true, freezeStage: "copying sessions" }));
 await settle();
 t = await text();
 assert(!t.includes("Update now"), "no Update button while frozen");
 assert(t.includes("copying sessions"), "stage shown while frozen: " + t.slice(0, 200));

 // 5. Switch host (h2, no update) -> banner disappears (world swap).
 await page.evaluate(() => { (window as any).bannerUI.setHostId("h2"); });
 await settle();
 t = await text();
 assert(!t.includes("Daemon update available"), "banner hidden on host without update");

 // 6. Back to h1 (still frozen) -> banner returns with stage.
 await page.evaluate(() => { (window as any).bannerUI.setHostId("h1"); });
 await settle();
 t = await text();
 assert(t.includes("Daemon update available: 1.1.0") && t.includes("copying sessions"), "banner returns on h1");

 // 7. Unfrozen + same version (done missed) -> lifecycle reconciles to done, banner hides.
 await page.evaluate(() => (window as any).bannerUI.noteUpdate("h1", { current: "1.1.0", available: "", checkedAt: 3, autoUpdate: true, frozen: false }));
 await settle();
 t = await text();
 assert(!t.includes("Daemon update available"), "banner hides after done-reconcile");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: update banner render/apply/freeze/switch/reconcile");
 } finally { await browser.close(); server.stop(); }
})();
