#!/usr/bin/env bun
// Real Chromium layout regression checks with production CSS and the real
// workspace shell/sidebar plus the built dashboard. Playwright stays external.
// Run bun run build:web first, then PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-wco-ui.ts.
import assert from "node:assert/strict";
import path from "node:path";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const root = path.resolve(import.meta.dir, "..");
const bundle = await Bun.build({
  entrypoints: [path.join(root, "test/fixtures/indirect-wco-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
assert(bundle.success, bundle.logs.join("\n"));
const dist = path.join(root, "dist");
const cssName = Array.from(new Bun.Glob("*.css").scanSync(dist))[0];
assert(cssName, "Run bun run build:web first");
// Headless tabs have no native titlebar. Substitute only the environment
// inputs; all layout rules come unchanged from the production stylesheet.
const css = (await Bun.file(path.join(dist, cssName)).text()).replace(
  /env\(titlebar-area-(x|y|width|height),\s*([^)]*)\)/g,
  "var(--test-titlebar-$1, $2)",
);
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/bundle.js") return new Response(bundle.outputs[0]);
    if (pathname === "/style.css" || pathname === `/${cssName}`) {
      return new Response(css, { headers: { "Content-Type": "text/css" } });
    }
    if (pathname === "/fixture") return new Response(
      '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
    const file = Bun.file(path.join(dist, pathname === "/" ? "index.html" : pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  // Change the WCO media condition in CSSOM to simulate live native toggles.
  // This does not claim to test OS window dragging or actual installed chrome.
  const overlay = async (enabled: boolean, height = 33, left = 0) => {
    await page.evaluate(({ enabled, height, left }: { enabled: boolean; height: number; left: number }) => {
      const api = window as any;
      if (!api.wcoRules) {
        api.wcoRules = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSMediaRule && rule.conditionText.includes("window-controls-overlay")) api.wcoRules.push(rule);
            else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules);
      }
      if (!api.wcoRules.length) throw new Error("Missing production WCO rules");
      for (const rule of api.wcoRules) rule.media.mediaText = enabled ? "(min-width: 0px)" : "(min-width: 99999px)";
      const style = document.documentElement.style;
      style.setProperty("--test-titlebar-x", `${left}px`);
      style.setProperty("--test-titlebar-y", "0px");
      style.setProperty("--test-titlebar-height", `${height}px`);
      style.setProperty("--test-titlebar-width", `${innerWidth - (left || 260)}px`);
    }, { enabled, height, left });
    await page.waitForTimeout(250);
  };
  const box = async (selector: string) => {
    const bounds = await page.locator(selector).boundingBox();
    assert(bounds, `${selector} is visible`);
    return bounds;
  };
  const closeTo = (actual: number, expected: number, label: string, tolerance = 1) =>
    assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

  await page.goto(`${server.url}fixture`);
  await page.waitForFunction(() => (window as any).wcoUI?.setSidebarOpen);
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate((mobile: boolean) => (window as any).wcoUI.setMobile(mobile), width < 768);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme; }, theme);
      for (const enabled of [false, true, false]) {
        await overlay(enabled);
        const top = enabled ? 33 : 0;
        for (const open of [true, false]) {
          await page.evaluate((open: boolean) => (window as any).wcoUI.setSidebarOpen(open), open);
          await page.waitForTimeout(250);
          const main = await box(".rc-wco-main");
          const sidebar = open ? await box(".rc-sidebar") : null;
          closeTo(main.y, top, "conversation starts below chrome");
          closeTo(main.x + main.width, width, "conversation fills remaining width");
          closeTo(main.y + main.height, 800, "conversation reaches viewport bottom");
          if (sidebar) {
            closeTo(sidebar.y, top, "sidebar and conversation start together");
            closeTo(sidebar.y + sidebar.height, 800, "sidebar reaches bottom");
            if (width >= 768) closeTo(main.x, sidebar.x + sidebar.width, "no sidebar gap");
          }
          const composer = await box("#composer");
          const messages = await box("#messages");
          closeTo(composer.x + composer.width / 2, main.x + main.width / 2, "composer is centered");
          closeTo(messages.x + messages.width / 2, composer.x + composer.width / 2, "transcript and composer align", 6);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
          await page.locator("#conversation").evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; });
          closeTo((await box(".rc-wco-main")).y, top, "transcript scroll preserves top inset");
          if (!open) {
            await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
            await page.waitForTimeout(250);
            assert((await box(".rc-sidebar")).width > 0, "sidebar toggle stays clickable");
          }
        }
      }
    }
    console.log(`PASS workspace: ${width}px, both themes, overlay on/off, sidebar open/closed, scrolling`);
  }
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.evaluate(() => { (window as any).wcoUI.setMobile(false); (window as any).wcoUI.setSidebarOpen(true); });
  for (const [height, left] of [[33, 0], [40, 120]]) {
    await overlay(true, height, left);
    closeTo((await box(".rc-sidebar")).y, height, "native titlebar height is respected");
    const drag = await page.locator(".rc-wco-bar").evaluate((el: HTMLElement) => {
      const style = getComputedStyle(el, "::before");
      return { left: parseFloat(style.left), width: parseFloat(style.width), height: parseFloat(style.height) };
    });
    closeTo(drag.left, left, "drag rectangle avoids left controls");
    closeTo(drag.width, 1440 - (left || 260), "drag rectangle avoids native controls");
    closeTo(drag.height, height, "drag rectangle follows native height");
  }
  await page.screenshot({ path: "/tmp/wco-workspace-fixed.png" });

  // Use the built dashboard shell with fixture-only API responses.
  await page.addInitScript(() => {
    localStorage.setItem("llm_gateway_session", JSON.stringify({
      accessToken: "fixture", refreshToken: "fixture", user: {
        id: "fixture", name: "Layout tester", email: "layout@example.test", role: "user",
        hasPassword: true, googleLinked: false, totpEnabled: false, status: "active", createdAt: 0,
      },
    }));
  });
  await page.route("**/api/**", (route: any) => route.fulfill({
    json: { success: true, keys: [], sessions: [], googleClientId: null },
  }));
  await page.goto(`${server.url}#/settings`);
  await page.waitForSelector(".gw-shell");
  // Give the real shell deterministic scroll depth regardless of page content.
  await page.locator(".gw-shell > main").evaluate((el: HTMLElement) => { el.style.minHeight = "2400px"; });
  for (const width of [1440, 900, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme; }, theme);
      for (const enabled of [false, true, false]) {
        await overlay(enabled);
        for (const scroll of [0, 500, 1500]) {
          await page.evaluate((scroll: number) => window.scrollTo(0, scroll), scroll);
          await page.waitForTimeout(60);
          const header = await box(".gw-header:visible");
          closeTo(header.y, enabled ? 33 : 0, "dashboard header clears controls while scrolling");
          if (width >= 768) closeTo((await box(".gateway-rail")).y, header.y, "rail clears controls");
          if (enabled) {
            const bar = await box(".gw-wco-bar");
            closeTo(bar.y, 0, "dashboard titlebar remains at viewport top");
            closeTo(bar.width, width, "titlebar covers full viewport");
            assert(await page.locator(".gw-wco-bar").evaluate((el: HTMLElement) => {
              const style = getComputedStyle(el);
              return style.backgroundColor === getComputedStyle(document.body).backgroundColor
                && document.elementFromPoint(innerWidth - 20, 12) === el;
            }), "titlebar is opaque and covers scrolled content beneath native controls");
          }
        }
      }
    }
    console.log(`PASS dashboard: ${width}px, both themes, overlay on/off, top and scrolled header`);
  }
  await overlay(true);
  await page.screenshot({ path: "/tmp/wco-dashboard-fixed.png" });
  assert.deepEqual(errors, [], "zero browser errors");
  console.log("WCO layout: all green (native geometry simulated in headless Chromium)");
} finally {
  await browser.close();
  server.stop(true);
}
