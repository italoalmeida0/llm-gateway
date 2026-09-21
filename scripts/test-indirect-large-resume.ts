// Actual components, worker, relay inbox and WebSocket. No model/API credentials.
// Visibility overrides test application suspension; CDP freeze additionally
// exercises real queued network traffic while browser execution is suspended.
import assert from "node:assert/strict";
import { estimateTokenCount } from "tokenx";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundles = await Promise.all([
  Bun.build({ entrypoints: ["test/fixtures/indirect-streaming-ui.tsx"], target: "browser", plugins: [iconifyPlugin, solidPlugin] }),
  Bun.build({ entrypoints: ["web/src/indirect-code/transcript/history-worker.ts"], target: "browser" }),
]);
for (const bundle of bundles) assert(bundle.success, bundle.logs.join("\n"));
const css = Array.from(new Bun.Glob("dist/*.css").scanSync())[0];
assert(css, "Run bun run build:web first");
let socket: any;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/events" && server.upgrade(req)) return;
    if (path === "/bundle.js") return new Response(bundles[0].outputs[0]);
    if (path === "/workers/history-worker.js") return new Response(bundles[1].outputs[0]);
    if (path === "/app.css") return new Response(Bun.file(css));
    return new Response('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><button id="probe" style="position:fixed;top:0;right:0;z-index:100">Respond</button><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
  }, websocket: { open(ws) { socket = ws; }, message() {} },
});
function step(i: number) {
  const name = ["read", "bash", "grep"][i % 3];
  const input = name === "read" ? { path: `src/module${i}.ts` } : name === "bash" ? { command: `echo module-${i}` } : { pattern: `symbol_${i}`, path: "src" };
  return { role: "assistant", turnIndex: 1, content: [
    { summary: "Considering module behavior and checking dependencies. ".repeat(30) },
    // Distinct notes prevent identical prose from hiding quadratic dedup costs.
    { text: `Step ${i}: ` + Array.from({ length: 60 }, (_, j) => `module_${i}_symbol_${j}`).join(" ") },
    { type: "tool_use", id: `t${i}`, name, input },
    { type: "tool_result", tool_use_id: `t${i}`, content: Array.from({ length: 100 }, (_, j) => `${j + 1}:export const value${j} = "module-${i}-field-${j}";`).join("\n") },
  ] };
}
const history = Array.from({ length: 750 }, (_, i) => step(i));
const estimatedTokens = history.reduce((n, m) => n + m.content.reduce((sum, c) => sum + estimateTokenCount(c.summary || c.text || c.content || ""), 0), 0);
assert(estimatedTokens >= 500_000, "stress fixture must exceed 500k estimated context tokens");
const send = (message: unknown) => socket.send(JSON.stringify(message));
const emit = (event: unknown) => send({ type: "agent_event", sessionId: "test", event });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${server.url}?responsive&relay`);
  await page.waitForFunction(() => (window as any).streamUI);
  for (let attempts = 0; !socket && attempts < 100; attempts++) await Bun.sleep(10);
  assert(socket, "fixture WebSocket connected");
  send({ type: "session_content", sessionId: "test", messages: history });
  send({ type: "session_status", sessionId: "test", status: "running" });
  send({ type: "checkpoint", id: "seed" });
  await page.waitForFunction(() => (window as any).streamUI.checkpoint === "seed");
  await page.evaluate(async () => {
    await (window as any).streamUI.snapshot;
    (window as any).longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) (window as any).longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: false });
    document.getElementById("probe")!.onclick = () => { (window as any).clickedAt = performance.now(); };
  });
  const cdp = await page.context().newCDPSession(page);
  const results = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const nodesBefore = await page.locator("#transcript *").count();
    const frozen = cycle >= 2;
    if (frozen) await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    for (let j = 0; j < 40; j++) {
      const index = history.length, message = step(index);
      history.push(message);
      const [reason, text, call, result] = message.content;
      emit({ type: "assistant_start", index, turnIndex: 1 });
      for (let k = 0; k < reason.summary!.length; k += 64) emit({ type: "reasoning_delta", delta: reason.summary!.slice(k, k + 64) });
      emit({ type: "text_delta", delta: text.text });
      emit({ type: "tool_call", id: call.id, name: call.name, args: call.input });
      emit({ type: "tool_progress", id: call.id, text: "Inspecting the next module.\n" });
      emit({ type: "tool_result", id: call.id, result: result.content });
    }
    send({ type: "checkpoint", id: cycle });
    let started = performance.now();
    if (frozen) await cdp.send("Page.setWebLifecycleState", { state: "active" });
    else {
      await page.waitForFunction((id: number) => (window as any).streamUI.checkpoint === id, cycle);
      assert.equal(await page.locator("#transcript *").count(), nodesBefore, "no hidden transcript DOM work");
      started = performance.now();
    }
    await page.evaluate(() => {
      (window as any).resumeStart = performance.now();
      delete (document as any).hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.locator("#probe").click();
    const inputMs = performance.now() - started;
    await page.waitForFunction((id: number) => (window as any).streamUI.checkpoint === id, cycle);
    const measurements = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const a = (window as any).streamUI;
      return { paintMs: performance.now() - (window as any).resumeStart,
        nodes: document.querySelectorAll("#transcript *").length,
        count: a.t.messages().length,
        last: a.t.messages().at(-1).blocks.map((b: any) => b.reasoning || b.text || b.toolResult || "").join("\n"),
        longestTaskMs: Math.max(0, ...(window as any).longTasks.filter((t: any) => t.start + t.duration > (window as any).resumeStart).map((t: any) => t.duration)) };
    });
    assert.equal(measurements.count, history.length);
    assert(measurements.last.includes(history.at(-1)!.content[0].summary!), "all reasoning deltas survived");
    assert(measurements.last.includes(history.at(-1)!.content[3].content!), "last tool result survived");
    assert(inputMs < 1000, `input stalled for ${inputMs.toFixed(0)} ms`);
    assert(measurements.paintMs < 1000, `resume stalled for ${measurements.paintMs.toFixed(0)} ms`);
    results.push({ cycle, frozen, inputMs: Math.round(inputMs), paintMs: Math.round(measurements.paintMs), longestTaskMs: measurements.longestTaskMs, nodes: measurements.nodes });
  }
  const checkIntegrity = async () => assert.deepEqual(await page.evaluate(() => (window as any).streamUI.t.messages().map((m: any) => ({
    reasoning: m.blocks.filter((b: any) => b.type === "reasoning").map((b: any) => b.reasoning).join("").length,
    text: m.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
    results: m.blocks.filter((b: any) => b.type === "tool_result").map((b: any) => [b.toolId, b.toolResult.length]),
  }))), history.map((m) => ({ reasoning: m.content[0].summary!.length, text: m.content[1].text,
    results: [[m.content[3].tool_use_id, m.content[3].content!.length]] })), "every tool result and note survived");
  await checkIntegrity();
  // A fresh daemon snapshot must reconcile the live additions without duplicates.
  send({ type: "session_content", sessionId: "test", messages: history });
  emit({ type: "turn_end" });
  send({ type: "session_status", sessionId: "test", status: "idle" });
  send({ type: "checkpoint", id: "finished" });
  await page.waitForFunction(() => (window as any).streamUI.checkpoint === "finished");
  await page.evaluate(async () => { await (window as any).streamUI.snapshot; });
  assert.equal(await page.evaluate(() => (window as any).streamUI.t.messages().length), history.length);
  assert.equal(await page.evaluate(() => (window as any).streamUI.t.sessionStatus()), "idle");
  await checkIntegrity();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ seedBytes: JSON.stringify(history.slice(0, 750)).length, estimatedTokens, initialTools: 750, finalTools: history.length, results, errors }, null, 2));
} finally { await browser.close(); server.stop(true); }
