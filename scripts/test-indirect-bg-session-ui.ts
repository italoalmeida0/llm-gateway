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
  await page.getByRole("button", { name: "Logs" }).last().click();
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
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_stop", kind: "bash", label: "stoppable", status: "running", startedAt: Date.now(), content: "working" },
  ]));
  await page.waitForFunction(() => document.body.textContent?.includes("stoppable"));
  const sentBefore = await page.evaluate(() => ((window as any).__sent ?? []).length);
  await page.getByRole("button", { name: "Stop" }).first().click();
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
  if (!/\d+[smh]/.test(winText || "")) {
    throw new Error(`detached row keeps ticking in the window: ${JSON.stringify((winText || "").slice(0, 200))} dbg=${JSON.stringify(winDbg)}`);
  }
  const winDur = await page.locator('[data-testid="row-detach"] [data-tool-duration]').count();
  assert.ok(winDur >= 1, "detached row renders its duration element");
  assert.ok(!/No output/.test(winText || ""), `detached row must not claim "No output": ${JSON.stringify((winText || "").slice(0, 200))}`);

  // 8. Full-scene review: every element of every row, in harmony.
  // A running row must show spinner + kind icon + label + live time +
  // Stop + Logs. A finished row must show status icon + kind icon + label
  // + badge + Logs, and NO spinner/time/Stop. The header must count right.
  await page.evaluate(() => (window as any).bgTest.seed([
    { id: "bg_run", kind: "bash", label: "run-cmd", status: "running", startedAt: Date.now() - 65000, content: "out" },
    { id: "bg_done", kind: "python", label: "done-cmd", status: "done", startedAt: 1, endedAt: 61001, exitCode: 0, content: "ok" },
    { id: "bg_err", kind: "bash", label: "err-cmd", status: "error", startedAt: 1, endedAt: 2000, exitCode: 1, content: "boom" },
  ]));
  await page.waitForFunction(() => (document.body.textContent || "").includes("run-cmd"));
  await page.waitForTimeout(1200);
  const scene = await page.evaluate(() => {
    const body = document.body.textContent || "";
    const rows = [...document.querySelectorAll("[data-bg-row]")].map((r) => ({
      html: (r as HTMLElement).innerText || "",
      spinner: !!r.querySelector(".animate-spin"),
      stop: [...r.querySelectorAll("button")].some((b) => b.textContent === "Stop"),
      logs: [...r.querySelectorAll("button")].some((b) => b.textContent === "Logs" || b.textContent === "Hide logs"),
    }));
    return { header: body.slice(body.indexOf("Background tasks"), body.indexOf("Background tasks") + 60), rows };
  });
  assert.equal(scene.rows.length, 3, `3 rows visible, got ${scene.rows.length}`);
  assert.ok(/1 running/.test(scene.header), `header counts running: ${scene.header}`);
  const run = scene.rows.find((r) => r.html.includes("run-cmd"))!;
  assert.ok(run.spinner, "running row needs the spinner");
  assert.ok(run.stop, "running row needs Stop");
  assert.ok(run.logs, "running row needs Logs toggle");
  assert.ok(/\d+[smh]/.test(run.html), `running row needs a live time, got: ${JSON.stringify(run.html.slice(0, 200))}`);
  const done = scene.rows.find((r) => r.html.includes("done-cmd"))!;
  assert.ok(!done.spinner, "finished row must not spin");
  assert.ok(!done.stop, "finished row must not offer Stop");
  assert.ok(done.logs, "finished row needs Logs toggle");
  assert.ok(/done/.test(done.html), `finished row needs its badge: ${JSON.stringify(done.html.slice(0, 200))}`);
  const err = scene.rows.find((r) => r.html.includes("err-cmd"))!;
  assert.ok(!err.spinner && !err.stop && err.logs, "error row: badge + logs, no spinner/stop");
  assert.ok(/error/.test(err.html), `error row needs its badge: ${JSON.stringify(err.html.slice(0, 200))}`);
  // Empty again: card disappears entirely (no orphan header).
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
          stop: [...r.querySelectorAll("button")].some((b) => b.textContent === "Stop"),
          logs: [...r.querySelectorAll("button")].some((b) => b.textContent === "Logs" || b.textContent === "Hide logs"),
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
  // Finish: badge appears, spinner/time/stop go together (never half).
  await page.evaluate(() => (window as any).bgTest.event({ type: "bg_task_finished", sessionId: "s1", jobId: "bg_h", status: "done" }));
  await page.waitForTimeout(300);
  checkFrame(await frame(), { card: true, rows: { bg_h: { hasTime: false, spinner: false, stop: false, logs: true, badge: true } } });

  assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
  console.log("bg-session-ui: OK (card, live glue, events, summaries, no page errors)");
} finally {
  await browser.close();
  server.stop(true);
}
