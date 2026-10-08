// Real-session tool body audit: renders the real daemon session fixture
// (test/fixtures/sessions/real-session.jsonl) through the production transcript at
// desktop and mobile widths, expanding every disclosure, and asserts:
//   - no horizontal overflow;
//   - no <tool_result …> envelope XML leaking into rendered text;
//   - no raw metadata text in bodies (footer chips carry it instead);
//   - no generic "tool" headers (every unit has a real summary);
//   - footer chips render for tool results.
// Screenshots land in REAL_SESSION_SHOTS (default: /tmp/real-session-shots).
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);

const bundle = await Bun.build({
  entrypoints: ["test/fixtures/real-session-ui.tsx"],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const workerBundle = await Bun.build({
  entrypoints: ["web/src/indirect-code/transcript/history-worker.ts"],
  target: "browser",
});
if (!workerBundle.success) throw new Error(workerBundle.logs.join("\n"));
const cssName = Array.from(new Bun.Glob("*.css").scanSync("dist"))[0];
const session = Bun.file("test/fixtures/sessions/real-session.jsonl");
if (!(await session.exists())) {
  console.log("SKIP: test/fixtures/sessions/real-session.jsonl missing");
  process.exit(0);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/bundle.js") return new Response(bundle.outputs[0]);
    if (p === "/app.css") return new Response(Bun.file("dist/" + cssName));
    if (p === "/session.jsonl") return new Response(session);
    if (p === "/workers/history-worker.js") return new Response(workerBundle.outputs[0]);
    return new Response(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    );
  },
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const out = process.env.REAL_SESSION_SHOTS || "/tmp/real-session-shots";
await Bun.$`mkdir -p ${out}`.quiet();

for (const [name, vp] of [
  ["desktop", { width: 1280, height: 1200 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  const page = await browser.newPage({ viewport: vp, hasTouch: name === "mobile", isMobile: name === "mobile" });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(server.url.toString());
  try {
    await page.waitForFunction(() => (window as any).realSessionReady, undefined, { timeout: 20000 });
  } catch (e) {
    throw new Error(`${name}: session never became ready: ${errors.join(" | ") || String(e)}`, { cause: e });
  }
  await page.evaluate(() => {
    document.documentElement.classList.toggle("mobile", navigator.maxTouchPoints > 0);
  });
  // Expand in waves: aggregate cards first (their units only exist after open),
  // then tool unit bodies, then nested sub-groups.
  for (const sel of ['[data-assistant-message] > div.border-t', '[data-toolseg^="u:"]', '[data-toolseg^="g:"]']) {
    await page.evaluate((s) => {
      for (const el of document.querySelectorAll<HTMLElement>(s)) {
        // Aggregate cards and sub-groups use <button>; tool unit headers are
        // a clickable <div> (group/tool).
        const trig = el.querySelector<HTMLElement>(":scope > button") || el.querySelector<HTMLElement>('div[class*="group/tool"]');
        if (trig) trig.click();
      }
    }, sel);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(300);

  const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-toolseg^="u:"]')].map((row) => {
      const hdrEl = row.querySelector('div[class*="group/tool"]') || row.firstElementChild;
      const hdr = (hdrEl?.textContent || "").replace(/\s+/g, " ").trim();
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();
      return { name: hdr.slice(0, 60), text: text.slice(0, 400) };
    });
    const scrollContainers = (row: Element) =>
      [...row.querySelectorAll("*")].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)).length;
    return {
      rows,
      body: (document.body.textContent || "").replace(/\s+/g, " "),
      footerChips: document.querySelectorAll("[data-tool-footer] span").length,
      nestedScroll: [...document.querySelectorAll('[data-toolseg^="u:"]')].filter((row) => scrollContainers(row) > 1).length,
      overflow: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  });

  console.log(`=== ${name} (${vp.width}px) overflow=${!report.overflow} rows=${report.rows.length} chips=${report.footerChips} errors=${errors.length}`);
  const headers = new Map<string, number>();
  for (const r of report.rows) {
    const key = r.name.split(" ")[0] || "?";
    headers.set(key, (headers.get(key) || 0) + 1);
    if (!r.name || /^tool$/i.test(r.name) || r.name === "Result") {
      console.log(`  SUSPECT ROW [${r.name}] | ${r.text.slice(0, 160)}`);
    }
  }
  console.log("  headers:", [...headers.entries()].map(([k, n]) => `${k}:${n}`).join(" "));

  if (!report.overflow) throw new Error(`${name}: horizontal overflow`);
  if (errors.length) throw new Error(`${name}: page errors: ${errors.join(" | ")}`);
  if (/<tool_result|&lt;tool_result/.test(report.body)) throw new Error(`${name}: tool_result XML leaked into the UI`);
  // Raw envelope metadata must never appear as body text: it lives in chips.
  if (/No output yet\./.test(report.body)) throw new Error(`${name}: raw bg_check info text leaked`);
  if (/more lines: offset \d+/.test(report.body)) throw new Error(`${name}: raw "next" footer text leaked`);
  if (/\[exit \d+\]|\[running\]|\[page /.test(report.body)) throw new Error(`${name}: raw footer line leaked`);
  if (report.rows.length === 0) throw new Error(`${name}: no tool rows rendered`);
  if (report.rows.some((r) => /^tool$/i.test(r.name))) throw new Error(`${name}: generic "tool" header rendered`);
  if (report.footerChips === 0) throw new Error(`${name}: no footer chips rendered`);
  if (report.nestedScroll > 0) throw new Error(`${name}: ${report.nestedScroll} tool rows have nested scroll containers`);

  await page.screenshot({ path: `${out}/real-${name}.png`, fullPage: true });
  await page.close();
}

await browser.close();
server.stop();
console.log(`PASS: real session tool bodies (${out})`);
