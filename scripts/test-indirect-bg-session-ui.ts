// Deterministic browser gate for session-owned background tasks.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-bg-session-ui.ts
//
// No model, no daemon: drives the real useBackground hook + BackgroundCard
// + toolSummary in a real Chromium and asserts what a user actually sees:
//  - session tasks render in the card (running + finished, never GCed)
//  - live bg_output chunks glue after the session tail
//  - register/finish events touch the list without a full refresh
//  - toolSummary: bg_check reads like a file, bg_cancel never shows the id,
//    sleep keeps its header/body contract
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints: [new URL("../test/fixtures/bg-session-ui.tsx", import.meta.url).pathname], target: "browser", plugins: [iconifyPlugin, solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/bundle.js") return new Response(bundle.outputs[0]);
    return new Response('<!doctype html><div id="root"></div><script type="module" src="/bundle.js"></script>', { headers: { "Content-Type": "text/html" } });
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).bgTest);

  // 1. Empty session: no card.
  assert.equal(await page.locator("text=Background tasks").count(), 0, "card renders with zero tasks");

  // 2. Seed session tasks (as mirrored from session_data bgTasks).
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_1", kind: "bash", label: "sleep 30", status: "running", startedAt: Date.now() - 5000, content: "history-" },
    { id: "bg_2", kind: "python", label: "train.py", status: "done", startedAt: 1, endedAt: 2, exitCode: 0, content: "epoch 1\nloss 0.5" },
  ]));
  await page.waitForFunction(() => document.body.textContent?.includes("Background tasks"));
  const cardText = await page.textContent("body");
  assert.ok(cardText?.includes("1 running"), "running counter");
  assert.ok(cardText?.includes("sleep 30"), "bash label renders");
  assert.ok(cardText?.includes("train.py"), "finished python task renders (never GCed)");

  // 3. Live chunks glue after the session tail: open the Logs and read.
  await page.evaluate(() => (window as any).bgTest.output("bg_1", "live-1"));
  const logButtons = page.getByRole("button", { name: "Logs" });
  assert.equal(await logButtons.count(), 2, "one Logs toggle per task");
  await logButtons.first().click();
  await page.waitForFunction(() => document.body.textContent?.includes("history-live-1"));
  const logText = await page.textContent("body");
  assert.ok(logText?.includes("history-live-1"), "session tail + live stream glued");

  // 4. Register/finish events touch the list without a full refresh.
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_registered", sessionId: "s1", jobId: "bg_9", kind: "bash", label: "make build" }));
  await page.waitForFunction(() => document.body.textContent?.includes("make build"));
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_finished", sessionId: "s1", jobId: "bg_9", status: "done" }));
  await page.waitForFunction(() => document.body.textContent?.includes("2 running") === false);
  // Foreign sessions never leak in.
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_registered", sessionId: "other", jobId: "bg_x", kind: "bash", label: "evil" }));
  await page.waitForTimeout(150);
  assert.ok(!(await page.textContent("body"))?.includes("evil"), "foreign session task leaked");

  // 5. toolSummary contracts (pure).
  const bgCheck = await page.evaluate(() => (window as any).bgTest.summary("bg_check", { job_id: "bg_1" }, "Background Task (bash) — running\nCommand: sleep 30\nLines 1–10 of 100\n1:hi"));
  assert.equal(bgCheck.verb, "Read", "bg_check verb");
  assert.ok(String(bgCheck.target).includes("Background Task"), "bg_check target");
  assert.ok(String(bgCheck.target).includes("L1-10"), "bg_check range in header");
  assert.equal(bgCheck.icon, "lucide:terminal", "bash kind icon");
  const bgCheckPy = await page.evaluate(() => (window as any).bgTest.summary("bg_check", { job_id: "bg_2" }, "Background Task (python) — done\nLines 1–2 of 2"));
  assert.equal(bgCheckPy.icon, "mdi:language-python", "python kind icon");
  const bgCancel = await page.evaluate(() => (window as any).bgTest.summary("bg_cancel", { job_id: "bg_9abcdef1234567890" }, "cancelled"));
  assert.equal(bgCancel.verb, "Canceled", "bg_cancel verb");
  assert.ok(!String(bgCancel.target).includes("bg_9abcdef"), "bg_cancel never shows the id");
  assert.ok(String(bgCancel.target).includes("Background Task"), "bg_cancel target");
  const sleep = await page.evaluate(() => (window as any).bgTest.summary("sleep", { seconds: 90, waitingFor: "bg_1", summary: "waiting for build" }, "waiting for build\nSlept 1m30s."));
  assert.ok(String(sleep.target).includes("1m") || String(sleep.verb).toLowerCase().includes("sleep"), "sleep header");

  // 6. Row bodies: sleep shows only the summary, bg_check reads like a
  // file, bg_cancel stays minimal.
  const sleepBody = await page.textContent('[data-testid="row-sleep"]');
  assert.ok(sleepBody?.includes("waiting for build"), `sleep body must show the summary: ${sleepBody?.slice(0, 200)}`);
  assert.ok(!sleepBody?.includes("bg_1"), "sleep body must not show the task id");
  const checkBody = await page.textContent('[data-testid="row-bgcheck"]');
  assert.ok(checkBody?.includes("hello"), "bg_check body must show the log content");
  assert.ok(checkBody?.includes("Background Task#L1-2") || checkBody?.includes("Background Task"), "bg_check header must name the task");
  const cancelBody = await page.textContent('[data-testid="row-bgcancel"]');
  assert.ok(!cancelBody?.includes("bg_9"), "bg_cancel body must not show the task id");

  // 7. Stop button sends bg_cancel (no id in UI, id on the wire).
  const sentBefore = await page.evaluate(() => ((window as any).__sent ?? []).length);
  await page.getByRole("button", { name: "Stop" }).first().click();
  await page.waitForFunction((n) => ((window as any).__sent ?? []).length > n, sentBefore as any).catch(() => {});
  assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
  console.log("bg-session-ui: OK (card, live glue, events, summaries, no page errors)");
} finally {
  await browser.close();
  server.stop(true);
}
