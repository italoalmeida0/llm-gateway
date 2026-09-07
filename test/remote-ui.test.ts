import { describe, expect, test } from "bun:test";
import { compactTokens, contextDisplay } from "../web/src/remote-code/context";
import { createTranscriptScroll } from "../web/src/remote-code/scroll";
import { displayToolArgs, withoutTodoActivity } from "../web/src/remote-code/live";
import { absoluteRemotePath, projectForDirectory, projectsByActivity } from "../web/src/remote-code/paths";
import { buildRenderBlocks, terminalPresentation, toolSummary } from "../web/src/remote-code/transcript";
import { partitionToolSegs } from "../web/src/remote-code/utils/toolSegs";
import type { ChatMessage, ToolUnit } from "../web/src/remote-code/types";
import { fileIcon } from "../web/src/remote-code/files";

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

test("Home groups unassigned conversations and expands host home aliases", () => {
  const projects = [{id:"home",path:"/home/user",protected:true}, {id:"work",path:"/home/user/work"}];
  for (const cwd of ["", "~", "/home/user", "/home/user/", "/tmp/unregistered"]) expect(projectForDirectory(cwd, projects)?.id).toBe("home");
  expect(projectForDirectory("~/work/src", projects)?.id).toBe("work");
});

test("orders projects by their own conversations' most recent activity", () => {
  const projects = [{id:"home",path:"/home",createdAt:1},{id:"first",path:"/home/first",createdAt:10},{id:"second",path:"/home/second",createdAt:20}];
  const ordered = projectsByActivity(projects,[{cwd:"/home/first",updatedAt:300},{cwd:"/home/second",updatedAt:100}]);
  expect(ordered.map((p) => p.id)).toEqual(["first","second","home"]);
});

test("groups tools and thinking until non-whitespace assistant text intervenes", () => {
  const list:ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,thinkingDuration:3,blocks:[{type:"reasoning",reasoning:"Inspect"},{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,thinkingDuration:1,blocks:[{type:"text",text:" \n "},{type:"reasoning",reasoning:"Verify"},{type:"tool_call",toolId:"b",toolName:"bash"}]},
    {id:"three",role:"assistant",srcIdx:5,blocks:[{type:"text",text:"I found an issue."},{type:"tool_call",toolId:"c",toolName:"edit"}]},
    {id:"four",role:"assistant",srcIdx:7,blocks:[{type:"reasoning",reasoning:"Testing"},{type:"tool_call",toolId:"d",toolName:"bash"}]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks).toHaveLength(2);
  expect(blocks[0].kind === "series" && blocks[0].units.map((u) => u.call?.toolId)).toEqual(["a","b"]);
  expect(blocks[1].kind === "series" && blocks[1].extras[0].thinkingDuration).toBeUndefined();
  expect(blocks[1].msg.srcIdx).toBe(5);
  expect(list[1].blocks).toHaveLength(3);
});

test("terminal footer becomes a duration without removing real output", () => {
  expect(terminalPresentation("$ printf hello\n\nhello\n\n[exit 0]  Took 2.5s")).toEqual({output:"$ printf hello\n\nhello",durationMs:2500});
  expect(terminalPresentation("output\n[exit 1] (full output: /tmp/output.log)  Took 1h2m")).toEqual({output:"output\n\nFull output: /tmp/output.log",durationMs:3720000});
  expect(terminalPresentation("The command printed [exit 0] as its output").output).toBe("The command printed [exit 0] as its output");
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

describe("Remote Code toolSummary", () => {
  test("defensively handles question tool arguments of any shape", () => {
    // Array of objects with header
    expect(toolSummary({
      call: { type: "tool_call", toolId: "1", toolName: "question", toolArgs: JSON.stringify({ questions: [{ header: "Confirmation", question: "Proceed?" }] }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Confirmation" });

    // Completed question shows "Asked"
    expect(toolSummary({
      call: { type: "tool_call", toolId: "1", toolName: "question", toolArgs: JSON.stringify({ questions: [{ header: "Confirmation", question: "Proceed?" }] }) },
      result: { type: "tool_result", toolId: "1", toolResult: "yes" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asked", target: "Confirmation" });

    // String questions field (caused the previous TypeError: (n.questions || []).map is not a function)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "2", toolName: "question", toolArgs: JSON.stringify({ questions: "How should I structure this?" }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "How should I structure this?" });

    // Singular question field as string
    expect(toolSummary({
      call: { type: "tool_call", toolId: "3", toolName: "question", toolArgs: JSON.stringify({ question: "Do you agree?" }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Do you agree?" });

    // Single object (not array)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "4", toolName: "question", toolArgs: JSON.stringify({ questions: { header: "Design", question: "Pick one" } }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Design" });

    // Array of strings
    expect(toolSummary({
      call: { type: "tool_call", toolId: "5", toolName: "question", toolArgs: JSON.stringify({ questions: ["First choice", "Second choice"] }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "First choice · Second choice" });

    // Array of objects without header (uses question text)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "6", toolName: "question", toolArgs: JSON.stringify({ questions: [{ question: "Is this correct?" }] }) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Is this correct?" });

    // Stringified JSON questions field (parses inner JSON and extracts header)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "10", toolName: "question", toolArgs: JSON.stringify({ questions: JSON.stringify([{ header: "Ficheiro", question: "Qual arquivo?", options: [] }]) }) },
      result: { type: "tool_result", toolId: "10", toolResult: "ok" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asked", target: "Ficheiro" });

    // Truncated / malformed inner JSON string falls back cleanly to "Questions" (never raw JSON)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "11", toolName: "question", toolArgs: JSON.stringify({ questions: '[{"header": "Ficheiro", "options": [{"label": ' }) },
      result: { type: "tool_result", toolId: "11", toolResult: "ok" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asked", target: "Questions" });

    // Top-level array of questions
    expect(toolSummary({
      call: { type: "tool_call", toolId: "12", toolName: "question", toolArgs: JSON.stringify([{ header: "Destino", question: "Qual pasta?" }]) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Destino" });

    // Empty or malformed arguments
    expect(toolSummary({
      call: { type: "tool_call", toolId: "7", toolName: "question", toolArgs: "{}" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Questions" });

    expect(toolSummary({
      call: { type: "tool_call", toolId: "8", toolName: "question", toolArgs: "invalid json {" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Questions" });

    expect(toolSummary({
      call: { type: "tool_call", toolId: "9", toolName: "question" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Questions" });
  });
  test("summarizes python code and script calls", () => {
    // Code mode shows the first meaningful line (skips blanks/comments).
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p1", toolName: "python", toolArgs: JSON.stringify({ code: "# calc\n\nprint(sum(range(10)))" }) }
    })).toEqual({ icon: "mdi:language-python", verb: "Run", target: "print(sum(range(10)))" });
    // Script mode shows the file plus CLI args.
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p2", toolName: "python", toolArgs: JSON.stringify({ script: "scripts/seed.py", args: ["--dry"] }) }
    })).toEqual({ icon: "mdi:language-python", verb: "Run", target: "seed.py --dry" });
    // Empty code falls back to a clean placeholder (never blank).
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p3", toolName: "python", toolArgs: "{}" }
    })).toEqual({ icon: "mdi:language-python", verb: "Run", target: "snippet" });
    // Exit footers parse for duration, same as bash.
    expect(terminalPresentation("ok\n[exit 0]  Took 0.1s")).toEqual({ output: "ok", durationMs: 100 });
  });
  test("summarizes search/inspect/patch/git calls", () => {
    expect(toolSummary({
      call: { type: "tool_call", toolId: "s1", toolName: "search", toolArgs: JSON.stringify({ pattern: "from \"../", path: "web/src" }) }
    })).toEqual({ icon: "lucide:search", verb: "Search", target: "from \"../ in src" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "s2", toolName: "search", toolArgs: JSON.stringify({ pattern: "foo\\d", isRegex: true }) }
    })).toEqual({ icon: "lucide:search", verb: "Regex search", target: "foo\\d" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "i1", toolName: "inspect", toolArgs: JSON.stringify({ path: "server/routes" }) }
    })).toEqual({ icon: "lucide:folder-tree", verb: "Inspect", target: "server/routes" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "i2", toolName: "inspect", toolArgs: "{}" }
    })).toEqual({ icon: "lucide:folder-tree", verb: "Inspect", target: "workspace" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p1", toolName: "patch", toolArgs: JSON.stringify({ edits: [{ file: "a.ts", old: "x", new: "y" }, { file: "b.ts", old: "1", new: "2" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Preview patch", target: "a.ts, b.ts" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p2", toolName: "patch", toolArgs: JSON.stringify({ dryRun: false, edits: [{ file: "a.ts", old: "x", new: "y" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Patch", target: "a.ts" });
  });
  test("summarizes search_web and fetch_url calls", () => {
    expect(toolSummary({
      call: { type: "tool_call", toolId: "w1", toolName: "search_web", toolArgs: JSON.stringify({ query: "golang html parser" }) }
    })).toEqual({ icon: "lucide:globe", verb: "Web search", target: "golang html parser" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "w2", toolName: "fetch_url", toolArgs: JSON.stringify({ url: "https://www.example.com/post?q=1" }) }
    })).toEqual({ icon: "lucide:link", verb: "Fetch", target: "example.com" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "w3", toolName: "fetch_url", toolArgs: "{}" }
    })).toEqual({ icon: "lucide:link", verb: "Fetch", target: "url" });
  });
});


describe("Remote Code tool segments", () => {
  const unit = (name: string, id: string): ToolUnit => ({
    call: { type: "tool_call", toolId: id, toolName: name, toolArgs: "{}" },
  });
  test("groups consecutive explore/command runs of 2+, keeps singles flat", () => {
    const segs = partitionToolSegs([unit("read", "a"), unit("glob", "b"), unit("edit", "c"), unit("bash", "d")]);
    expect(segs.length).toBe(3);
    expect(segs[0]).toEqual({ kind: "group", cat: "explore", units: [unit("read", "a"), unit("glob", "b")] });
    expect(segs[1]).toEqual({ kind: "unit", unit: unit("edit", "c"), idx: 2 });
    expect(segs[2]).toEqual({ kind: "unit", unit: unit("bash", "d"), idx: 3 });
  });
  test("splits on category change and non-groupable tools", () => {
    const segs = partitionToolSegs([unit("bash", "a"), unit("bash", "b"), unit("read", "c"), unit("read", "d"), unit("read", "e")]);
    expect(segs.length).toBe(2);
    expect(segs[0]).toEqual({ kind: "group", cat: "command", units: [unit("bash", "a"), unit("bash", "b")] });
    expect(segs[1]).toEqual({ kind: "group", cat: "explore", units: [unit("read", "c"), unit("read", "d"), unit("read", "e")] });
  });
  test("empty input yields no segments", () => {
    expect(partitionToolSegs([])).toEqual([]);
  });
});
