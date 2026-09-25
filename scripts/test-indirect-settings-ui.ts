// Browser regression tests using an existing Playwright installation.
//
// The settings pipeline (skills/mcpServers config edits, expectedRevision
// saves, config_updated/mcp_status routing) is driven through the
// createSettings hook surface — the Settings modal only renders the
// General tab today (the Skills/MCP form sections were cut from the modal),
// so the forms' DOM is gone but the full pipeline and its wire protocol
// remain behind the hook. Modal-level interactions (Save/Cancel/reload
// latest, the error alert, the Saving… state) stay real DOM.
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

  // Add a skill through the editor pipeline.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.openSettings();
    a.m.setNewSkillName("style");
    a.m.setNewSkillBody("Use consistent formatting.");
    a.m.handleAddSkill();
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const m = (window as any).settingsUI.m;
      return [Object.keys(m.skills()).sort(), Object.keys(m.savedSkills())];
    }),
    [["review", "style"], ["review"]],
  );

  // Edit the skill: the editor is anchored to it (the name is locked).
  await page.evaluate(() => (window as any).settingsUI.m.editSkill("style"));
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.editingSkill()),
    "style",
  );
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.newSkillName()),
    "style",
  );
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.setNewSkillBody("Edited instructions");
    a.m.handleAddSkill();
  });
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  let request = await page.evaluate(() =>
    (window as any).settingsUI.commands.at(-1),
  );
  assert.equal(request.expectedRevision, "v1");
  assert.equal(request.skills.style.body, "Edited instructions");
  assert.equal(
    await page.getByRole("button", { name: "Saving…" }).isDisabled(),
    true,
  );

  // config_updated routing: foreign host and foreign requestId never
  // release the save; the matching one does.
  await page.evaluate((id: string) => {
    const a = (window as any).settingsUI;
    a.m.handleSettingsMessage({
      type: "config_updated",
      hostId: "other",
      requestId: id,
      success: true,
      revision: "v2",
    });
    a.m.handleSettingsMessage({
      type: "config_updated",
      hostId: "host-a",
      requestId: "other",
      success: true,
      revision: "v2",
    });
  }, request.requestId);
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.savingSettings()),
    true,
  );
  await page.evaluate(
    (id: string) =>
      (window as any).settingsUI.m.handleSettingsMessage({
        type: "config_updated",
        hostId: "host-a",
        requestId: id,
        success: false,
        error: "Disk unavailable",
      }),
    request.requestId,
  );
  assert.equal(
    await page
      .getByRole("alert")
      .textContent()
      .then((s: string) => s.includes("Disk unavailable")),
    true,
  );
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.skills().style.body),
    "Edited instructions",
  );
  await page
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  request = await page.evaluate(() =>
    (window as any).settingsUI.commands.at(-1),
  );
  await page.evaluate(
    (id: string) =>
      (window as any).settingsUI.m.handleSettingsMessage({
        type: "config_updated",
        hostId: "host-a",
        requestId: id,
        success: true,
        revision: "v2",
      }),
    request.requestId,
  );
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.showConfigModal()),
    true,
    "must wait for authoritative mirror",
  );
  await page.evaluate((request: any) => {
    const a = (window as any).settingsUI;
    a.setDoc({ ...a.doc(), revision: "v2", skills: request.skills });
  }, request);
  await page.waitForFunction(
    () => !(window as any).settingsUI.m.showConfigModal(),
  );
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.notices.at(-1)),
    "Settings saved on the host",
  );

  // A local unsaved edit survives a remote doc change (conflict state),
  // "Reload latest" restores the authoritative doc, Cancel closes.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.openSettings();
    a.m.editSkill("review");
    a.m.setNewSkillBody("Unsaved edit");
    a.setDoc({
      ...a.doc(),
      revision: "v3",
      skills: {
        ...a.doc().skills,
        remote: { name: "remote", body: "Remote change", enabled: true },
      },
    });
  });
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.newSkillBody()),
    "Unsaved edit",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", {
      name: "Reload latest settings (discard local edits)",
    })
    .click();
  assert.equal(
    await page.evaluate(
      () => (window as any).settingsUI.m.skills().remote.body,
    ),
    "Remote change",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // MCP edit pipeline: args are parsed from JSON, saved secrets stay
  // omitted, and a duplicate name never overwrites an existing server.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.openSettings();
    a.m.editMcpServer("local");
  });
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.newMcpArgs()),
    '["path with spaces"]',
  );
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.setNewMcpArgs('["-y", "/path with spaces"]');
    a.m.handleAddMcpServer();
  });
  assert.deepEqual(
    await page.evaluate(
      () => (window as any).settingsUI.m.mcpServers().local.args,
    ),
    ["-y", "/path with spaces"],
  );
  assert.equal(
    await page.evaluate(
      () => (window as any).settingsUI.m.mcpServers().local.env,
    ),
    undefined,
    "saved secrets must remain omitted",
  );
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.setNewMcpName("local");
    a.m.setNewMcpCmd("overwrite");
    a.m.handleAddMcpServer();
  });
  assert.equal(
    await page.evaluate(
      () => (window as any).settingsUI.m.mcpServers().local.command,
    ),
    "exe",
    "duplicate name silently overwrote server",
  );
  await page.evaluate(() => (window as any).settingsUI.m.resetMcpEditor());

  // test_mcp round trip: the result is scoped to the matching requestId
  // and a config change clears the stale test result.
  await page.evaluate(() => (window as any).settingsUI.m.testMcpServer("local"));
  request = await page.evaluate(() =>
    (window as any).settingsUI.commands.at(-1),
  );
  assert.equal(request.type, "test_mcp");
  await page.evaluate(
    (id: string) =>
      (window as any).settingsUI.m.handleSettingsMessage({
        type: "mcp_status",
        hostId: "host-a",
        requestId: id,
        name: "local",
        status: "tested",
        toolCount: 3,
        message: "No tool was invoked.",
      }),
    request.requestId,
  );
  assert.equal(
    await page.evaluate(
      () => (window as any).settingsUI.m.mcpTest("local").toolCount,
    ),
    3,
  );
  await page.evaluate(() => (window as any).settingsUI.m.toggleMcp("local"));
  assert.equal(
    await page.evaluate(() => (window as any).settingsUI.m.mcpTest("local")),
    undefined,
    "changed config kept stale test success",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => (window as any).settingsUI.m.mcpServers().local.disabled,
    ),
    undefined,
    "cancel did not restore server state",
  );

  // Host change clears drafts and closes the modal; foreign-host status
  // events are ignored; invalid skill names (__proto__) are rejected.
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.m.openSettings();
    a.m.setNewMcpName("draft");
    a.setHost("host-b");
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const m = (window as any).settingsUI.m;
      return [
        m.showConfigModal(),
        Object.keys(m.skills()),
        Object.keys(m.mcpServers()),
        m.newMcpName(),
      ];
    }),
    [false, [], [], ""],
  );
  await page.evaluate(() => {
    const a = (window as any).settingsUI;
    a.setDoc({ id: "daemon", hostId: "host-b", revision: "b1" });
    a.m.handleSettingsMessage({
      type: "mcp_status",
      hostId: "host-a",
      name: "local",
      status: "tested",
    });
    a.m.openSettings();
    a.m.setNewSkillName("__proto__");
    a.m.setNewSkillBody("Invalid name");
    a.m.handleAddSkill();
  });
  assert.deepEqual(
    await page.evaluate(() =>
      Object.keys((window as any).settingsUI.m.skills()),
    ),
    [],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log("Indirect settings browser regressions passed");
} finally {
  await browser.close();
  server.stop(true);
}
