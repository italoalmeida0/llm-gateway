// Browser regression test using an existing Playwright installation.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=… bun scripts/test-indirect-collapse-ui.ts
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const bundle = await Bun.build({
  entrypoints: [
    new URL("../test/fixtures/indirect-collapse-ui.tsx", import.meta.url)
      .pathname,
  ],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) =>
    new URL(req.url).pathname === "/bundle.js"
      ? new Response(bundle.outputs[0])
      : new Response(
          '<html><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
          { headers: { "Content-Type": "text/html" } },
        ),
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(String(error)));
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).collapseUI.setCollapsed);
  const settle = () => page.waitForTimeout(60);
  const toggle = page.locator("[data-composer-collapse]");

  // Existing conversation, running turn: the chevron rides the status row.
  assert.equal(await toggle.count(), 1, "chevron must exist in an active conversation");
  assert(await page.locator("#rc-composer").isVisible(), "composer starts expanded");
  await toggle.click();
  await settle();
  assert(!(await page.locator("#rc-composer").isVisible()), "collapsed hides the composer input");
  assert(!(await page.locator("[data-composer-footer]").isVisible()), "collapsed hides the footer");
  assert(await page.locator("[data-turn-status]").isVisible(), "collapsed keeps the turn status row");
  assert.equal(await page.locator("[data-todo-status]").count(), 0, "collapsed hides the task list rows");
  assert.equal(await page.getByText("Task plan", { exact: true }).count(), 0, "collapsed hides the whole Task plan block");
  // Collapsed leaves the status row as the last element: the shell must add a
  // bottom gap so it does not sit flush against the viewport edge. Fixtures
  // load no Tailwind, so assert the class contract, not pixel geometry.
  const shellHasBottomGap = () => page.evaluate(() =>
    !!document.querySelector("[data-composer-shell]")?.className.split(/\s+/).includes("pb-2"));
  assert(await shellHasBottomGap(), "collapsed shell keeps a bottom gap for the status row");
  await toggle.click();
  await settle();
  assert(await page.locator("#rc-composer").isVisible(), "the chevron restores the composer");
  assert(!(await shellHasBottomGap()), "the expanded shell carries no extra bottom gap");
  assert(await page.getByText("Task plan", { exact: true }).isVisible(), "the chevron restores the Task plan block");

  // Idle conversation (no turn row): the toggle still needs a reachable home.
  await page.evaluate(() => {
    (window as any).collapseUI.setTurn(null);
    (window as any).collapseUI.setTodos([]);
  });
  await settle();
  assert.equal(await toggle.count(), 1, "chevron must exist while the turn is idle");
  await toggle.click();
  await settle();
  assert(!(await page.locator("#rc-composer").isVisible()), "an idle conversation can collapse too");
  await toggle.click();
  await settle();

  // New conversation: never collapsible, even with the persisted flag set.
  await page.evaluate(() => (window as any).collapseUI.setCollapsed(true));
  await page.evaluate(() => (window as any).collapseUI.setDraft(true));
  await settle();
  assert.equal(await toggle.count(), 0, "a new conversation must not show the chevron");
  assert(await page.locator("#rc-composer").isVisible(), "a new conversation always shows the composer");
  await page.evaluate(() => (window as any).collapseUI.setDraft(false));
  await settle();
  assert(!(await page.locator("#rc-composer").isVisible()), "the persisted flag applies again outside the draft");

  // A blocked workspace stays on screen so the warning cannot be hidden away.
  await page.evaluate(() => (window as any).collapseUI.setBlocked(true));
  await settle();
  assert.equal(await toggle.count(), 0, "no chevron while the workspace is blocked");
  assert(await page.locator("[data-workspace-unavailable]").isVisible(), "the workspace warning stays visible");
  await page.evaluate(() => (window as any).collapseUI.setBlocked(false));
  await settle();
  assert(!(await page.locator("#rc-composer").isVisible()), "collapse resumes after the warning clears");

  assert.deepEqual(errors, []);
  console.log("PASS: composer minimize toggle (status-row chevron, task list, draft guard)");
} finally {
  await browser.close();
  server.stop(true);
}
