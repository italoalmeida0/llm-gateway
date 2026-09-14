import { describe, expect, test } from "bun:test";
import {
  activeMention,
  insertMention,
  slashCommand,
} from "../web/src/indirect-code/utils/composerTokens";
import { normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";
import { sniffFile } from "../web/src/office";

describe("composer tokens and attachments", () => {
  test("mentions preserve surrounding text, spaces and mid-message insertion", () => {
    const text = "Inspect @src and explain";
    const token = activeMention(text, 12)!;
    expect(token.query).toBe("src");
    expect(insertMention(text, token, "src/My File.ts")).toEqual({
      text: 'Inspect @"src/My File.ts" and explain',
      caret: 25,
    });
    expect(activeMention("Contact test@example.com", 24)).toBeNull();
    expect(activeMention('Read @"My File', 14)?.query).toBe("My File");
    expect(activeMention('Read @"My File" ', 16)).toBeNull();
  });
  test("command recognition does not consume absolute paths or unknown prompt words", () => {
    expect(slashCommand("/compact\n")).toBe("/compact");
    expect(slashCommand("/MODEL\tcustom")).toBe("/model");
    for (const prompt of [
      "/home/user/project",
      "/jail.ts",
      "/custom analyze this",
    ])
      expect(slashCommand(prompt)).toBeUndefined();
  });
  test("attachments reload by ID while generated context stays out of the user's text", () => {
    const attachments = [
      { id: "one", name: "same.png", mime: "image/png", size: 12 },
      { id: "two", name: "same.png", mime: "image/png", size: 12 },
    ];
    const [message] = normalizeSessionMessages([
      {
        role: "user",
        content: [{ text: "generated file content" }],
        meta: { user_text: "", attachments: JSON.stringify(attachments) },
      },
    ]);
    expect(message.attachments).toEqual(attachments);
    expect(message.blocks).toEqual([{ type: "text", text: "" }]);
    expect(
      normalizeSessionMessages([
        {
          role: "user",
          content: [{ text: "old" }],
          meta: { attachments: "malformed" },
        },
      ])[0].attachments,
    ).toEqual([]);
  });
  test("sniffed images retain their MIME even if the browser does not supply it", () => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
      ),
      (c) => c.charCodeAt(0),
    );
    expect(sniffFile(new File([bytes], "photo"), bytes)).toMatchObject({
      kind: "image",
      mime: "image/png",
    });
  });
  test("empty text is supported, binary garbage and unsupported formats are rejected", () => {
    expect(sniffFile(new File([], "empty.txt"), new Uint8Array())).toEqual({
      kind: "text",
    });
    expect(
      sniffFile(new File([], "unknown"), new Uint8Array([0, 255])).blocked,
    ).toBeTruthy();
    expect(
      sniffFile(new File([], "sheet.xlsx"), new Uint8Array()).blocked,
    ).toContain("PDF, CSV or text");
    expect(
      sniffFile(
        new File([], "vector.svg", { type: "image/svg+xml" }),
        new TextEncoder().encode("<svg/>"),
      ).blocked,
    ).toContain("PNG, JPEG, GIF or WebP");
  });
});
