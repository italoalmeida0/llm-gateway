// Update F5 matrix: the REAL UpdateFreezeOverlay + REAL persisted hook in a
// real browser, with page.reload() between steps (localStorage survives,
// WS state does not — exactly like closing/reopening the tab).
//
// Cases:
//   A. h1 updating -> F5 on h1 -> relay replays updating -> overlay RETURNS
//   B. h1 updating -> switch h2 -> F5 on h2 -> overlay must NOT appear
//      (h2 reports online; stale h1 state must not leak)
//   C. h1 pending (apply clicked, no freeze yet) -> F5 -> daemon reports
//      idle unfrozen -> lifecycle reconciles to idle, NO overlay, button live
//   D. h1 updating + target reached (done missed) -> F5 -> reconciles done
//
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-update-f5-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-update-f5-ui.tsx",import.meta.url).pathname],
  target:"browser",plugins:[iconifyPlugin,solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: (req) => new URL(req.url).pathname === "/bundle.js" ? new Response(bundle.outputs[0]) :
  new Response('<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',{headers:{"Content-Type":"text/html"}})});
import assert from "node:assert/strict";
(async()=> {
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
 try {
 const page = await browser.newPage();
 const errors:string[]=[];page.on('pageerror',(err:Error)=>errors.push(String(err)));
 const url = server.url.toString();
 const settle=()=>page.waitForTimeout(120);
 const text=()=>page.evaluate(()=>document.body.innerText);
 const boot=async () => {
   await page.goto(url);
   await page.waitForFunction(()=>(window as any).f5UI?.noteUpdate);
   await settle();
 };

 // ---- A: h1 updating -> F5 on h1 -> overlay RETURNS ----
 await boot();
 await page.evaluate(() => { (window as any).f5UI.statuses["h1"] = "updating"; (window as any).f5UI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 1, autoUpdate: true }); });
 await settle();
 assert((await text()).includes("Updating one…"), "A: overlay before F5");
 await page.reload();
 await page.waitForFunction(()=>(window as any).f5UI?.noteUpdate);
 await settle();
 // Fresh boot: statuses reset to online, persisted lifecycle says
 // updating. The relay replays host_status updating to every frontend
 // that connects mid-update; emulate that replay:
 await page.evaluate(() => { (window as any).f5UI.statuses["h1"] = "updating"; (window as any).f5UI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 2, autoUpdate: true }); });
 await settle();
 assert((await text()).includes("Updating one…"), "A: overlay returns after F5 + replay");

 // ---- B: switch h2 -> F5 on h2 -> NO overlay ----
 await page.evaluate(() => (window as any).f5UI.setHostId("h2")); await settle();
 assert(!(await text()).includes("Updating"), "B: overlay hides on switch-away");
 await page.reload();
 await page.waitForFunction(()=>(window as any).f5UI?.noteUpdate);
 await settle();
 // Boot lands on h1 again in the fixture (default signal); switch to h2
 // then emulate h2's host answering online.
 await page.evaluate(() => (window as any).f5UI.setHostId("h2")); await settle();
 await page.evaluate(() => (window as any).f5UI.noteUpdate("h2", { current: "1.0.0", available: "", checkedAt: 3, autoUpdate: true }));
 await settle();
 assert(!(await text()).includes("Updating"), "B: no overlay after F5 on clean host (stale h1 state must not leak)");

 // ---- C: pending (no freeze) -> F5 -> reconciles idle, no overlay ----
 await page.evaluate(() => (window as any).f5UI.setHostId("h1")); await settle();
 await page.evaluate(() => {
   // apply() equivalent without a daemon: persist pending directly
   const raw = JSON.parse(localStorage.getItem("llmgw-rc-updates") || "{}");
   raw.h1 = { ...(raw.h1 ?? {}), lifecycle: "pending", target: "1.1.0", current: "1.0.0", available: "1.1.0" };
   localStorage.setItem("llmgw-rc-updates", JSON.stringify(raw));
 });
 await page.reload();
 await page.waitForFunction(()=>(window as any).f5UI?.noteUpdate);
 await settle();
 assert((await page.evaluate(()=>document.getElementById("lifecycle")?.textContent)) === "pending", "C: pending survives F5 until daemon answers");
 // Host answers online WITHOUT update_done (ghost update: updater died
 // mid-flight, re-pair, crash): reconcile -> idle, button live again.
 await page.evaluate(() => { (window as any).f5UI.setOnline("h1"); (window as any).f5UI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 4, autoUpdate: true }); });
 await settle();
 assert(!(await text()).includes("Updating"), "C: no overlay for stale pending");
 assert((await page.evaluate(()=>document.getElementById("lifecycle")?.textContent)) === "idle", "C: lifecycle back to idle, button live again");

 // ---- D: updating + target reached -> F5 -> reconciles done ----
 await page.evaluate(() => {
   const raw = JSON.parse(localStorage.getItem("llmgw-rc-updates") || "{}");
   raw.h1 = { ...(raw.h1 ?? {}), lifecycle: "updating", target: "1.1.0", current: "1.0.0", available: "1.1.0" };
   localStorage.setItem("llmgw-rc-updates", JSON.stringify(raw));
 });
 await page.reload();
 await page.waitForFunction(()=>(window as any).f5UI?.noteUpdate);
 await settle();
 // Daemon now reports the NEW version, host online (done event was missed).
 await page.evaluate(() => { (window as any).f5UI.statuses["h1"] = "online"; (window as any).f5UI.noteUpdate("h1", { current: "1.1.0", available: "", checkedAt: 5, autoUpdate: true }); });
 await settle();
 assert(!(await text()).includes("Updating"), "D: no overlay after done");
 assert((await page.evaluate(()=>document.getElementById("lifecycle")?.textContent)) === "done", "D: lifecycle done");

 // ---- E: done for v1.1.0, then v1.2.0 appears -> back to idle, button live ----
 // (The reported bug: after an update, the SAME host could never update
 // again without wiping localStorage — the finished row stuck with
 // lifecycle=done and the Update button never reappeared.)
 await page.evaluate(() => (window as any).f5UI.noteUpdate("h1", { current: "1.1.0", available: "1.2.0", checkedAt: 6, autoUpdate: true }));
 await settle();
 assert((await page.evaluate(()=>document.getElementById("lifecycle")?.textContent)) === "idle", "E: lifecycle back to idle when a NEW version appears after done");
 assert(!(await text()).includes("Updating"), "E: no overlay for new version");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: update F5 matrix (return / switch-away / stale-pending / missed-done / next-version)");
 } finally { await browser.close(); server.stop(); }
})();
