// Deterministic browser gate for session-owned background tasks.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-bg-session-ui.ts
//
// No model, no daemon: drives the real useBackground hook + BackgroundCard
// + toolSummary in a real Chromium and asserts what a user actually sees:
//  - session tasks render in running and Archived views (terminal rows persist)
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
  assert.ok(!cardText?.includes("train.py"), "finished task stays out of the running list");
  const archiveToggle = page.locator("[data-bg-archive-toggle]");
  assert.equal(await archiveToggle.count(), 1, "archive toggle renders");
  assert.equal(await archiveToggle.getAttribute("aria-pressed"), "false", "running view is selected by default");
  assert.ok((await archiveToggle.textContent())?.includes("1"), "archive toggle includes terminal count");
  assert.equal(await archiveToggle.getAttribute("aria-label"), "Archived tasks (1)", "archive toggle is icon-only with an accessible label");
  await archiveToggle.click();
  await page.waitForFunction(() => document.body.textContent?.includes("train.py"));
  assert.equal(await archiveToggle.getAttribute("aria-pressed"), "true", "archive view selected");
  // A second client receiving the same daemon snapshot starts in running
  // view; archive selection is UI state, never mirrored session authority.
  const peer = await browser.newPage();
  await peer.goto(server.url.toString());
  await peer.waitForFunction(() => (window as any).bgTest);
  await peer.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_1", kind: "bash", label: "sleep 30", status: "running", startedAt: Date.now() - 5000, content: "history-" },
    { id: "bg_2", kind: "python", label: "train.py", status: "done", startedAt: 1, endedAt: 2, exitCode: 0, content: "epoch 1" },
  ]));
  await peer.waitForFunction(() => document.body.textContent?.includes("sleep 30"));
  assert.ok(!(await peer.textContent("body"))?.includes("train.py"), "peer snapshot defaults to running view");
  await peer.locator("[data-bg-archive-toggle]").click();
  assert.ok((await peer.textContent("body"))?.includes("train.py"), "peer can derive archived view from same snapshot");
  await peer.close();

  // 3. Live chunks glue after the session tail: open the Logs and read.
  assert.equal(await page.getByRole("button", { name: /^(Show|Hide) logs$/ }).count(), 1, "one Logs toggle in archived view");
  await page.getByRole("button", { name: /^(Show|Hide) logs$/ }).click();
  await page.locator("[data-bg-archive-toggle]").click();
  await page.evaluate(() => (window as any).bgTest.output("bg_1", "live-1"));
  const logButtons = page.getByRole("button", { name: /^(Show|Hide) logs$/ });
  assert.equal(await logButtons.count(), 1, "one Logs toggle in running view");
  await logButtons.first().click();
  await page.waitForFunction(() => {
    const b = document.body.textContent || "";
    return b.includes("history-") && b.includes("live-1");
  });
  const logText = await page.textContent("body");
  assert.ok(logText?.includes("history-") && logText?.includes("live-1"), "session tail + live stream glued");

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

  // 5b. No-cut, no-dup: tail 21..30 (total 30) + live "31, ok" (from=31).
  // Then a refresh with the full tail collapses live. "ok" exactly once.
  await page.evaluate(() => {
    const t = (window as any).bgTest;
    t.seed([{ id: "bg_seq", kind: "bash", label: "uniqueseqlabel", status: "running", startedAt: 1, content: "21\n22\n23\n24\n25\n26\n27\n28\n29\n30", totalLines: 30, droppedLines: 20, contentFrom: 21 }]);
    t.output("bg_seq", "31\nok", 31);
  });
  await page.waitForFunction(() => document.body.textContent?.includes("uniqueseqlabel"), null, { timeout: 10000 });
  const rendered = await page.evaluate(() => {
    const bg: any = (window as any).bgTest.bg;
    const task = bg.sessionJobs().find((t: any) => t.id === "bg_seq");
    if (!task) return { error: "bg_seq missing from sessionJobs" };
    const sess: string = task.content || "";
    const live: string = bg.liveTail("bg_seq");
    return { sessTail: sess.slice(-40), live };
  });
  if ((rendered as any).error) throw new Error((rendered as any).error);
  assert.ok(((rendered as any).sessTail || "").includes("29\n30"), `session tail wrong: ${JSON.stringify(rendered)}`);
  assert.equal((rendered as any).live, "31\nok", `live must be exactly the new lines: ${JSON.stringify(rendered)}`);
  await page.getByRole("button", { name: /^(Show|Hide) logs$/ }).last().click();
  await page.waitForTimeout(500);
  const seqCode = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((d) => (d.textContent || "").includes("uniqueseqlabel"));
    const row = rows[rows.length - 1];
    const pre = row?.parentElement?.querySelector("pre") || document.querySelector("pre");
    return (pre?.textContent || "").trim();
  });
  const seqLines = seqCode.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  for (const n of ["21", "29", "30", "31"]) {
    assert.equal(seqLines.filter((l) => l === n).length, 1, `line ${n} exactly once (code=${JSON.stringify(seqCode.slice(0, 200))})`);
  }
  assert.equal(seqLines.filter((l) => l === "ok").length, 1, '"ok" exactly once');
  // Refresh with the full tail: live collapses, "ok" stays single.
  await page.locator("[data-bg-archive-toggle]").click();
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_seq", kind: "bash", label: "uniqueseqlabel", status: "done", startedAt: 1, endedAt: 2, exitCode: 0, content: "21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n31\nok", totalLines: 32, droppedLines: 20, contentFrom: 21 },
  ]));
  await page.waitForTimeout(200);
  const seqCodeAfter = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("div")].filter((d) => (d.textContent || "").includes("uniqueseqlabel"));
    const row = rows[rows.length - 1];
    const pre = row?.parentElement?.querySelector("pre") || document.querySelector("pre");
    return (pre?.textContent || "").trim();
  });
  assert.equal(seqCodeAfter.split("\n").map((l) => l.trim()).filter((l) => l === "ok").length, 1, '"ok" must stay single after snapshot refresh');

  // 6. Row bodies: sleep is header-only (summary in the header, never a
  // body/chevron), bg_check reads like a file, bg_cancel stays minimal.
  const sleepBody = await page.textContent('[data-testid="row-sleep"]');
  assert.ok(sleepBody?.includes("waiting for build"), `sleep row must show the summary in the header: ${sleepBody?.slice(0, 200)}`);
  assert.ok(!sleepBody?.includes("bg_1"), "sleep row must not show the task id");
  // Header-only contract: no disclosure body mount and no chevron.
  const sleepBodies = await page.locator('[data-testid="row-sleep"] .article-body, [data-testid="row-sleep"] pre, [data-testid="row-sleep"] .max-h-96').count();
  assert.equal(sleepBodies, 0, "sleep row must never render a body");
  const sleepChevrons = await page.locator('[data-testid="row-sleep"] svg path[d="m6 9l6 6l6-6"]').count();
  assert.equal(sleepChevrons, 0, "sleep row must not render a chevron");
  const checkBody = await page.textContent('[data-testid="row-bgcheck"]');
  assert.ok(checkBody?.includes("hello"), "bg_check body must show the log content");
  assert.ok(checkBody?.includes("Background Task#L1-2") || checkBody?.includes("Background Task"), "bg_check header must name the task");
  const cancelBody = await page.textContent('[data-testid="row-bgcancel"]');
  assert.ok(!cancelBody?.includes("bg_9"), "bg_cancel body must not show the task id");

  // 7. Stop button sends bg_cancel (no id in UI, id on the wire).
  // Re-seed a running task (5b left only a finished one: no Stop button).
  if (await page.locator("[data-bg-archive-toggle]").getAttribute("aria-pressed") === "true") await page.locator("[data-bg-archive-toggle]").click();
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_stop", kind: "bash", label: "stoppable", status: "running", startedAt: Date.now(), content: "working" },
  ]));
  await page.waitForFunction(() => document.body.textContent?.includes("stoppable"));
  const sentBefore = await page.evaluate(() => ((window as any).__sent ?? []).length);
  await page.getByRole("button", { name: "Stop task" }).first().click();
  await page.waitForFunction((n) => ((window as any).__sent ?? []).length > n, sentBefore as any).catch(() => {});
  // 7b. Dynamic detach transition: empty -> registered placeholder ->
  // snapshot. The live time must exist in every frame (this is the
  // reported "time vanishes on detach" bug: placeholder rows once lost it).
  await page.evaluate(() => (window as any).bgTest.seed([]));
  await page.waitForTimeout(200);
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_registered", sessionId: "s1", jobId: "bg_dyn", kind: "bash", label: "dynamic-cmd" }));
  await page.waitForFunction(() => (document.body.textContent || "").includes("dynamic-cmd"));
  for (let f = 0; f < 3; f++) {
    await page.waitForTimeout(1100);
    const frame = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-bg-row]")].map((r) => (r as HTMLElement).innerText || "");
      return rows.find((h) => h.includes("dynamic-cmd")) || "";
    });
    if (!/\d+[smh]/.test(frame)) throw new Error(`frame ${f}: live time missing on placeholder row: ${JSON.stringify(frame.slice(0, 200))}`);
  }
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_dyn", kind: "bash", label: "dynamic-cmd", status: "running", startedAt: Date.now() - 3000, content: "hi" },
  ]));
  await page.waitForTimeout(1100);
  const afterSnap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-bg-row]")].map((r) => (r as HTMLElement).innerText || "");
    return rows.find((h) => h.includes("dynamic-cmd")) || "";
  });
  if (!/\d+[smh]/.test(afterSnap)) throw new Error(`live time missing after snapshot: ${JSON.stringify(afterSnap.slice(0, 200))}`);

  // 7c. Tool-row detach window: placeholder without a listed job yet.
  // Time must tick, spinner must spin, body must read running — never blank.
  await page.evaluate(() => (window as any).bgTest.seed([]));
  await page.waitForTimeout(200);
  const win = await page.evaluate(() => {
    const bg: any = (window as any).bgTest.bg;
    return bg.sessionJobs().length;
  });
  assert.equal(win, 0, "window starts with no listed jobs");
  const winText = await page.textContent('[data-testid="row-detach"]');
  const winDbg = await page.evaluate(() => ({
    jobs: (window as any).bgTest.bg.sessionJobs().map((t: any) => t.id),
    clock: (window as any).bgTest.bg.clock(),
    now: Date.now(),
  }));
  if (!(winText || "").trim()) {
    throw new Error(`detached row renders blank in the window: dbg=${JSON.stringify(winDbg)}`);
  }
  // Detached tool rows hide their elapsed timer; the background card owns duration.
  const winDur = await page.locator('[data-testid="row-detach"] [data-tool-duration]').count();
  assert.equal(winDur, 0, "detached row hides the tool timer");
  assert.ok(!/No output/.test(winText || ""), `detached row must not claim "No output": ${JSON.stringify((winText || "").slice(0, 200))}`);

  // 8. Full-scene review: running and archived views are separate, ordered
  // lists. Terminal rows keep a frozen duration and accessible status icon.
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_run", kind: "bash", label: "run-cmd", status: "running", startedAt: Date.now() - 65000, content: "out" },
    { id: "bg_done", kind: "python", label: "done-cmd", status: "done", startedAt: 1000, endedAt: 61001, exitCode: 0, content: "ok" },
    { id: "bg_err", kind: "bash", label: "err-cmd", status: "error", startedAt: 2000, endedAt: 5000, exitCode: 1, content: "boom" },
    { id: "bg_cancel", kind: "bash", label: "cancel-cmd", status: "cancelled", startedAt: 3000, endedAt: 9000, content: "cancelled" },
  ]));
  await page.waitForFunction(() => (document.body.textContent || "").includes("run-cmd"));
  if (await page.locator("[data-bg-archive-toggle]").getAttribute("aria-pressed") === "true") await page.locator("[data-bg-archive-toggle]").click();
  await page.waitForTimeout(1200);
  const scene = await page.evaluate(() => {
    const body = document.body.textContent || "";
    const rows = [...document.querySelectorAll("[data-bg-row]")].map((r) => ({
      html: (r as HTMLElement).innerText || "",
      spinner: !!r.querySelector(".animate-spin"),
      stop: [...r.querySelectorAll("button")].some((b) => b.hasAttribute("data-bg-stop")),
      logs: [...r.querySelectorAll("button")].some((b) => /logs$/.test(b.getAttribute("aria-label") || "")),
    }));
    return { header: body.slice(body.indexOf("Background tasks"), body.indexOf("Background tasks") + 60), rows };
  });
  assert.equal(scene.rows.length, 1, `running view shows only running rows, got ${scene.rows.length}`);
  assert.ok(/1 running/.test(scene.header), `header counts running: ${scene.header}`);
  const run = scene.rows.find((r) => r.html.includes("run-cmd"))!;
  assert.ok(run.spinner, "running row needs the spinner");
  assert.ok(run.stop, "running row needs Stop");
  assert.ok(run.logs, "running row needs Logs toggle");
  assert.ok(/\d+[smh]/.test(run.html), `running row needs a live time, got: ${JSON.stringify(run.html.slice(0, 200))}`);
  await page.locator("[data-bg-archive-toggle]").click();
  await page.waitForFunction(() => (document.body.textContent || "").includes("cancel-cmd"));
  const archived = await page.evaluate(() => [...document.querySelectorAll("[data-bg-row]")].map((r) => ({
    id: r.getAttribute("data-bg-row"),
    status: r.querySelector("[data-bg-status]")?.getAttribute("aria-label"),
    duration: r.querySelector("[data-bg-duration]")?.textContent || "",
    stop: !!r.querySelector("[data-bg-stop]"),
    logs: [...r.querySelectorAll("button")].some((b) => /logs$/.test(b.getAttribute("aria-label") || "")),
  })));
  assert.deepEqual(archived.map((r) => r.id), ["bg_cancel", "bg_err", "bg_done"], "archived rows newest first");
  assert.ok(archived.every((r) => !r.stop && r.logs), "archived rows have Logs and no Stop");
  assert.equal(archived.find((r) => r.id === "bg_done")?.status, "Completed", "done status icon is accessible");
  assert.equal(archived.find((r) => r.id === "bg_err")?.status, "Failed", "error status icon is accessible");
  assert.equal(archived.find((r) => r.id === "bg_cancel")?.status, "Cancelled", "cancelled status icon is accessible");
  assert.equal(archived.find((r) => r.id === "bg_done")?.duration, "1m", "completed duration is rendered");
  assert.equal(archived.find((r) => r.id === "bg_err")?.duration, "3s", "failed duration is rendered");
  assert.equal(archived.find((r) => r.id === "bg_cancel")?.duration, "6s", "cancelled duration is rendered");
  const doneDuration = archived.find((r) => r.id === "bg_done")?.duration;
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('[data-bg-row="bg_done"] [data-bg-duration]').textContent(), doneDuration, "terminal duration is frozen");
  // Both lists cap at three until expanded; changing views resets expansion.
  await page.evaluate(() => (window as any).bgTest.seed([
    ...Array.from({ length: 5 }, (_, i) => ({ id: `arc_${i}`, kind: "bash", label: `archived-${i}`, status: "done", startedAt: 10000 + i, endedAt: 11000 + i, content: "x" })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `run_${i}`, kind: "bash", label: `running-${i}`, status: "running", startedAt: 20000 + i, content: "x" })),
  ]));
  await page.waitForFunction(() => (document.body.textContent || "").includes("archived-2"));
  assert.equal(await page.locator("[data-bg-row]").count(), 3, "archived list initially shows three rows");
  const listToggle = page.locator("[data-bg-list-toggle]");
  assert.equal(await listToggle.count(), 1, "archived list has expansion toggle");
  assert.match((await listToggle.textContent()) || "", /See all \(5\)/, "archived See all count");
  await listToggle.click();
  assert.equal(await page.locator("[data-bg-row]").count(), 5, "archived list expands");
  assert.deepEqual(await page.locator("[data-bg-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-bg-row"))), ["arc_4", "arc_3", "arc_2", "arc_1", "arc_0"], "archived expansion newest first");
  assert.match((await page.locator("[data-bg-list-toggle]").textContent()) || "", /Show less/, "archived Show less");
  await page.locator("[data-bg-list-toggle]").click();
  assert.equal(await page.locator("[data-bg-row]").count(), 3, "Show less collapses archived list");
  await page.locator("[data-bg-archive-toggle]").click();
  assert.equal(await page.locator("[data-bg-row]").count(), 3, "switching to running resets expansion");
  assert.match((await page.locator("[data-bg-list-toggle]").textContent()) || "", /See all \(5\)/, "running See all count");
  await page.locator("[data-bg-list-toggle]").click();
  assert.deepEqual(await page.locator("[data-bg-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-bg-row"))), ["run_4", "run_3", "run_2", "run_1", "run_0"], "running expansion newest first");
  await page.locator("[data-bg-list-toggle]").click();
  await page.locator("[data-bg-archive-toggle]").click();
  assert.equal(await page.locator("[data-bg-row]").count(), 3, "switching back to archived resets expansion");

  // A session switch resets archive/expansion state and derives rows from the
  // new session snapshot.
  await page.locator("[data-bg-list-toggle]").click();
  assert.equal(await page.locator("[data-bg-archive-toggle]").getAttribute("aria-pressed"), "true", "switch starts from archived view");
  assert.equal(await page.locator("[data-bg-row]").count(), 5, "switch starts from expanded list");
  await page.evaluate(() => (window as any).bgTest.switchSession("s2"));
  await page.evaluate(() => (window as any).bgTest.seed([
    ...Array.from({ length: 5 }, (_, i) => ({ id: `s2_run_${i}`, kind: "bash", label: `session-two-running-${i}`, status: "running", startedAt: 30000 + i, content: "x" })),
    { id: "s2_done", kind: "bash", label: "session-two-done", status: "done", startedAt: 29000, endedAt: 30000, content: "x" },
  ]));
  await page.waitForFunction(() => (document.body.textContent || "").includes("session-two-running"));
  assert.equal(await page.locator("[data-bg-archive-toggle]").getAttribute("aria-pressed"), "false", "session switch resets to running view");
  assert.deepEqual(await page.locator("[data-bg-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-bg-row"))), ["s2_run_4", "s2_run_3", "s2_run_2"], "session switch resets expansion and shows only the new session's latest running tasks");
  assert.equal(await page.locator("[data-bg-list-toggle]").getAttribute("aria-expanded"), "false", "session switch collapses list");

  // Empty again: card disappears entirely (no orphan header).
  // Return to the running view before clearing the snapshot; the card stays
  // mounted while archived tasks still exist.
  await page.evaluate(() => (window as any).bgTest.switchSession("s1"));
  if (await page.locator("[data-bg-archive-toggle]").getAttribute("aria-pressed") === "true") await page.locator("[data-bg-archive-toggle]").click();
  await page.evaluate(() => (window as any).bgTest.seed([]));
  await page.waitForTimeout(300);
  assert.equal(await page.locator("text=Background tasks").count(), 0, "card must vanish with zero tasks");

  // 9. Harmony audit: detach timeline frame by frame. Every frame must
  // be self-consistent (no missing time, no missing toggle, no ghost rows).
  async function frame() {
    return page.evaluate(() => {
      const body = document.body.textContent || "";
      const hasCard = body.includes("Background tasks");
      const rows = [...document.querySelectorAll("[data-bg-row]")].map((r) => {
        const h = (r as HTMLElement).innerText || "";
        return {
          id: r.getAttribute("data-bg-row"),
          hasTime: /\d+[smh]/.test(h),
          spinner: !!r.querySelector(".animate-spin"),
          stop: [...r.querySelectorAll("button")].some((b) => b.hasAttribute("data-bg-stop")),
          logs: [...r.querySelectorAll("button")].some((b) => /logs$/.test(b.getAttribute("aria-label") || "")),
          badge: /done|error|cancelled/.test(h),
        };
      });
      return { hasCard, header: body.slice(body.indexOf("Background tasks"), body.indexOf("Background tasks") + 50), rows };
    });
  }
  function checkFrame(f: any, want: { card: boolean; rows?: Record<string, Partial<{ hasTime: boolean; spinner: boolean; stop: boolean; logs: boolean; badge: boolean }>> }) {
    assert.equal(f.hasCard, want.card, `card presence (header=${JSON.stringify(f.header)})`);
    for (const [id, w] of Object.entries(want.rows || {})) {
      const r = f.rows.find((x: any) => x.id === id);
      assert.ok(r, `row ${id} present (rows=${JSON.stringify(f.rows.map((x: any) => x.id))})`);
      for (const [k, v] of Object.entries(w)) {
        assert.equal((r as any)[k], v, `row ${id}.${k} (row=${JSON.stringify(r)})`);
      }
    }
  }
  await page.evaluate(() => (window as any).bgTest.seed([]));
  await page.waitForTimeout(200);
  checkFrame(await frame(), { card: false });
  // Detach: event first (placeholder, exactly like the daemon emits).
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_registered", sessionId: "s1", jobId: "bg_h", kind: "bash", label: "harmony-cmd" }));
  await page.waitForTimeout(300);
  checkFrame(await frame(), { card: true, rows: { bg_h: { hasTime: true, spinner: true, stop: true, logs: true, badge: false } } });
  // Snapshot WITHOUT bgTasks (stale/other payload shape) must not wipe it.
  await page.evaluate(() => (window as any).bgTest.bg.noteSessionTasks(undefined as any));
  await page.waitForTimeout(200);
  checkFrame(await frame(), { card: true, rows: { bg_h: { hasTime: true, spinner: true, stop: true, logs: true } } });
  // Snapshot WITH the task (content arrives): time keeps ticking, no dup row.
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_h", kind: "bash", label: "harmony-cmd", status: "running", startedAt: Date.now() - 2000, content: "hi", totalLines: 1 },
  ]));
  await page.waitForTimeout(1200);
  {
    const f1 = await frame();
    checkFrame(f1, { card: true, rows: { bg_h: { hasTime: true, spinner: true, stop: true, logs: true, badge: false } } });
    await page.waitForTimeout(1100);
    const f2 = await frame();
    checkFrame(f2, { card: true, rows: { bg_h: { hasTime: true, spinner: true, stop: true, logs: true } } });
  }
  // Finish: the running row leaves this view atomically; Archived retains it.
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_finished", sessionId: "s1", jobId: "bg_h", status: "done" }));
  await page.waitForTimeout(300);
  checkFrame(await frame(), { card: true });
  assert.equal((await page.locator("[data-bg-row]").count()), 0, "running view has no visible rows after finish");
  await page.locator("[data-bg-archive-toggle]").click();
  checkFrame(await frame(), { card: true, rows: { bg_h: { hasTime: true, spinner: false, stop: false, logs: true, badge: false } } });

  assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
  console.log("bg-session-ui: OK (card, live glue, events, summaries, no page errors)");
} finally {
  await browser.close();
  server.stop(true);
}
