#!/usr/bin/env bun
/**
 * WCO drag-strip check: renders the REAL WcoTitlebar (same component as
 * the page) in real Chromium against a fixture bundle. Asserts the strip
 * is empty (no icon/title/buttons — the sidebar toggle stays in its
 * normal floating spot) and zero page errors (TDZ guard — Solid memos
 * evaluate eagerly).
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=… CHROMIUM_PATH=… bun scripts/test-indirect-wco-ui.ts
 */
import { serve } from "bun";
import path from "path";
import { fileURLToPath } from "url";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE ?? "playwright";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

const bundle = await Bun.build({
  entrypoints: [path.join(ROOT, "../test/fixtures/indirect-wco-ui.tsx")],
  target: "browser",
  minify: false,
  sourcemap: "none",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));

const server = serve({
  port: 0,
  fetch(req) {
    return new URL(req.url).pathname === "/bundle.js"
      ? new Response(bundle.outputs[0])
      : new Response(
          '<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
          { headers: { "content-type": "text/html" } },
        );
  },
});

const { chromium } = await import(PLAYWRIGHT_MODULE);
const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 900, height: 200 } });
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${server.port}/`);
// display:none outside WCO mode — attach, not visibility.
await page.waitForSelector(".rc-wco-bar", { timeout: 15000, state: "attached" });
await page.waitForTimeout(400);

// Drag strip is empty by design — nothing may sit above the sidebar
// buttons; the toggle keeps its normal floating spot in the transcript.
check("wco strip renders", (await page.locator(".rc-wco-bar").count()) === 1);
check("wco no icon", (await page.locator(".rc-wco-icon").count()) === 0);
check("wco no title", (await page.locator(".rc-wco-title").count()) === 0);
check("wco no buttons", (await page.locator(".rc-wco-btn").count()) === 0);

check("zero page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
server.stop();
if (failures > 0) process.exit(1);
console.log("WCO titlebar UI: all green");
