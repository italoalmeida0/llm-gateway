// Build the SPA first. Uses the production static response and CSP, then
// exercises Office conversion with the real versioned Pandoc engine.
import assert from "node:assert/strict";

process.env.NODE_ENV = "production";
process.env.GATEWAY_SECRET = "office-browser-test-secret-only-00000000";
const { baseHeaders } = await import("../server/http");
const { serveStatic } = await import("../server/static");

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({
  entrypoints: [new URL("../test/fixtures/office-conversion-ui.ts", import.meta.url).pathname],
  target: "browser",
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/bundle.js") return new Response(bundle.outputs[0], { headers: { "Content-Type": "text/javascript" } });
    if (path === "/office-smoke.docx") return new Response(Bun.file(new URL("../test/fixtures/office-smoke.docx", import.meta.url)));
    if (path === "/pandoc.wasm") return serveStatic(req, path) || new Response("Missing engine", { status: 404 });
    const headers = baseHeaders(req, true);
    headers.set("Content-Type", "text/html");
    return new Response('<!doctype html><script type="module" src="/bundle.js"></script>', { headers });
  },
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
try {
  const asset = await fetch(new URL("/pandoc.wasm", server.url), { method: "HEAD" });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "application/wasm");
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(server.url.toString());
  await page.waitForFunction(() => (window as any).officeConversionTest);
  const { first, second } = await page.evaluate(() => (window as any).officeConversionTest());
  assert.match(first, /Office attachment conversion works\./);
  assert.match(second, /Second document converts too\./);
  assert.doesNotMatch(second, /Office attachment/);
  assert.deepEqual(errors, []);
  console.log("PASS: deployed Pandoc converts DOCX and RTF under the gateway CSP");
} finally {
  await browser.close();
  server.stop(true);
}
