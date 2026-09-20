// Real Chromium correctness/performance gate. Playwright remains external.
// PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-streaming-ui.ts
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints: [new URL("../test/fixtures/indirect-streaming-ui.tsx", import.meta.url).pathname], target: "browser", plugins: [iconifyPlugin, solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const worker = await Bun.build({ entrypoints: [new URL("../web/src/indirect-code/transcript/history-worker.ts", import.meta.url).pathname], target: "browser" });
if (!worker.success) throw new Error(worker.logs.join("\n"));
const cssName = Array.from(new Bun.Glob("*.css").scanSync("dist"))[0];
if (!cssName) throw new Error("Run bun run build:web before this browser check");
const css = Bun.file(`dist/${cssName}`);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/bundle.js") return new Response(bundle.outputs[0]);
  if (path === "/workers/history-worker.js") return new Response(worker.outputs[0]);
  if (path === "/app.css") return new Response(css);
  return new Response('<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
} });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).streamUI);
  const settle = () => page.waitForTimeout(150);
  const set = async (text: string, streaming = false) => { await page.evaluate(({text, streaming}: any) => { const a = (window as any).streamUI; a.setStreaming(streaming); a.setText(text); }, { text, streaming }); await settle(); };
  await set("# Heading\n\nA **bold** paragraph with `server.ts`, [safe](https://example.com) and [unsafe](javascript:alert%281%29).\n\n- [x] done\n- [ ] pending\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nconst n = 42;\n```\n\n<script>window.pwned = true</script>\n\nlast character!");
  assert.equal(await page.locator("#markdown h1").textContent(), "Heading");
  assert.equal(await page.locator('#markdown input[type="checkbox"]').count(), 2);
  assert.equal(await page.locator('#markdown input[type="checkbox"]').first().isChecked(), true);
  assert.equal(await page.locator("#markdown table tbody td").count(), 2);
  assert.equal(await page.locator('#markdown [data-file="server.ts"] svg').count(), 1, "initial file icon");
  assert.equal(await page.locator('#markdown a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator("#markdown script").count(), 0);
  assert((await page.locator("#markdown").textContent())?.endsWith("last character!"), "flushes final buffered character");
  await page.waitForFunction(() => document.querySelector("#markdown .tok-kw"));
  await set("new **reply**!");
  assert.equal(await page.locator("#markdown h1").count(), 0, "non-append edits reset parser");
  await set("First paragraph.\n\nSecond", true);
  await page.evaluate(() => { (window as any).firstParagraph = document.querySelector("#markdown p"); });
  await set("First paragraph.\n\nSecond paragraph grows.\n\n", true);
  assert(await page.evaluate(() => (window as any).firstParagraph === document.querySelector("#markdown p")), "append preserves finished DOM");
  await page.evaluate(() => (window as any).streamUI.setOpen(false)); await settle();
  const before = await page.locator("#markdown").textContent();
  await set("First paragraph.\n\nSecond paragraph grows.\n\nHidden update!", true);
  assert.equal(await page.locator("#markdown").textContent(), before, "collapsed details do no markdown work");
  await page.evaluate(() => (window as any).streamUI.setOpen(true)); await settle();
  await page.evaluate(() => (window as any).streamUI.setStreaming(false)); await settle();
  assert((await page.locator("#markdown").textContent())?.includes("Hidden update!"));

  // Behaviors from the user's parity.html renderer, not just generic Markdown.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { (window as any).copiedMarkdown = text; },
    } });
  });
  const liveCode = "```ts\n1:const value: number = 42;\n";
  await set(liveCode, true);
  assert(await page.locator("#markdown pre .tok-kw").count() > 0, "highlights before the fence closes");
  const scroller = page.locator("#markdown .tarnav-codeblock > .font-mono");
  const copy = page.locator("#markdown .tarnav-copy");
  assert.equal(await copy.evaluate((el: HTMLElement) => el.parentElement?.style.position), "relative");
  assert.equal(await copy.evaluate((el: HTMLElement) => el.closest(".overflow-y-auto") !== null), false, "copy stays outside the scrolling code body");
  await set(liveCode + "2:console.log(value);\n3:const next = value + 1;\n", true);
  await copy.click();
  assert.equal((await page.evaluate(() => (window as any).copiedMarkdown)).trimEnd(), "const value: number = 42;\nconsole.log(value);\nconst next = value + 1;", "copy uses source without duplicated gutter numbers");
  const gutter = await page.locator("#markdown pre > code > div > span").allTextContents();
  assert.deepEqual(gutter.filter(Boolean), ["1", "2", "3"]);
  assert.equal(await page.locator("#markdown pre > code > div > code").first().textContent(), "const value: number = 42;");
  await set(liveCode + "2:console.log(value);\n3:const next = value + 1;\n```\n");
  await copy.click();
  assert.equal((await page.evaluate(() => (window as any).copiedMarkdown)).trimEnd(), "const value: number = 42;\nconsole.log(value);\nconst next = value + 1;");
  assert(await scroller.count() === 1);

  await set("Math $E = m", true);
  await set("Math $E = mc^2$ then `server.ts` and `git push`.\n\n", true);
  assert.equal(await page.locator("#markdown .katex").count(), 1, "live KaTeX: " + await page.locator("#markdown").innerHTML());
  assert.equal(await page.locator('#markdown [data-file="server.ts"] > svg').count(), 1, "live file icon");
  assert.equal(await page.locator('#markdown [data-cmd="git"] > svg').count(), 1, "live command icon");
  const mathNodeCount = await page.locator("#markdown .katex *").count();
  await set("Math $E = mc^2$ then `server.ts` and `git push`.\n\nFollowing paragraph.\n", true);
  assert.equal(await page.locator("#markdown .katex *").count(), mathNodeCount, "KaTeX output never feeds back into its input");
  assert.equal(await page.locator('#markdown annotation[encoding="application/x-tex"]').textContent(), "E = mc^2");
  await page.evaluate(() => document.fonts.ready);
  assert(await page.evaluate(() => document.fonts.check('16px "KaTeX_Main"')), "KaTeX fonts are bundled locally");

  const table = "| A | B |\n| --- | --- |\n| one |\n| two | three | extra |\n";
  await set("", true);
  await page.evaluate(async (text: string) => {
    for (let i = 0; i < text.length; i += 3) {
      (window as any).streamUI.setText(text.slice(0, i + 3));
      await new Promise(requestAnimationFrame);
    }
    (window as any).streamUI.setStreaming(false);
  }, table);
  await settle();
  assert.deepEqual(await page.locator("#markdown tbody tr").evaluateAll((rows: Element[]) => rows.map((r) => Array.from(r.children, (c) => c.textContent?.trim()))), [["one", ""], ["two", "three"]], "ragged-table repair does not consume cells that are still streaming");
  await page.getByRole("button", { name: "Copy table", exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).copiedMarkdown), "A\tB\none\t\ntwo\tthree");
  await page.getByRole("button", { name: "Download table", exact: true }).click();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  const downloaded = await csvDownload;
  assert.equal(downloaded.suggestedFilename(), "table.csv");
  assert.equal(await Bun.file(await downloaded.path()).text(), "A,B\none,\ntwo,three");
  await page.getByRole("button", { name: "Download table", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "CSV", exact: true }).count(), 0, "floating controls dispose on close");
  await set("Loose fence inside text ``` not a fence, then `inline code`.\n\n");
  assert((await page.locator("#markdown").textContent())?.includes("not a fence, then inline code."));
  assert.equal(await page.locator('#markdown code[data-streamdown="inline-code"]').last().textContent(), "inline code");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme: string) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.setViewportSize({ width: 360, height: 740 });
    await set("```ts\nconst number = 1;\n```\n\nInline $E=mc^2$, `server.ts` and `git push`.\n");
    await page.locator("#markdown").screenshot({ path: `/tmp/indirect-parity-${theme}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  console.log("PASS: parity live highlighting, code copy/gutters, pinned copy control, icons, KaTeX, streamed ragged tables, downloads, loose spans and both themes");

  // Deterministic visibility transition: the browser still runs JS so we can
  // assert that the application (rather than Chromium throttling) pauses work.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    const a = (window as any).streamUI;
    a.inbox.push({ type: "agent_event", sessionId: "test", event: { type: "assistant_start", index: 0, turnIndex: 1 } });
    for (let i = 0; i < 5000; i++) a.inbox.push({ type: "agent_event", sessionId: "test", event: { type: "reasoning_delta", delta: "reasoning " } });
    a.inbox.push({ type: "agent_event", sessionId: "test", event: { type: "text_delta", delta: "complete answer" } });
    a.inbox.push({ type: "agent_event", sessionId: "test", event: { type: "turn_end" } });
    a.inbox.flush();
  });
  assert.equal(await page.locator("#transcript [data-streaming-markdown]").count(), 0);
  const result = await page.evaluate(() => {
    delete (document as any).hidden; document.dispatchEvent(new Event("visibilitychange"));
    const m = (window as any).streamUI.t.messages()[0];
    return { reasoning: m.blocks.find((b: any) => b.type === "reasoning").reasoning, text: m.blocks.find((b: any) => b.type === "text").text, streaming: m.streaming };
  });
  assert.equal(result.reasoning, "reasoning ".repeat(5000));
  assert.equal(result.text, "complete answer"); assert.equal(result.streaming, false);
  await page.waitForFunction(() => !(window as any).streamUI.motionReady());
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS: Markdown parity, safe URLs, final flush, edits, DOM reuse, collapsed pause, lossless hidden stream and animation observer suspension");

  const largeSession = await page.evaluate(async () => {
    const a = (window as any).streamUI;
    a.t.resetForSession();
    const messages = Array.from({ length: 100 }, (_, i) => [
      { role: "user", content: `Question ${i}`, turnIndex: i + 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "Stored reasoning. ".repeat(500) }, { type: "text", text: `Answer ${i}` }], turnIndex: i + 1, streaming: i === 99 },
    ]).flat();
    const start = performance.now();
    const pending = a.t.applySessionContent("test", messages);
    a.t.handleAgentEvent("test", { type: "text_delta", delta: " plus live suffix" });
    a.t.handleAgentEvent("test", { type: "turn_end" });
    a.t.handleStatusEvent({ type: "session_status", sessionId: "test", status: "idle" });
    await pending;
    const last = a.t.messages().at(-1);
    const elapsed = performance.now() - start;
    const text = last.blocks.find((b: any) => b.type === "text").text;
    const late = a.t.applySessionContent("test", messages);
    a.t.resetForSession(); a.setSid("other"); await late;
    const staleCount = a.t.messages().length;
    a.setSid("test");
    const small = a.t.applySessionContent("test", [{ role: "assistant", content: "snapshot", streaming: true }], undefined,
      { oldestTurn: 1, newestTurn: 1, firstIndex: 0 });
    a.t.handleAgentEvent("test", { type: "text_delta", delta: " followed by a delta" });
    await small;
    return { elapsed, text, staleCount, small: a.t.messages()[0].blocks[0].text };
  });
  assert.equal(largeSession.text, "Answer 99 plus live suffix", "worker snapshot cannot erase live deltas");
  assert.equal(largeSession.staleCount, 0, "old worker cannot resurrect a switched session");
  assert.equal(largeSession.small, "snapshot followed by a delta", "small paged snapshot commits before the next event");
  console.log("PASS: 100-turn snapshot (~850 KB reasoning), worker ordering and session switch", largeSession);

  const sustained = await page.evaluate(async () => {
    const a = (window as any).streamUI;
    a.t.resetForSession();
    const history = Array.from({ length: 120 }, (_, i) => ({
      id: `step-${i}`, role: "assistant", turnIndex: 1,
      content: [{ type: "reasoning", reasoning: "Prior thinking. ".repeat(250) },
        { type: "text", text: `Step ${i}: exploring file ${i}.` },
        { type: "tool_use", id: `read-${i}`, name: "read", input: { path: "server.ts" } },
        { type: "tool_result", tool_use_id: `read-${i}`, content: "line of code\n".repeat(100) }],
    }));
    await a.t.applySessionContent("test", history);
    a.t.handleAgentEvent("test", { type: "turn_start" });
    a.t.handleAgentEvent("test", { type: "assistant_start", index: 120, turnIndex: 1 });
    const times: number[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      for (let i = 0; i < 1000; i++) a.inbox.push({ type: "agent_event", sessionId: "test", event: { type: "reasoning_delta", delta: "Long reasoning continues.\n\n" } });
      a.inbox.flush();
      const start = performance.now();
      delete (document as any).hidden; document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      times.push(performance.now() - start);
    }
    a.t.handleAgentEvent("test", { type: "text_delta", delta: "Finished" });
    a.t.handleAgentEvent("test", { type: "turn_end" });
    a.t.handleStatusEvent({ type: "session_status", sessionId: "test", status: "idle" });
    return { resumeMs: times, reasoningLength: a.t.messages().at(-1).blocks.find((b: any) => b.type === "reasoning").reasoning.length };
  });
  assert.equal(sustained.reasoningLength, "Long reasoning continues.\n\n".length * 4000);
  assert(Math.max(...sustained.resumeMs) < 1000, "repeated returns must not stall the browser for seconds");
  console.log("PASS: 120 tool steps, 450 KB history and four background/resume cycles", sustained);

  // Retain the original 24 KB workload without depending on the removed renderer.
  {
    const p = await browser.newPage();
    p.on("pageerror", (e: Error) => errors.push(String(e)));
    await p.goto(server.url.toString());
    await p.waitForFunction(() => (window as any).streamUI); await p.waitForTimeout(250);
    const client = await p.context().newCDPSession(p);
    await client.send("Performance.enable");
    const initial = await client.send("Performance.getMetrics");
    const metrics = await p.evaluate(async () => {
      const a = (window as any).streamUI;
      const chunk = "Thinking about **performance** and `server.ts`: a growing explanation that should remain responsive.\n\n";
      let full = "";
      const times: number[] = [];
      let frames = 0; let stop = false;
      const tick = () => { frames++; if (!stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
      const start = performance.now();
      for (let i = 0; i < 240; i++) {
        const t = performance.now(); full += chunk; a.setText(full); times.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 16));
      }
      a.setStreaming(false); await new Promise((r) => setTimeout(r, 200)); stop = true;
      return { elapsed: performance.now() - start, frames, chars: full.length, pushP95: times.sort((a, b) => a - b)[Math.floor(times.length * .95)] };
    });
    const final = await client.send("Performance.getMetrics");
    const metric = (data: any, name: string) => data.metrics.find((m: any) => m.name === name)?.value || 0;
    const result = { renderer: "incremental", ...metrics,
      taskMs: (metric(final, "TaskDuration") - metric(initial, "TaskDuration")) * 1000,
      scriptMs: (metric(final, "ScriptDuration") - metric(initial, "ScriptDuration")) * 1000 };
    console.log("PASS: incremental streaming workload", result);
    // Generous headroom over the measured ~0.8 s; catches a return to multi-second work.
    assert(result.taskMs < 5000, "24 KB streaming workload must stay under 5 seconds of browser task time");
    await p.close();
  }
  // One long, still-open fence exercises live highlighting beyond 32 KB.
  const codePage = await browser.newPage();
  codePage.on("pageerror", (e: Error) => errors.push(e.message));
  await codePage.goto(server.url.toString());
  await codePage.waitForFunction(() => (window as any).streamUI);
  const codeClient = await codePage.context().newCDPSession(codePage);
  await codeClient.send("Performance.enable");
  const beforeCode = await codeClient.send("Performance.getMetrics");
  const codeStream = await codePage.evaluate(async () => {
    const a = (window as any).streamUI;
    let source = "```ts\n";
    const frameGaps: number[] = [];
    let previous = performance.now();
    for (let i = 0; i < 120; i++) {
      source += `const record${i} = { name: "item", enabled: true, values: [1, 2, 3] };\n`.repeat(6);
      a.setText(source);
      await new Promise(requestAnimationFrame);
      const now = performance.now(); frameGaps.push(now - previous); previous = now;
    }
    await new Promise(requestAnimationFrame);
    const highlightedWhileOpen = !!document.querySelector("#markdown pre .tok-kw");
    // A pause in incoming tokens must still finish the paced highlight.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const numberTokens = document.querySelectorAll("#markdown pre .tok-num").length;
    a.setText(source + "```\n"); a.setStreaming(false);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return { chars: source.length, highlightedWhileOpen, numberTokens,
      lastLinePresent: document.querySelector("#markdown pre")?.textContent?.includes("const record119"),
      frameGapP95: frameGaps.sort((a, b) => a - b)[Math.floor(frameGaps.length * .95)] };
  });
  const afterCode = await codeClient.send("Performance.getMetrics");
  const codeTask = (data: any) => data.metrics.find((m: any) => m.name === "TaskDuration").value;
  assert(codeStream.chars > 32768 && codeStream.highlightedWhileOpen && codeStream.lastLinePresent);
  assert.equal(codeStream.numberTokens, 120 * 6 * 3, "live highlight catches up during a stream pause");
  console.log("PASS: long code fence with live highlighting", { ...codeStream, taskMs: (codeTask(afterCode) - codeTask(beforeCode)) * 1000 });
  await codePage.close();
  assert.equal(errors.length, 0, errors.join("\n"));
} finally { await browser.close(); server.stop(); }
