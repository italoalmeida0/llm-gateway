import { describe, expect, test } from "bun:test";
import { compactTokens, contextDisplay } from "../web/src/rcContext";
import { createTranscriptScroll } from "../web/src/rcScroll";
import { displayToolArgs, withoutTodoActivity } from "../web/src/rcLive";
import { absoluteRemotePath, projectForDirectory } from "../web/src/rcPaths";
import type { ChatMessage } from "../web/src/pages/RemoteCode";
import { fileIcon } from "../web/src/rcFiles";

describe("Remote Code file presentation", () => {
  test("shows absolute tool paths resolved against the remote working directory", () => {
    expect(absoluteRemotePath("src/../main.ts", "/home/user/TAP")).toBe("/home/user/TAP/main.ts");
    expect(absoluteRemotePath("/etc/config", "/home/user/TAP")).toBe("/etc/config");
    expect(absoluteRemotePath("src\\main.ts", "C:\\work\\TAP")).toBe("C:\\work\\TAP\\src\\main.ts");
    expect(absoluteRemotePath("../../config", "C:\\work")).toBe("C:\\config");
  });
  test("decodes partial tool content without leaking incomplete JSON escapes", () => {
    expect(displayToolArgs('{"path":"src/example.py","content":"print(\\"hello\\")\\nnext\\u00').content).toBe('print("hello")\nnext');
    expect(displayToolArgs('{"path":"src/example.py","content":"hello\\').content).toBe("hello");
    expect(displayToolArgs('{"path":"example.py","edits":[{"oldText":"old","newText":"new').edits).toEqual([{oldText:"old",newText:"new"}]);
    expect(displayToolArgs('null')).toEqual({});
  });
  test("supports language, document and project-specific filenames on both path styles", () => {
    expect(fileIcon("C:\\project\\main.cpp").icon).toBe("mdi:language-cpp");
    expect(fileIcon("component.tsx").icon).toBe("mdi:react");
    expect(fileIcon("main.kt").icon).toBe("mdi:language-kotlin");
    expect(fileIcon("report.pdf").icon).toBe("mdi:file-pdf-box");
    expect(fileIcon("Dockerfile.dev").icon).toBe("mdi:docker");
    expect(fileIcon(".env.local").icon).toBe("mdi:file-key");
    expect(fileIcon("api.spec.ts").icon).toBe("mdi:test-tube");
  });
});

test("nested projects own their sessions exclusively, with path boundaries", () => {
  const projects = [{id:"home",path:"/home/user/"}, {id:"tap",path:"/home/user/TAP"}];
  expect(projectForDirectory("/home/user/TAP/src", projects)?.id).toBe("tap");
  expect(projectForDirectory("/home/user/TAP-other", projects)?.id).toBe("home");
  expect(projectForDirectory("/home/user", projects)?.id).toBe("home");
  expect(projectForDirectory("/tmp/work", projects)).toBeUndefined();
  expect(projectForDirectory("/tmp", [{id:"root",path:"/"}])?.id).toBe("root");
  expect(projectForDirectory("C:\\work\\TAP\\src", [{id:"windows",path:"c:/work/tap/"}])?.id).toBe("windows");
});

test("hides checklist calls and results while preserving text, other tools and source indices", () => {
  const messages: ChatMessage[] = [
    {id:"mixed",role:"assistant",srcIdx:1,blocks:[{type:"text",text:"Progress"},{type:"tool_call",toolId:"todo1",toolName:"todo"},{type:"tool_call",toolId:"read",toolName:"read"}]},
    {id:"results",role:"tool",srcIdx:2,blocks:[{type:"tool_result",toolId:"todo1",toolResult:"[]"},{type:"tool_result",toolId:"read",toolResult:"content"}]},
    {id:"hidden",role:"assistant",srcIdx:3,blocks:[{type:"tool_call",toolId:"todo2",toolName:"todo"},{type:"tool_result",toolId:"todo2"}]},
    {id:"loading",role:"assistant",srcIdx:4,blocks:[]},
  ];
  const visible = withoutTodoActivity(messages);
  expect(visible.map((m) => m.srcIdx)).toEqual([1,2,4]);
  expect(visible[0].blocks.map((b) => b.type)).toEqual(["text","tool_call"]);
  expect(visible[1].blocks[0].toolId).toBe("read");
  expect(messages[0].blocks).toHaveLength(3);
});

describe("Remote Code context", () => {
  test("uses configured gateway limits and keeps context separate from cumulative usage", () => {
    const context = { usedTokens: 432500, windowTokens: 200000, model: "custom/alias", estimated: false };
    expect(contextDisplay(context, { id: context.model, name: "Alias", limit: { context: 1024000 } }).label).toBe("432.5K (42%)");
    expect(contextDisplay(context, { id: context.model, name: "Alias", limit: {} }).percent).toBeNull();
    expect(contextDisplay(null).label).toBe("Context —");
    expect(compactTokens(128000)).toBe("128K");
  });
});

describe("Remote Code transcript following", () => {
  function harness() {
    let callback: FrameRequestCallback | undefined;
    let running = true;
    let bottom = true;
    let frames = 0;
    const el = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };
    const scroll = createTranscriptScroll({ element: () => el, running: () => running,
      atBottom: (value) => { bottom = value; },
      frame: (cb) => { callback = cb; frames++; return frames; },
      cancelFrame: () => { callback = undefined; },
    });
    scroll.measure();
    return { el, scroll, run: (v: boolean) => { running = v; }, bottom: () => bottom,
      frames: () => frames, flush: () => { const cb = callback; callback = undefined; cb?.(0); } };
  }

  test("coalesces long streaming updates and reads the final height once per frame", () => {
    const h = harness();
    for (let i = 0; i < 100; i++) { h.el.scrollHeight += 200; h.scroll.schedule(); }
    expect(h.frames()).toBe(1);
    h.flush();
    expect(h.el.scrollTop).toBe(20600);
  });
  test("scrolling up cancels an already scheduled follow", () => {
    const h = harness();
    h.el.scrollHeight = 4000;
    h.scroll.schedule();
    h.scroll.detach();
    h.el.scrollTop = 200;
    h.scroll.measure();
    h.flush();
    expect(h.el.scrollTop).toBe(200);
    expect(h.bottom()).toBe(false);
  });
  test("idle layout changes and queued streaming frames never move the reader", () => {
    const h = harness();
    h.el.scrollHeight = 4000;
    h.scroll.schedule();
    h.run(false);
    h.flush();
    h.scroll.schedule();
    expect(h.el.scrollTop).toBe(600);
    expect(h.frames()).toBe(1);
    h.scroll.schedule(true); // explicit jump remains available outside a task
    h.flush();
    expect(h.el.scrollTop).toBe(3600);
  });
  test("a session switch cancels callbacks belonging to the previous transcript", () => {
    const h = harness();
    h.scroll.schedule(true);
    h.scroll.reset();
    h.el.scrollHeight = 10000;
    h.flush();
    expect(h.el.scrollTop).toBe(600);
  });
});
