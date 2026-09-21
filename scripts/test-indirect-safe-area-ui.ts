#!/usr/bin/env bun
// Installed-mobile layout regression checks with real components and built CSS.
// The native safe-area values and display mode are simulated in Chromium.
// Run bun run build:web first; Playwright remains an external installation.
import assert from "node:assert/strict";
import path from "node:path";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const root = path.resolve(import.meta.dir, "..");
const names = { sidebar: "indirect-wco-ui", composer: "indirect-collapse-ui" };
const bundles = new Map<string, Blob>();
for (const [route, name] of Object.entries(names)) {
  const result = await Bun.build({ entrypoints: [path.join(root, `test/fixtures/${name}.tsx`)], target: "browser", plugins: [iconifyPlugin, solidPlugin] });
  assert(result.success, result.logs.join("\n"));
  bundles.set(`/${route}.js`, result.outputs[0]);
}
const dist = path.join(root, "dist");
const cssName = Array.from(new Bun.Glob("*.css").scanSync(dist))[0];
assert(cssName, "Run bun run build:web first");
const css = (await Bun.file(path.join(dist, cssName)).text()).replace(
  /env\(safe-area-inset-(top|right|bottom|left),\s*([^)]*)\)/g, "var(--test-safe-$1, $2)",
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const pathname = new URL(req.url).pathname;
  if (bundles.has(pathname)) return new Response(bundles.get(pathname));
  if (pathname === "/style.css" || pathname === `/${cssName}`) return new Response(css, { headers: { "Content-Type": "text/css" } });
  if (pathname === "/sidebar" || pathname === "/composer") return new Response(
    `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="${pathname}.js"></script></body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
  const file = Bun.file(path.join(dist, pathname === "/" ? "index.html" : pathname.slice(1)));
  return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
} });
const cases = [
  { name: "iPhone portrait", width: 393, height: 852, top: 59, right: 0, bottom: 34, left: 0 },
  { name: "iPhone landscape", width: 852, height: 393, top: 0, right: 59, bottom: 21, left: 59 },
  { name: "opposite landscape", width: 852, height: 393, top: 0, right: 59, bottom: 21, left: 0 },
  { name: "Android gestures", width: 412, height: 915, top: 24, right: 0, bottom: 24, left: 0 },
  { name: "system already inset", width: 393, height: 759, top: 0, right: 0, bottom: 0, left: 0 },
];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ hasTouch: true });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const mode = async (scenario: typeof cases[number], installed: boolean) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.evaluate(({ scenario, installed }: { scenario: typeof cases[number]; installed: boolean }) => {
      const state = window as any;
      if (!state.safeAreaRules) {
        state.safeAreaRules = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSMediaRule && rule.conditionText.includes("display-mode: standalone")) state.safeAreaRules.push(rule);
            else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
      }
      if (!state.safeAreaRules.length) throw new Error("Missing standalone safe-area CSS");
      for (const rule of state.safeAreaRules) rule.media.mediaText = installed ? "(min-width: 0px)" : "(min-width: 99999px)";
      for (const edge of ["top", "right", "bottom", "left"] as const) document.documentElement.style.setProperty(`--test-safe-${edge}`, `${scenario[edge]}px`);
      state.wcoUI?.setMobile(scenario.width < 768);
    }, { scenario, installed });
    await page.waitForTimeout(250);
  };
  const bounds = async (selector: string) => {
    const box = await page.locator(selector).boundingBox();
    assert(box, `${selector} is visible`);
    return box;
  };
  const inside = async (selector: string, scenario: typeof cases[number], installed: boolean) => {
    const box = await bounds(selector);
    assert(box.x >= (installed ? scenario.left : 0) - 1 && box.y >= (installed ? scenario.top : 0) - 1
      && box.x + box.width <= scenario.width - (installed ? scenario.right : 0) + 1
      && box.y + box.height <= scenario.height - (installed ? scenario.bottom : 0) + 1,
    `${scenario.name}: ${selector} must stay in the visible safe rectangle (${JSON.stringify(box)})`);
  };
  await page.goto(`${server.url}sidebar`);
  for (const scenario of cases) for (const installed of [false, true]) {
    await mode(scenario, installed);
    for (const open of [false, true]) {
      await page.evaluate((open: boolean) => (window as any).wcoUI.setSidebarOpen(open), open);
      await page.waitForTimeout(250);
      await inside(".rc-sidebar-toggle", scenario, installed);
      const header = await bounds(open ? ".rc-sidebar-header" : ".rc-window-header");
      assert.equal(header.y, installed ? scenario.top : 0, "header follows native inset, without changing browser layout");
      if (open) await inside('.rc-sidebar button:has-text("Settings")', scenario, installed);
      await inside("#composer", scenario, installed);
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), "workspace never scrolls outside its viewport");
    console.log(`PASS sidebar: ${scenario.name}, ${installed ? "installed" : "browser"}`);
  }
  await mode(cases[0], true);
  await page.screenshot({ path: "/tmp/pwa-safe-sidebar.png" });

  await page.goto(`${server.url}composer?layout`);
  for (const scenario of cases) {
    await mode(scenario, true);
    for (const collapsed of [true, false]) {
      await page.evaluate((collapsed: boolean) => (window as any).collapseUI.setCollapsed(collapsed), collapsed);
      await page.locator("[data-composer-shell]").evaluate((el: HTMLElement) => { el.scrollTop = 0; });
      await inside("[data-turn-status]", scenario, true);
      await inside('button:has-text("Pin at bottom")', scenario, true);
      await inside("[data-composer-shell]", scenario, true);
      if (!collapsed) {
        await page.locator("[data-composer-footer]").scrollIntoViewIfNeeded();
        await inside("[data-composer-footer]", scenario, true);
      }
    }
    await page.evaluate(() => (window as any).collapseUI.setModalOpen(true));
    await page.waitForTimeout(350);
    await inside('[role="dialog"]', scenario, true);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    console.log(`PASS composer and dialog: ${scenario.name}, Working, pin, expanded/collapsed`);
  }
  await mode(cases[0], true);
  await page.evaluate(() => (window as any).collapseUI.setCollapsed(true));
  await page.screenshot({ path: "/tmp/pwa-safe-working.png" });

  await page.addInitScript(() => localStorage.setItem("llm_gateway_session", JSON.stringify({ accessToken: "fixture", refreshToken: "fixture", user: { id: "fixture", name: "Layout tester", email: "layout@example.test", role: "user", hasPassword: true, googleLinked: false, totpEnabled: false, status: "active", createdAt: 0 } })));
  await page.route("**/api/**", (route: any) => route.fulfill({ json: { success: true, keys: [], sessions: [], googleClientId: null } }));
  await page.goto(`${server.url}#/settings`);
  await page.waitForSelector(".gw-shell");
  for (const scenario of cases.slice(0, 3)) for (const installed of [false, true]) {
    await mode(scenario, installed);
    for (const scroll of [0, 350]) {
      await page.evaluate((scroll: number) => window.scrollTo(0, scroll), scroll);
      await page.waitForTimeout(60);
      await inside(".gw-header:visible", scenario, installed);
      assert.equal((await bounds(".gw-header:visible")).y, installed ? scenario.top : 0, "dashboard header remains below system status bar on scroll");
    }
    console.log(`PASS dashboard: ${scenario.name}, ${installed ? "installed" : "browser"}, scrolling`);
  }
  assert.deepEqual(errors, [], "zero browser errors");
  console.log("Mobile safe areas: all green (native insets simulated)");
} finally {
  await browser.close();
  server.stop(true);
}
