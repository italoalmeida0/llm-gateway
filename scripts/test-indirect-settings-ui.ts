// Browser regression coverage for the remaining host settings pipeline:
// general settings save/cancel/reload, expectedRevision conflicts, host and
// request correlation, offline failures, and authoritative mirror acks.
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const bundle = await Bun.build({
  entrypoints: [
    new URL("../test/fixtures/indirect-settings-ui.tsx", import.meta.url)
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
  await page.waitForFunction(() => (window as any).settingsUI.m);

  // Historical skills remain available to the composer as a read-only mirror.
  await page.evaluate(() => (window as any).settingsUI.m.openSettings());
  assert.deepEqual(
    await page.evaluate(() => Object.keys((window as any).settingsUI.m.savedSkills())),
    ["review"],
  );

  // General settings send only the supported settings map.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.setDaemonSettings({ ...a.m.daemonSettings(), autoCompactPercent: 90 });
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  let request = await page.evaluate(() => (window as any).settingsUI.commands.at(-1));
  assert.equal(request.expectedRevision, "v1");
  assert.equal(request.settings.auto_compact_threshold, 90);
  assert.equal("skills" in request, false);
  assert.equal("mcpServers" in request, false);
  assert.equal(
    await page.getByRole("button", { name: "Saving…" }).isDisabled(),
    true,
  );

  // Foreign host/request acknowledgements cannot release a save.
  await page.evaluate((id: string) => {
    const m = (window as any).settingsUI.m;
    m.handleSettingsMessage({ type: "config_updated", hostId: "other", requestId: id, success: true, revision: "v2" });
    m.handleSettingsMessage({ type: "config_updated", hostId: "host-a", requestId: "other", success: true, revision: "v2" });
  }, request.requestId);
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.savingSettings()), true);

  // A daemon failure leaves the draft in place and surfaces its message.
  await page.evaluate((id: string) => (window as any).settingsUI.m.handleSettingsMessage({
    type: "config_updated", hostId: "host-a", requestId: id, success: false, error: "Disk unavailable",
  }), request.requestId);
  assert.match((await page.getByRole("alert").textContent()) || "", /Disk unavailable/);
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.daemonSettings().autoCompactPercent), 90);

  // Successful acknowledgement still waits for the authoritative mirror.
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  request = await page.evaluate(() => (window as any).settingsUI.commands.at(-1));
  await page.evaluate((id: string) => (window as any).settingsUI.m.handleSettingsMessage({
    type: "config_updated", hostId: "host-a", requestId: id, success: true, revision: "v2",
  }), request.requestId);
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.showConfigModal()), true);
  await page.evaluate((request: any) => {
    const a = (window as any).settingsUI;
    a.setDoc({ ...a.doc(), revision: "v2", settings: request.settings });
  }, request);
  await page.waitForFunction(() => !(window as any).settingsUI.m.showConfigModal());
  assert.equal(await page.evaluate(() => (window as any).settingsUI.notices.at(-1)), "Settings saved on the host");

  // A remote revision disables saving until the latest configuration is loaded.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.openSettings();
    a.m.setDaemonSettings({ ...a.m.daemonSettings(), autoCompactPercent: 70 });
    a.setDoc({ ...a.doc(), revision: "v3", settings: { auto_compact_threshold: 80 } });
  });
  assert.equal(await page.getByRole("button", { name: "Save changes", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Reload latest settings (discard local edits)" }).click();
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.daemonSettings().autoCompactPercent), 80);

  // Offline saves are rejected without creating a command; Cancel discards the draft.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.setDaemonSettings({ ...a.m.daemonSettings(), autoCompactPercent: 95 });
    a.setOnline(false);
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  assert.match((await page.getByRole("alert").textContent()) || "", /Reconnect the host/);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.showConfigModal()), false);

  // Host changes close the modal and clear the in-flight state.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.setOnline(true);
    a.setHost("host-b");
  });
  assert.equal(await page.evaluate(() => (window as any).settingsUI.m.showConfigModal()), false);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log("Indirect settings browser regressions passed");
} finally {
  await browser.close();
  server.stop(true);
}
