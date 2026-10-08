// Real Chromium layout check for every tool body + background card; Playwright stays external.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-tool-bodies-audit-ui.ts
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints: ["test/fixtures/tool-bodies-audit-ui.tsx"], target: "browser", plugins: [iconifyPlugin, solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const cssName = Array.from(new Bun.Glob("*.css").scanSync("dist"))[0];
assert(cssName, "Run bun run build:web first");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/bundle.js") return new Response(bundle.outputs[0]);
  if (path === "/app.css") return new Response(Bun.file(`dist/${cssName}`));
  return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
}});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const errors: string[] = [];
try {
  for (const width of [320, 390, 1280]) {
    const touch = width <= 768;
    const page = await browser.newPage({ viewport: { width, height: 1200 }, hasTouch: touch, isMobile: width < 600 });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${server.url}?audit`);
    await page.waitForFunction(() => (window as any).auditReady);
    await page.evaluate(() => {
      document.documentElement.classList.toggle("mobile", navigator.maxTouchPoints > 0);
      // Open every tool body and every background log.
      for (const btn of document.querySelectorAll<HTMLElement>("[data-audit-row] button")) btn.click();
    });
    // Expand every tool body (header row is the disclosure trigger).
    await page.evaluate(() => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-audit-row]')) {
        row.querySelector<HTMLElement>("div[class*='group/tool']")?.click();
      }
    });
    await page.waitForTimeout(250);
    // Structural invariants: no XML leaks, no raw metadata lines, no auto-wrap on output.
    const report = await page.evaluate(() => {
      const pres = [...document.querySelectorAll("pre")].map((el) => ({
        wrap: getComputedStyle(el).whiteSpace,
        text: (el.textContent || "").slice(0, 60),
        numbered: !!el.closest("[data-code-gutter]"),
      }));
      const scrollContainers = (row: Element) =>
        [...row.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)).length;
      const nestedScroll = [...document.querySelectorAll("[data-audit-row]")].filter((row) => scrollContainers(row) > 1).length;
      return {
        body: document.body.textContent || "",
        pres,
        numbered: document.querySelectorAll("[data-code-gutter]").length,
        footerChips: document.querySelectorAll("[data-tool-footer] span").length,
        nestedScroll,
        overflow: document.documentElement.scrollWidth <= innerWidth + 1,
      };
    });
    console.log("  report", JSON.stringify({ chips: report.footerChips, body: report.body.slice(0, 120) }));
    assert.ok(!/<tool_result|&lt;tool_result/.test(report.body), `width ${width}: no tool_result XML leaks`);
    // Legacy footer lines are stripped from the body and rendered as chips.
    assert.ok(report.pres.every((p) => !/^\[exit \d+\]/m.test(p.text)), `width ${width}: footer line is not inside output blocks`);
    assert.ok(/exit 0/.test(report.body), `width ${width}: footer chips render the exit code`);
    assert.ok(/done \[done\]/.test(report.body), `width ${width}: a real bracketed output line is kept`);
    // Gutter only where the daemon numbers lines (read/write/bg_check): a
    // bash output with literal "N:" prefixes must render as plain text.
    // The bash "1:epoch …" output keeps its literal prefixes (no gutter).
    assert.ok(report.pres.some((p) => p.text.startsWith("1:epoch") && !p.numbered), `width ${width}: literal "N:" output has no gutter`);
    assert.ok(report.numbered >= 3, `width ${width}: read/write/bg_check keep their line gutter`);
    // Envelope metadata must never sit inside an output block.
    assert.ok(report.pres.every((p) => !/\bpage \d+[–-]\d+( of \d+|\/\d+)?\b|\bnext \d+\b|more lines: offset/.test(p.text)), `width ${width}: footer is not inside output blocks`);
    assert.ok(/page 1-5\/12/.test(report.body), `width ${width}: bg_check footer is rendered as its own chips`);
    assert.ok(report.footerChips > 0, `width ${width}: footer chips rendered`);
    assert.ok(report.pres.every((p) => p.wrap === "pre"), `width ${width}: output blocks do not auto-wrap`);
    assert.ok(report.overflow, `width ${width}: no horizontal page overflow`);
    assert.equal(report.nestedScroll, 0, `width ${width}: no nested scroll containers (single scroll surface)`);
    await page.screenshot({ path: `dist/tool-bodies-${width}.png`, fullPage: true });
    await page.close();
    console.log(`PASS ${width}px: tool bodies, footers, wrap and overflow`);
  }
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await browser.close(); server.stop();
}
console.log("PASS: tool body audit");
