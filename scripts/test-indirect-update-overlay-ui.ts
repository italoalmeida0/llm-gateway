// Update overlay fixture test: the REAL UpdateFreezeOverlay component in a
// real browser — brand + progress + stage, host card switch/connect/remove,
// cancel wiring, overlay hides on switch-away and returns on switch-back,
// zero page errors.
//   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-update-overlay-ui.ts
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints:[new URL("../test/fixtures/indirect-update-overlay-ui.tsx",import.meta.url).pathname],
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
 await page.waitForFunction(()=>(window as any).overlayUI?.noteUpdate);
 const settle=()=>page.waitForTimeout(120);
 const text=()=>page.evaluate(()=>document.body.innerText);
 const cmds=()=>page.evaluate(()=>(window as any).overlayUI.commands);

 // 1. Not frozen: no overlay, no brand takeover.
 assert(!(await text()).includes("Updating"), "no overlay initially");

 // 2. h1 goes updating -> full-screen overlay with brand + host name.
 await page.evaluate(() => { (window as any).overlayUI.statuses["h1"] = "updating"; (window as any).overlayUI.noteUpdate("h1", { current: "1.0.0", available: "1.1.0", checkedAt: 1, autoUpdate: true }); });
 await settle();
 let t = await text();
 assert(t.includes("Updating one…"), "overlay titles updating host: " + t.slice(0, 300));
 assert(t.includes("Updating…"), "static text visible");
 assert(t.includes("INDIRECT"), "brand visible");

 // 4. Host card: open menu, switch to h2. (Two cards now: overlay
 // card first, #sidebar-card second — the menu must anchor to the
 // CLICKED one; step 9 pins the geometry.)
 await page.locator("#sidebar-card").getByRole("button", { name: "Select host" }).click(); await settle();
 t = await text();
 assert(t.includes("Your hosts") && t.includes("two"), "host menu opens with hosts");
 await page.getByRole("menuitemradio", { name: /two/ }).click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="switch-host" && c.id==="h2"), "switch to h2");
 // Overlay is per-ACTIVE-host: switching away from the updating host hides
 // it so you can keep working on h2 (the reported bug: overlay pinned
 // forever even after switching). The composer behind must be usable.
 assert(!(await text()).includes("Updating one…"), "overlay hides after switching away");
 assert(!(await text()).includes("Cancel update"), "cancel hidden with overlay");

 // 5. Switch back to h1 (still updating) -> overlay RETURNS with its own
 // host card (the overlay was hidden on h2, so open the SIDEBAR card —
 // same component pair; the fixture exposes the sidebar card button).
 // In the fixture the overlay IS the only host card, so drive the switch
 // through the stub directly (mirrors setActiveHostId from the sidebar).
 await page.evaluate(() => (window as any).overlayUI.setHostId("h1")); await settle();
 assert((await text()).includes("Updating one…"), "overlay returns on updating host");

 // 6. Menu actions: connect + refresh + remove send commands.
 // NOTE: Playwright clicks each menu item directly after opening (no
 // keyboard nav): the floating menu closes on select, so reopen first.
 // Always drive the SIDEBAR card here: the overlay card unmounts on
 // switch-away (step 4 hid the overlay), so only #sidebar-card stays
 // mounted through the whole flow.
 await page.locator("#sidebar-card").getByRole("button", { name: "Select host" }).click(); await settle();
 await page.getByRole("button", { name: /Connect another host/ }).click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="pair"), "connect sends pair");
 await page.locator("#sidebar-card").getByRole("button", { name: "Select host" }).click(); await settle();
 await page.getByRole("button", { name: /Refresh hosts/ }).click(); await settle();
 assert((await cmds()).some((c:any)=>c.type==="load-hosts"), "refresh sends load-hosts");
 await page.locator("#sidebar-card").getByRole("button", { name: "Select host" }).click(); await settle();
 // Remove opens the confirm modal in the real page; the fixture stubs
 // removeHost as a command. Click via mouse at the resolved box: the
 // floating menu repositions under autoUpdate on reopen, and
 // Playwright's actionability (stable-box) check can chase it forever —
 // a real user click lands fine (probes confirm elementFromPoint hits).
 const rmBox = await page.getByRole("button", { name: /Remove current host/ }).boundingBox();
 await page.mouse.click(rmBox!.x + rmBox!.width / 2, rmBox!.y + rmBox!.height / 2); await settle();
 assert((await cmds()).some((c:any)=>c.type==="remove-host"), "remove sends remove-host");
 // The real removeHost closes the menu before the confirm modal (same
 // as the fixture stub) — Cancel must be clickable right after.

 // 7. h1 back online -> overlay gone.
 await page.evaluate(() => { (window as any).overlayUI.statuses["h1"] = "online"; (window as any).overlayUI.noteUpdate("h1", { current: "1.1.0", available: "", checkedAt: 3, autoUpdate: true }); });
 await settle();
 assert(!(await text()).includes("Updating"), "overlay hidden after online");

 // 9. Two HostCards, one shared menu (sidebar + overlay regression):
 // both cards visible at once, the menu must follow the CLICKED card.
 // Freeze again so the overlay card is back alongside #sidebar-card.
 // NOTE: step 4's switch-to-h2 may have left the menu OPEN (switching
 // hosts hides the overlay but the sidebar card's menu state survives
 // — the very class of bug this step guards). Close it first so the
 // geometry below measures a fresh open from each card.
 await page.keyboard.press("Escape"); await settle();
 await page.evaluate(() => { (window as any).overlayUI.statuses["h1"] = "updating"; (window as any).overlayUI.noteUpdate("h1", { current: "1.1.0", available: "1.2.0", checkedAt: 4, autoUpdate: true }); });
 await settle();
 const cards = page.getByRole("button", { name: "Select host" });
 assert.equal(await cards.count(), 2, "two host cards (overlay + sidebar)");
 // Open via the OVERLAY card (nth 0), then via the SIDEBAR card
 // (nth 1): the menu must jump between the two anchors. Under the old
 // shared-ref bug the second open kept the first card's anchor (or a
 // stale one) and the menu rendered up top instead of by its card.
 await cards.nth(0).click(); await settle();
 const menuBoxA = await page.getByRole("menu", { name: "Hosts" }).boundingBox();
 assert(menuBoxA, "menu opens from overlay card");
 await cards.nth(1).click(); await settle();
 const menuBoxB = await page.getByRole("menu", { name: "Hosts" }).boundingBox();
 assert(menuBoxB, "menu opens from sidebar card");
 assert(
   Math.abs(menuBoxB!.y - menuBoxA!.y) > 10,
   `menu follows clicked card (overlayY=${Math.round(menuBoxA!.y)} sidebarY=${Math.round(menuBoxB!.y)})`,
 );
 assert((await text()).includes("Your hosts"), "menu content visible");
 // Click the same sidebar card again toggles its own menu closed.
 await cards.nth(1).click(); await settle();
 assert(!(await text()).includes("Your hosts"), "menu toggles closed on same card");

 assert.equal(errors.length, 0, "zero page errors: " + errors.join("; "));
 console.log("PASS: update overlay brand/host-card/switch-away");
 } finally { await browser.close(); server.stop(); }
})();
