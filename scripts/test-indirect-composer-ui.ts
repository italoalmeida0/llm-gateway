// Browser regression tests using an existing Playwright installation.
import assert from "node:assert/strict";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const bundle = await Bun.build({
  entrypoints: [
    new URL("../test/fixtures/indirect-composer-ui.tsx", import.meta.url)
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
  await page.waitForFunction(() => (window as any).composerUI.c);
  // Explicit writes after a session switch must survive the deferred restore.
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.c.setInputPrompt("Draft A");
    a.setSid("session-b");
    a.c.setInputPrompt("Draft B");
  });
  assert.equal(await page.locator("#rc-composer").inputValue(), "Draft B");
  await page.evaluate(() => (window as any).composerUI.setSid("session-a"));
  assert.equal(await page.locator("#rc-composer").inputValue(), "Draft A");
  await page.evaluate(() => (window as any).composerUI.setHost("host-b"));
  assert.equal(await page.locator("#rc-composer").inputValue(), "");
  await page.evaluate(() => (window as any).composerUI.setHost("host-a"));
  assert.equal(await page.locator("#rc-composer").inputValue(), "Draft A");
  // Mirror mutations need not bump activity timestamps.
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.mirror.store().projects.insert({id:"p",hostId:"host-a",name:"Old",path:"/work",createdAt:1});
    a.mirror.store().sessions.insert({id:"s",hostId:"host-a",title:"Old",cwd:"/work",createdAt:1,updatedAt:1,model:"m",status:"idle",pinned:false});
  });
  await page.waitForFunction(() => (window as any).composerUI.mirror.projects()[0]?.name === "Old");
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.mirror.store().projects.updateOne({id:"p"}, {$set:{name:"Renamed",protected:true}});
    a.mirror.store().sessions.updateOne({id:"s"}, {$set:{title:"Renamed",status:"running",pinned:true,options:{effort:"high",mode:"plan",access:"full",skills:["review"]}}});
  });
  assert.deepEqual(await page.evaluate(() => {
    const m = (window as any).composerUI.mirror;
    return [m.projects()[0].name,m.projects()[0].protected,m.sessions()[0].title,m.sessions()[0].status,m.sessions()[0].pinned,m.sessions()[0].options.skills];
  }), ["Renamed",true,"Renamed","running",true,["review"]]);
  const state = () =>
    page.evaluate(() => {
      const a = (window as any).composerUI;
      return {
        pending: a.c.pendingAttachments(),
        preparing: a.c.preparingAttachments(),
        sending: a.c.sending(),
        status: a.t.sessionStatus(),
        commands: a.commands,
        notices: a.notices,
        text: a.c.inputPrompt(),
      };
    });
  const attach = async (names: string[]) =>
    page.evaluate(async (names: string[]) => {
      const a = (window as any).composerUI;
      await a.c.handleFiles(
        names.map(
          (name, i) =>
            new File([`contents-${i}`], name, { type: "text/plain" }),
        ),
      );
    }, names);
  const reset = async () => {
    await page.evaluate(() => {
      const a = (window as any).composerUI;
      a.c.clearAttachments();
      a.c.setInputPrompt("");
      a.t.setSessionStatus("idle");
      a.commands.length = 0;
      a.notices.length = 0;
    });
  };
  await attach(["same.txt", "same.txt"]);
  await page.locator("#rc-composer").fill("Read both");
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.sendDone = a.c.sendPrompt();
  });
  await page.waitForFunction(
    () =>
      (window as any).composerUI.commands.filter(
        (c: any) => c.type === "upload_attachment",
      ).length === 2,
  );
  let snapshot = await state();
  assert.equal(
    snapshot.status,
    "idle",
    "uploads must not create a phantom running turn",
  );
  assert(snapshot.sending);
  assert(
    await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
  );
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    const [one, two] = a.commands.filter(
      (c: any) => c.type === "upload_attachment",
    );
    a.c.noteAttachmentUploaded(
      undefined,
      { id: "foreign", name: "same.txt" },
      "session-a",
    );
    a.c.noteAttachmentUploaded(
      one.requestId,
      { id: "wrong-session", name: "same.txt" },
      "other",
    );
    a.c.noteAttachmentUploaded(
      two.requestId,
      { id: "second", name: "same.txt" },
      "session-a",
    );
  });
  snapshot = await state();
  assert.equal(snapshot.pending[0].serverId, undefined);
  assert.equal(snapshot.pending[1].serverId, "second");
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    const one = a.commands.find((c: any) => c.type === "upload_attachment");
    a.c.noteAttachmentUploaded(
      one.requestId,
      { id: "first", name: "same.txt" },
      "session-a",
    );
    await a.sendDone;
  });
  snapshot = await state();
  assert.deepEqual(
    snapshot.commands.find((c: any) => c.type === "prompt").attachmentIds,
    ["first", "second"],
  );
  assert.equal(snapshot.pending.length, 0);
  await reset();
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    await Promise.all([
      a.c.handleFiles(
        Array.from({ length: 20 }, (_, i) => new File(["a"], `a${i}.txt`)),
      ),
      a.c.handleFiles(
        Array.from({ length: 20 }, (_, i) => new File(["b"], `b${i}.txt`)),
      ),
    ]);
  });
  assert.equal(
    (await state()).pending.length,
    30,
    "concurrent drops must respect the 30-file cap",
  );
  await reset();
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    let release: any;
    const file = {
      name: "late.txt",
      size: 3,
      type: "text/plain",
      arrayBuffer: () => new Promise((r) => (release = r)),
    };
    const reading = a.c.handleFiles([file]);
    await new Promise((r) => setTimeout(r, 30));
    a.c.clearAttachments();
    release(new TextEncoder().encode("old").buffer);
    await reading;
  });
  assert.equal(
    (await state()).pending.length,
    0,
    "late file read must not resurrect cleared attachments",
  );
  await attach(["retry.txt"]);
  await page.locator("#rc-composer").fill("keep this");
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.sendDone = a.c.sendPrompt();
    a.setOnline(false);
  });
  await page.evaluate(async () => await (window as any).composerUI.sendDone);
  snapshot = await state();
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.text, "keep this");
  assert.equal(snapshot.sending, false);
  assert(
    !snapshot.commands.some((c: any) => c.type === "prompt"),
    "disconnection must not send or clear the draft",
  );
  await page.evaluate(() => (window as any).composerUI.setOnline(true));
  await reset();
  await page.locator("#rc-composer").fill("Look at @src");
  await page.waitForFunction(() =>
    (window as any).composerUI.commands.some(
      (c: any) => c.type === "search_files",
    ),
  );
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    const req = a.commands.filter((c: any) => c.type === "search_files").at(-1);
    a.c.mentions.noteMatches({
      type: "file_matches",
      requestId: req.requestId,
      files: ["src/My File.ts", "src/plain.ts"],
    });
  });
  await page.getByRole("option", { name: "src/My File.ts" }).click();
  assert.equal((await state()).text, 'Look at @"src/My File.ts" ');
  await page.locator("#rc-composer").fill("test@example.com");
  assert.equal(
    await page.getByRole("listbox", { name: "File mentions" }).count(),
    0,
  );
  await reset();
  await page.locator("#rc-composer").fill("IME draft");
  await page
    .locator("#rc-composer")
    .dispatchEvent("keydown", { key: "Enter", isComposing: true });
  assert(
    !(await state()).commands.some((c: any) => c.type === "prompt"),
    "composition Enter sent a prompt",
  );
  await page.locator("#rc-composer").fill("/jail");
  await page.locator("#rc-composer").press("Enter");
  snapshot = await state();
  assert.equal(snapshot.status, "idle", "slash command left a phantom turn");
  assert(
    snapshot.commands.some(
      (c: any) => c.type === "prompt" && c.text === "/jail",
    ),
  );
  // Preview responses are broadcast; only the current request may open a modal.
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.review.openStoredPreview("session-a", "one");
    a.review.openStoredPreview("session-a", "two");
    const [one, two] = a.commands.filter(
      (c: any) => c.type === "get_attachment",
    );
    a.review.noteAttachmentData({
      type: "attachment_data",
      requestId: one.requestId,
      sessionId: "session-a",
      attachment: {
        id: "one",
        name: "one",
        mime: "text/plain",
        data: btoa("one"),
      },
    });
    a.oldPreview = a.review.previewFile();
    a.review.noteAttachmentData({
      type: "attachment_data",
      requestId: two.requestId,
      sessionId: "session-a",
      attachment: {
        id: "two",
        name: "two",
        mime: "text/plain",
        data: btoa("two"),
      },
    });
  });
  assert.equal(
    await page.evaluate(() => (window as any).composerUI.oldPreview),
    null,
  );
  assert.equal(
    await page.evaluate(
      () => (window as any).composerUI.review.previewFile().text,
    ),
    "two",
  );
  // Raw tool-result envelopes shift displayed indices. Editing uses raw indices.
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.t.applySnapshot("session-a", {
      status: "idle",
      messages: [
        { role: "user", content: [{ text: "first" }] },
        {
          role: "assistant",
          content: [{ id: "read", name: "read", arguments: {} }],
        },
        {
          role: "tool",
          content: [{ call_id: "read", content: [{ text: "result" }] }],
        },
        {
          role: "user",
          content: [{ text: "expanded document" }],
          meta: {
            user_text: "original",
            attachments: JSON.stringify([
              { id: "image", name: "image.png", mime: "image/png", size: 12 },
            ]),
          },
        },
        { role: "assistant", content: [{ text: "answer" }] },
      ],
    });
    a.t.startEditMsg(3, a.t.messages().find((m: any) => m.srcIdx === 3));
  });
  assert.equal(
    await page.evaluate(
      () => (window as any).composerUI.t.editingAttachments()[0]?.id,
    ),
    "image",
  );
  assert.equal(
    await page.evaluate(() => {
      const t = (window as any).composerUI.t;
      return t.blockRawIdx(
        t
          .renderBlocks()
          .find((b: any) => b.msg.role === "user" && b.msg.srcIdx === 3),
      );
    }),
    3,
  );
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    const m = a.t.messages().find((m: any) => m.srcIdx === 3);
    a.t.startEditMsg(3, m);
    a.t.updateEditingMsgText("new text");
    await a.t.saveEditMsg(
      3,
      m,
      () => "m",
      () => true,
    );
  });
  snapshot = await state();
  assert.deepEqual(
    snapshot.commands.find((c: any) => c.type === "edit_message").attachmentIds,
    ["image"],
  );
  assert.equal(
    snapshot.commands.find((c: any) => c.type === "edit_message").index,
    3,
  );
  // Edit removal and replacement use an independent upload queue.
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    a.t.setSessionStatus("idle");
    const m = a.t.messages().find((m: any) => m.srcIdx === 3);
    a.t.startEditMsg(3, m);
    a.t.setEditingAttachments([]);
    await a.t.editAttachments.handleFiles([
      new File(["replacement"], "replacement.txt"),
    ]);
    a.editDone = a.t.saveEditMsg(
      3,
      m,
      () => "m",
      () => true,
    );
  });
  await page.waitForFunction(() =>
    (window as any).composerUI.commands.some(
      (c: any) =>
        c.type === "upload_attachment" && c.name === "replacement.txt",
    ),
  );
  await page.evaluate(async () => {
    const a = (window as any).composerUI;
    const upload = a.commands.find(
      (c: any) =>
        c.type === "upload_attachment" && c.name === "replacement.txt",
    );
    a.t.editAttachments.noteAttachmentUploaded(
      upload.requestId,
      { id: "replacement", name: "replacement.txt" },
      "session-a",
    );
    await a.editDone;
  });
  snapshot = await state();
  assert.deepEqual(
    snapshot.commands.filter((c: any) => c.type === "edit_message").at(-1)
      .attachmentIds,
    ["replacement"],
  );
  await reset();
  await page.locator("#rc-composer").fill("/co");
  await page.locator("#rc-composer").press("Escape");
  assert.equal(
    await page.getByText("Slash Commands", { exact: true }).count(),
    0,
    "Escape must dismiss slash suggestions",
  );
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.review.openStoredPreview("session-a", "late");
    a.review.setPreviewFile(null);
    const req = a.commands
      .filter((c: any) => c.type === "get_attachment")
      .at(-1);
    a.review.noteAttachmentData({
      type: "attachment_data",
      requestId: req.requestId,
      sessionId: "session-a",
      attachment: {
        id: "late",
        name: "late",
        mime: "text/plain",
        data: btoa("late"),
      },
    });
  });
  assert.equal(
    await page.evaluate(() => (window as any).composerUI.review.previewFile()),
    null,
    "closing preview must cancel its late response",
  );
  // Empty edits, retained attachment choices and active editor restore locally.
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.rawEdit = {status:"idle", messages:[{role:"user",content:[{text:"Original"}],meta:{attachments:JSON.stringify([{id:"keep",name:"keep.txt"},{id:"remove",name:"remove.txt"}])}}]};
    a.t.applySnapshot("session-a", a.rawEdit);
    a.t.startEditMsg(0, a.t.messages()[0]);
    a.t.updateEditingMsgText("");
    a.t.setEditingAttachments(a.t.editingAttachments().filter((f:any) => f.id === "keep"));
  });
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.t.resetForSession();
    a.t.applySnapshot("session-a", a.rawEdit);
  });
  assert.deepEqual(await page.evaluate(() => {
    const t = (window as any).composerUI.t;
    return [t.editingMsgIdx(), t.editingMsgText(), t.editingAttachments().map((f:any) => f.id)];
  }), [0,"",["keep"]]);
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.t.resetForSession();a.setHost("host-b");a.t.applySnapshot("session-a", a.rawEdit);
    a.t.startEditMsg(0, a.t.messages()[0]);
  });
  assert.equal(await page.evaluate(() => (window as any).composerUI.t.editingMsgText()), "Original", "same session index on another host must not inherit edits");
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.t.cancelEditMsg();a.t.resetForSession();a.setHost("host-a");a.t.applySnapshot("session-a", a.rawEdit);
    a.choose = () => new Promise(resolve => a.resolveChoice = resolve);
    a.editDone = a.t.saveEditMsg(0,a.t.messages()[0],()=>"m",()=>true);
    a.beforeChoiceCommands = a.commands.filter((c:any) => c.type === "edit_message").length;
    a.setHost("host-b");
  });
  await page.evaluate(async () => {const a=(window as any).composerUI; a.resolveChoice("resend"); await a.editDone;});
  assert(await page.evaluate(() => {const a=(window as any).composerUI;return a.commands.filter((c:any)=>c.type === "edit_message").length === a.beforeChoiceCommands;}), "host switch invalidates a pending edit confirmation");
  await page.evaluate(() => {
    const a = (window as any).composerUI;
    a.t.resetForSession();a.setHost("host-a");
    a.t.applySnapshot("session-a",{status:"idle",messages:[{role:"user",content:[{text:"Different message at the same index"}]}]});
  });
  assert.equal(await page.evaluate(() => (window as any).composerUI.t.editingMsgIdx()),null,"stale drafts do not reopen on a replaced message");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: duplicate names, upload correlation, caps, late reads, offline retry, mentions, IME, commands, previews, raw edit indices and attachment retention",
  );
} finally {
  await browser.close();
  server.stop(true);
}
