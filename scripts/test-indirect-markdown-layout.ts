// Real Chromium layout checks with production CSS; Playwright stays external.
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const bundle = await Bun.build({ entrypoints: ["test/fixtures/indirect-streaming-ui.tsx"], target: "browser", plugins: [iconifyPlugin, solidPlugin] });
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const cssName = Array.from(new Bun.Glob("*.css").scanSync("dist"))[0];
assert(cssName, "Run bun run build:web first");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/bundle.js") return new Response(bundle.outputs[0]);
  if (path === "/app.css") return new Response(Bun.file(`dist/${cssName}`));
  return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
} });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
const errors: string[] = [];
const body = 'def verify_rendering():\n    """Verify that multiline code stays in a fenced block."""\n    items = ["first", "second", "third"]\n\n    for index, item in enumerate(items, start=1):\n        print(f"{index}: {item}")\n\n    return len(items) == 3\n\n\nif __name__ == "__main__":\n    ok = verify_rendering()\n    print("Rendered:", ok)\n';
const reply = `Here is a multiline code block:\n\n\`\`\`python\n${body}\`\`\`\n\nThe paragraph after the fence stays outside the code.`;
const sample = `# Streaming review\n\nEdit \`src/indirect-code/components/StreamingMarkdown.tsx\` and run \`git diff\`.\n\n${reply}\n\n| Configuration property | Current value | Description |\n| :--- | :---: | ---: |\n| sessionId | session-123456789 | Active conversation |\n| transport | WebSocket | Incremental updates |\n\nInline $E=mc^2$.\n\n## Notes and tasks\n\n> [!NOTE]\n> A **useful** rendering note.\n\n> [!WARNING]\n> Verify code before running it.\n\n- Parent item\n  - Nested item\n    - Another level\n- [x] Completed task\n- [ ] Pending task\n\n$$\nP(A|B) = \\frac{P(B|A)P(A)}{P(B)}\n$$\n`;
try {
  for (const width of [320, 360, 390, 768, 1024, 1440, 1920]) for (const theme of ["light", "dark"]) {
    const touch = width <= 768;
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: width < 600 });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`${server.url}?responsive`);
    await page.evaluate((theme: string) => {
      document.documentElement.dataset.theme = theme;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedText = text; } } });
    }, theme);
    await page.evaluate(async (text: string) => {
      const a = (window as any).streamUI;
      for (let end = 1; end < text.length + 80; end += 80) {
        a.setText(text.slice(0, end)); await new Promise(requestAnimationFrame);
        if (document.documentElement.scrollWidth > innerWidth + 1) throw new Error("Page overflow during stream");
      }
      a.setStreaming(false);
    }, sample);
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#markdown pre').count(), 1);
    assert.equal((await page.locator('#markdown pre code').textContent())?.trimEnd(), body.trimEnd());
    assert.equal(await page.locator('#markdown [data-streamdown="inline-code"]').count(), 2);
    assert.equal(await page.locator('#markdown [data-callout]').count(), 2);
    assert.equal(await page.locator('#markdown .katex').count(), 2);
    assert(await page.locator('#markdown').evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1), "wide tables scroll locally, not the entire message");
    const copy = page.getByRole("button", { name: "Copy code", exact: true });
    if (!touch) await page.locator('.tarnav-codeblock').hover();
    await page.waitForTimeout(180);
    const geometry = await copy.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect(); const parent = el.parentElement!.getBoundingClientRect();
      return { opacity: getComputedStyle(el).opacity, width: r.width, height: r.height, inside: r.right <= parent.right && r.left >= parent.left && r.top >= parent.top && r.bottom <= parent.bottom };
    });
    assert.equal(geometry.opacity, "1");
    assert(geometry.inside && geometry.width === 24 && geometry.height === 24);
    const before = await copy.boundingBox();
    await page.locator('.tarnav-codeblock > .font-mono').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth; });
    const after = await copy.boundingBox();
    assert.deepEqual(after, before, "copy stays pinned during code scrolling");
    if (touch) await copy.tap(); else await copy.click();
    assert.equal((await page.evaluate(() => (window as any).copiedText)).trimEnd(), body.trimEnd());
    assert.equal(await copy.getAttribute('data-copy-state'), 'copied');
    await page.locator('.tarnav-codeblock > .font-mono').evaluate((el: HTMLElement) => { el.scrollTop = 0; el.scrollLeft = 0; });
    assert.equal(await page.locator('.rc-table-wrap button').count(), 0, "tables have no controls");
    assert.equal(await page.locator('.tarnav-code-language').textContent(), 'python');
    // Keyboard focus reveals controls even after the pointer leaves the message.
    await page.mouse.move(0, 0);
    await copy.focus(); await page.waitForTimeout(180);
    assert.equal(await copy.evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '1');
    if (touch) {
      for (const actions of await page.locator('.rc-message-actions').all()) {
        assert.equal(await actions.evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '1');
        assert(await actions.locator('button').first().evaluate((el: HTMLElement) => el.offsetHeight >= 24 && el.offsetHeight <= 28));
      }
    }
    await page.locator('#markdown pre').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/indirect-layout-${width}-${theme}.png`, fullPage: true });
    // Reflow an already populated response across all conversation width settings.
    if (width === 1440) for (const size of ['max-w-xl', 'max-w-3xl', 'max-w-5xl']) {
      await page.evaluate((size: string) => (window as any).streamUI.setWidth(size), size);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.close();
    console.log(`PASS: ${width}px ${theme}, streamed code/table/math, ${touch ? 'touch' : 'mouse'} controls, copy, scrolling and keyboard`);
  }

  // The reported code example, streamed across tiny boundaries, then reconciled
  // with its assistant_message and session snapshot. Only one final is visible.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`${server.url}?responsive`);
  for (const crlf of [false, true]) {
    await page.evaluate(async ({ reply, crlf }: { reply: string; crlf: boolean }) => {
      const a = (window as any).streamUI; a.t.resetForSession();
      const emit = (event: any) => a.t.handleAgentEvent('test', event);
      emit({ type: 'turn_start' }); emit({ type: 'assistant_start', index: 0, turnIndex: 1 });
      emit({ type: 'tool_call', id: 'q', name: 'question', args: { questions: [] } });
      emit({ type: 'tool_result', id: 'q', result: 'Test rendering' });
      emit({ type: 'assistant_start', index: 2, turnIndex: 1 });
      emit({ type: 'reasoning_delta', delta: 'Preparing a multiline example.' });
      const text = crlf ? reply.replaceAll('\n', '\r\n') : reply;
      for (let i = 0; i < text.length; i += 7) { emit({ type: 'text_delta', delta: text.slice(i, i + 7) }); await new Promise(requestAnimationFrame); }
      const final = { role: 'assistant', turnIndex: 1, content: [{ text }, { summary: 'Preparing a multiline example.' }], meta: { turn_completed: true } };
      emit({ type: 'assistant_message', index: 2, message: final }); emit({ type: 'turn_end' });
      a.t.handleStatusEvent({ type: 'session_status', sessionId: 'test', status: 'idle' });
      await a.t.applySessionContent('test', [
        { role: 'assistant', turnIndex: 1, content: [{ type: 'tool_use', id: 'q', name: 'question', input: { questions: [] } }] },
        { role: 'tool', turnIndex: 1, content: [{ type: 'tool_result', tool_use_id: 'q', content: 'Test rendering' }] }, final,
      ]);
    }, { reply, crlf });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#transcript [data-turn-final]:visible').count(), 1);
    assert.equal(await page.locator('#transcript pre:visible').count(), 1);
    assert.equal(await page.locator('#transcript [data-streamdown="inline-code"]:visible').count(), 0);
    assert.equal((await page.locator('#transcript pre:visible > code').textContent())?.trimEnd(), body.trimEnd());
    assert.equal(await page.locator('#transcript p:visible').allTextContents().then((p: string[]) => p.filter(s => s === 'Here is a multiline code block:').length), 1);
    assert.equal(await page.locator('#transcript [data-turn-final] p').last().textContent(), 'The paragraph after the fence stays outside the code.');
  }
  // Recover visibly from denied clipboard access.
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }); });
  const copy = page.locator('#transcript [data-turn-final] .tarnav-copy');
  await copy.tap();
  assert.equal(await copy.getAttribute('data-copy-state'), 'error');
  assert.equal(await copy.getByRole('status').textContent(), 'Copy failed. Try again.');
  assert.deepEqual(errors, []);
  console.log('PASS: LF/CRLF fences, stream completion and snapshot without a duplicate final, clipboard failure feedback');
} finally { await browser.close(); server.stop(); }
