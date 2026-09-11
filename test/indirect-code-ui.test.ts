import { describe, expect, test } from "bun:test";
import { compactTokens, contextDisplay, groupModelsByProvider } from "../web/src/indirect-code/context";
import { createTranscriptScroll } from "../web/src/indirect-code/scroll";
import {
  displayToolArgs,
  withoutTodoActivity,
  withoutContinueNudges,
  CONTINUE_NUDGE_TEXT,
  COMPLETION_NUDGE_BUILD,
  COMPLETION_NUDGE_PLAN,
} from "../web/src/indirect-code/live";
import { absoluteRemotePath, collapseCwd, projectForDirectory, projectsByActivity } from "../web/src/indirect-code/paths";
import {
  buildRenderBlocks, isTurnStartMessage, mapBalloonsToBlocks, terminalPresentation, toolSummary,
} from "../web/src/indirect-code/transcript";
import { partitionToolSegs } from "../web/src/indirect-code/utils/toolSegs";
import { parseGlobList, parseInspectTree, parseQuestionQA } from "../web/src/indirect-code/utils/toolTrees";
import { parseDaemonMessage } from "../web/src/indirect-code/daemon-protocol";
import { parseContentBlocks } from "../web/src/indirect-code/utils/wire";
import {
  appendReasoningDelta, appendTextDelta, appendToolArgsDelta, appendToolResult,
  cutTail, finishTurn, mergeUsage, normalizeSessionMessages, upsertToolCall,
} from "../web/src/indirect-code/transcript/updaters";
import type { ChatMessage, ToolUnit, TurnBalloon } from "../web/src/indirect-code/types";
import { fileIcon } from "../web/src/indirect-code/files";

describe("Indirect Code file presentation", () => {
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

test("fuses all intermediate tool messages and thoughts into one series when hideToolMessages is true", () => {
  const list: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,thinkingDuration:3,blocks:[{type:"reasoning",reasoning:"Inspect"},{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,thinkingDuration:1,blocks:[{type:"text",text:"Checking file"},{type:"reasoning",reasoning:"Verify"},{type:"tool_call",toolId:"b",toolName:"bash"}]},
    {id:"three",role:"assistant",srcIdx:5,blocks:[{type:"text",text:"I found an issue."},{type:"tool_call",toolId:"c",toolName:"edit"}]},
    {id:"four",role:"assistant",srcIdx:7,blocks:[{type:"reasoning",reasoning:"Testing"},{type:"tool_call",toolId:"d",toolName:"bash"}]},
    {id:"five",role:"assistant",srcIdx:9,blocks:[{type:"text",text:"All issues resolved."}]},
  ];
  const blocks = buildRenderBlocks(list, { hideToolMessages: true });
  expect(blocks).toHaveLength(2);
  expect(blocks[0].kind).toBe("series");
  if (blocks[0].kind === "series") {
    expect(blocks[0].units.map((u) => u.call?.toolId)).toEqual(["a","b","c","d"]);
    expect(blocks[0].extras.map((m) => m.id)).toEqual(["two","three","four"]);
  }
  expect(blocks[1].kind).toBe("single");
  if (blocks[1].kind === "single") {
    expect(blocks[1].msg.id).toBe("five");
  }
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

describe("Indirect Code context", () => {
  test("uses configured gateway limits and keeps context separate from cumulative usage", () => {
    const context = { usedTokens: 432500, windowTokens: 200000, model: "custom/alias", estimated: false };
    expect(contextDisplay(context, { id: context.model, name: "Alias", provider: "Test", upstreamModel: "alias", context: 1024000, output: 65536 }).label).toBe("432.5K (42%)");
    expect(contextDisplay(context, { id: context.model, name: "Alias", provider: "", upstreamModel: "", context: 0, output: 0 }).percent).toBeNull();
    expect(contextDisplay(null).label).toBe("Context —");
    expect(compactTokens(128000)).toBe("128K");
    expect(compactTokens(1000000)).toBe("1M");
  });

  test("skips encrypted-only thinking blobs (replay-only, nothing to display)", () => {
    const blocks = parseContentBlocks({
      role: "assistant",
      content: [
        { summary: "", encrypted_content: "Q-PaDgFwOh2" },
        { text: "Entendido" },
        { summary: "Checking files", encrypted_content: "" },
      ],
    });
    expect(blocks.filter((b) => b.type === "reasoning").map((b: any) => b.reasoning)).toEqual([
      "Checking files",
    ]);
    expect(blocks.some((b) => b.type === "text")).toBe(true);
  });

  test("groups models by provider in first-appearance order", () => {
    const mk = (id: string, provider: string) => ({
      id, name: id, provider, upstreamModel: id, context: 256000, output: 65536,
    });
    const groups = groupModelsByProvider([
      mk("a", "Anthropic"), mk("b", "OpenAI"), mk("c", "Anthropic"), mk("d", ""),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["Anthropic", "OpenAI", "Other"]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["a", "c"]);
    expect(groups[1]!.models.map((m) => m.id)).toEqual(["b"]);
    expect(groupModelsByProvider([])).toEqual([]);
  });
});

describe("Indirect Code transcript following", () => {
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
  test("measure is report-only: sitting at the bottom never re-pins", () => {
    const h = harness();
    h.scroll.detach();
    h.el.scrollTop = 600; // back at the bottom by hand (600 = 1000-400)
    h.scroll.measure();
    expect(h.bottom()).toBe(true);
    h.el.scrollHeight = 4000; // new content arrives while unpinned
    h.flush(); // any stale queued frame must be a no-op
    h.scroll.measure();
    expect(h.el.scrollTop).toBe(600);
    expect(h.bottom()).toBe(false);
  });
  test("pin() jumps to the tail and follows again", () => {
    const h = harness();
    h.scroll.detach();
    h.el.scrollHeight = 4000;
    h.scroll.pin();
    h.flush();
    expect(h.el.scrollTop).toBe(3600);
    expect(h.bottom()).toBe(true);
    h.el.scrollHeight += 200;
    h.scroll.schedule(); // streaming keeps following after an explicit pin
    h.flush();
    expect(h.el.scrollTop).toBe(3800);
  });
  test("detach() cancels an explicit jump queued before the gesture", () => {
    const h = harness();
    h.scroll.pin();
    h.scroll.detach();
    h.flush();
    expect(h.el.scrollTop).toBe(600);
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

describe("Indirect Code toolSummary", () => {
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
      call: { type: "tool_call", toolId: "10", toolName: "question", toolArgs: JSON.stringify({ questions: JSON.stringify([{ header: "File", question: "Which file?", options: [] }]) }) },
      result: { type: "tool_result", toolId: "10", toolResult: "ok" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asked", target: "File" });

    // Truncated / malformed inner JSON string falls back cleanly to "Questions" (never raw JSON)
    expect(toolSummary({
      call: { type: "tool_call", toolId: "11", toolName: "question", toolArgs: JSON.stringify({ questions: '[{"header": "File", "options": [{"label": ' }) },
      result: { type: "tool_result", toolId: "11", toolResult: "ok" }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asked", target: "Questions" });

    // Top-level array of questions
    expect(toolSummary({
      call: { type: "tool_call", toolId: "12", toolName: "question", toolArgs: JSON.stringify([{ header: "Destination", question: "Which folder?" }]) }
    })).toEqual({ icon: "lucide:message-circle", verb: "Asking", target: "Destination" });

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
      call: { type: "tool_call", toolId: "s2", toolName: "search", toolArgs: JSON.stringify({ pattern: "foo\\d" }) }
    })).toEqual({ icon: "lucide:search", verb: "Search", target: "foo\\d" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "i1", toolName: "inspect", toolArgs: JSON.stringify({ path: "server/routes" }) }
    })).toEqual({ icon: "lucide:folder-tree", verb: "Inspect", target: "server/routes" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "i2", toolName: "inspect", toolArgs: "{}" }
    })).toEqual({ icon: "lucide:folder-tree", verb: "Inspect", target: "workspace" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p1", toolName: "patch", toolArgs: JSON.stringify({ dryRun: true, edits: [{ file: "a.ts", old: "x", new: "y" }, { file: "b.ts", old: "1", new: "2" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Preview patch", target: "a.ts, b.ts" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p2", toolName: "patch", toolArgs: JSON.stringify({ dryRun: false, edits: [{ file: "a.ts", old: "x", new: "y" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Patch", target: "a.ts" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "e1", toolName: "edit", toolArgs: JSON.stringify({ dryRun: true, edits: [{ file: "a.ts", old: "x", new: "y" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Preview edit", target: "a.ts" });
    expect(toolSummary({
      call: { type: "tool_call", toolId: "e2", toolName: "edit", toolArgs: JSON.stringify({ edits: [{ file: "a.ts", old: "x", new: "y" }] }) }
    })).toEqual({ icon: "lucide:file-diff", verb: "Edited", target: "a.ts" });
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


describe("Indirect Code tool segments", () => {
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

describe("Indirect Code transcript updaters", () => {
  const asst = (blocks: ChatMessage["blocks"], extra?: Partial<ChatMessage>): ChatMessage => ({
    id: "a1", role: "assistant", blocks, time: 0, ...extra,
  });
  test("appendTextDelta merges into trailing text or opens blocks", () => {
    expect(appendTextDelta([asst([{ type: "text", text: "hi" }])], "!")[0].blocks).toEqual([{ type: "text", text: "hi!" }]);
    const afterTool = appendTextDelta([asst([{ type: "tool_call", toolId: "t", toolName: "bash", toolArgs: "" }])], "x");
    expect(afterTool[0].blocks.length).toBe(2);
    expect(appendTextDelta([], "x")[0].role).toBe("assistant");
  });
  test("appendReasoningDelta merges panels and keeps them on top", () => {
    const merged = appendReasoningDelta(
      [asst([{ type: "text", text: "done" }, { type: "reasoning", reasoning: "a" }])], "b");
    expect(merged[0].blocks[0]).toEqual({ type: "reasoning", reasoning: "ab" });
    const fresh = appendReasoningDelta([asst([{ type: "text", text: "done" }])], "b");
    expect(fresh[0].blocks[0]).toEqual({ type: "reasoning", reasoning: "b" });
  });
  test("upsertToolCall finalizes pre-created cards, appends otherwise", () => {
    const pre = [asst([{ type: "tool_call", toolId: "t", toolName: "", toolArgs: "" }])];
    const done = upsertToolCall(pre, "t", "bash", { command: "ls" });
    expect(done[0].blocks[0].toolName).toBe("bash");
    expect(done[0].blocks[0].toolArgs).toContain("ls");
    const added = upsertToolCall([asst([{ type: "text", text: "x" }])], "u", "read", { path: "f" });
    expect(added[0].blocks.length).toBe(2);
    expect(appendToolArgsDelta(pre, "missing", "zzz")).toBe(pre);
  });
  test("appendToolResult carries duration only with startedAt", () => {
    const withStart = appendToolResult([], "t", "ok", false, 100, 5)[0].blocks[0];
    expect(withStart.toolDurationMs).toBe(5);
    const withoutStart = appendToolResult([], "t", "ok")[0].blocks[0];
    expect(withoutStart.toolDurationMs).toBeUndefined();
  });
  test("cutTail drops messages past the raw keep index", () => {
    const list = [asst([], { srcIdx: 1 }), asst([], { srcIdx: 3 }), asst([], { srcIdx: 5 })];
    expect(cutTail(list, 3).length).toBe(2);
    expect(cutTail(list, 9)).toBe(list);
  });
  test("mergeUsage keeps previous buckets when the payload omits them", () => {
    const prev = { s: { inTok: 1, outTok: 2, cacheTok: 3, reasoningTok: 4, costUsd: 5 } };
    const next = mergeUsage(prev, "s", { output_tokens: 9 }, null);
    expect(next.s).toEqual({ inTok: 1, outTok: 9, cacheTok: 0, reasoningTok: 4, costUsd: 5 });
    expect(mergeUsage(prev, "", {}, null)).toBe(prev);
  });
  test("normalizeSessionMessages hoists tool results and drops image mirrors", () => {
    const raw = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "bytes" }] },
    ];
    const out = normalizeSessionMessages(raw);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1].blocks.some((b) => b.type === "tool_result")).toBe(true);
    expect(out[1].srcIdx).toBe(1);
  });
  test("normalizeSessionMessages carries wire turnIndex as metadata", () => {
    const raw = [
      { role: "user", turnIndex: 7, content: [{ type: "text", text: "hi" }] },
      { role: "assistant", turnIndex: 7, content: [{ type: "text", text: "yo" }] },
      { role: "tool", turnIndex: 7, content: [{ type: "tool_result", tool_use_id: "t", content: "bytes" }] },
      { role: "user", content: [{ type: "text", text: "old" }] },
    ];
    const out = normalizeSessionMessages(raw);
    expect(out.map((m) => m.turnIndex)).toEqual([7, 7, undefined]);
  });
  test("finishTurn closes open turns, keeps the rest", () => {
    const open = finishTurn({ startedAt: 1, status: "running" });
    expect(open?.status).toBe("completed");
    expect(typeof open?.endedAt).toBe("number");
    expect(finishTurn({ startedAt: 1, endedAt: 2, status: "completed" })?.endedAt).toBe(2);
    expect(finishTurn(null)).toBeNull();
  });
});

describe("Indirect Code daemon protocol", () => {
  test("accepts envelopes with type or numeric id, rejects the rest", () => {
    expect(parseDaemonMessage({ type: "notice", message: "hi" })).toEqual({ type: "notice", message: "hi" });
    expect(parseDaemonMessage({ id: 7, hostId: "h", items: [] })).toEqual({ id: 7, hostId: "h", items: [] });
    expect(parseDaemonMessage(null)).toBeNull();
    expect(parseDaemonMessage("ping")).toBeNull();
    expect(parseDaemonMessage({})).toBeNull();
    expect(parseDaemonMessage([])).toBeNull();
  });
});

describe("Indirect Code turn balloons anchoring", () => {
  test("isTurnStartMessage identifies turn initiation correctly", () => {
    const defaultUser: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "hi" }] };
    expect(isTurnStartMessage(defaultUser)).toBe(true);

    const explicitStart: ChatMessage = { id: "u2", role: "user", blocks: [], isTurnStart: true };
    expect(isTurnStartMessage(explicitStart)).toBe(true);

    const midTurnUser: ChatMessage = { id: "u3", role: "user", blocks: [], midTurn: true };
    expect(isTurnStartMessage(midTurnUser)).toBe(false);

    const explicitNonStart: ChatMessage = { id: "u4", role: "user", blocks: [], isTurnStart: false };
    expect(isTurnStartMessage(explicitNonStart)).toBe(false);

    const asstMsg: ChatMessage = { id: "a1", role: "assistant", blocks: [] };
    expect(isTurnStartMessage(asstMsg)).toBe(false);

    const toolMsg: ChatMessage = { id: "t1", role: "tool", blocks: [] };
    expect(isTurnStartMessage(toolMsg)).toBe(false);
  });

  test("anchors turn 1 balloon to turn 1 last block and does not jump when turn 2 starts", () => {
    const user1: ChatMessage = { id: "user_1", role: "user", blocks: [{ type: "text", text: "turn 1 prompt" }] };
    const asst1: ChatMessage = { id: "asst_1", role: "assistant", blocks: [{ type: "text", text: "turn 1 response" }] };

    const blocks1 = buildRenderBlocks([user1, asst1]).map((b) => ({ ...b, id: b.msg.id }));
    const balloon1: TurnBalloon = { turnIndex: 1, files: [{ path: "fileA.ts", status: "modified" }] };

    // Turn 1 complete: balloon is on asst_1 (the last block of turn 1)
    const map1 = mapBalloonsToBlocks(blocks1, [balloon1]);
    expect(map1.get("user_1")).toBeUndefined();
    expect(map1.get("asst_1")?.map((b) => b.turnIndex)).toEqual([1]);

    // Turn 2 user prompt arrives: balloon 1 MUST stay anchored to asst_1 (above user_2)
    const user2: ChatMessage = { id: "user_2", role: "user", blocks: [{ type: "text", text: "turn 2 prompt" }] };
    const blocks2 = buildRenderBlocks([user1, asst1, user2]).map((b) => ({ ...b, id: b.msg.id }));

    const map2 = mapBalloonsToBlocks(blocks2, [balloon1]);
    expect(map2.get("asst_1")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(map2.get("user_2")).toBeUndefined();

    // Turn 2 finishes: balloon 2 is on asst_2 (the last block of turn 2)
    const asst2: ChatMessage = { id: "asst_2", role: "assistant", blocks: [{ type: "text", text: "turn 2 response" }] };
    const blocks3 = buildRenderBlocks([user1, asst1, user2, asst2]).map((b) => ({ ...b, id: b.msg.id }));
    const balloon2: TurnBalloon = { turnIndex: 2, files: [{ path: "fileB.ts", status: "new" }] };

    const map3 = mapBalloonsToBlocks(blocks3, [balloon1, balloon2]);
    expect(map3.get("asst_1")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(map3.get("asst_2")?.map((b) => b.turnIndex)).toEqual([2]);

    // Turn 3 begins: both balloons stay on their respective turns!
    const user3: ChatMessage = { id: "user_3", role: "user", blocks: [{ type: "text", text: "turn 3 prompt" }] };
    const blocks4 = buildRenderBlocks([user1, asst1, user2, asst2, user3]).map((b) => ({ ...b, id: b.msg.id }));

    const map4 = mapBalloonsToBlocks(blocks4, [balloon1, balloon2]);
    expect(map4.get("asst_1")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(map4.get("asst_2")?.map((b) => b.turnIndex)).toEqual([2]);
    expect(map4.get("user_3")).toBeUndefined();
  });

  test("anchors balloons correctly when a turn has multiple assistant blocks or series", () => {
    const user1: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "p1" }] };
    const tool1: ChatMessage = { id: "t1", role: "assistant", blocks: [{ type: "tool_call", toolId: "call1", toolName: "bash" }] };
    const text1: ChatMessage = { id: "a1", role: "assistant", blocks: [{ type: "text", text: "done" }] };

    const blocks = buildRenderBlocks([user1, tool1, text1]).map((b) => ({ ...b, id: b.msg.id }));
    expect(blocks.length).toBe(3); // user1, tool1 (series), text1 (single)

    const balloon: TurnBalloon = { turnIndex: 1, files: [{ path: "test.ts", status: "modified" }] };
    const map = mapBalloonsToBlocks(blocks, [balloon]);

    // Must attach to a1 (the final block of turn 1), not the intermediate tool series
    expect(map.get("a1")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(map.get("t1")).toBeUndefined();
    expect(map.get("u1")).toBeUndefined();
  });

  test("anchors live balloons to active turn and deduplicates when finished", () => {
    const user1: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "p1" }] };
    const asst1: ChatMessage = { id: "a1", role: "assistant", blocks: [{ type: "text", text: "r1" }] };
    const user2: ChatMessage = { id: "u2", role: "user", blocks: [{ type: "text", text: "p2" }] };
    const asst2: ChatMessage = { id: "a2", role: "assistant", blocks: [{ type: "text", text: "r2" }] };

    const blocks = buildRenderBlocks([user1, asst1, user2, asst2]).map((b) => ({ ...b, id: b.msg.id }));
    // Turn 1 finished; Turn 2 is running live with changes
    const liveBalloons: TurnBalloon[] = [
      { turnIndex: 1, files: [{ path: "a.ts", status: "modified" }], live: false },
      { turnIndex: 2, files: [{ path: "b.ts", status: "new" }], live: true },
    ];

    const mapLive = mapBalloonsToBlocks(blocks, liveBalloons);
    expect(mapLive.get("a1")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(mapLive.get("a2")?.map((b) => b.turnIndex)).toEqual([2]);
    expect(mapLive.get("a2")?.[0].live).toBe(true);

    // When Turn 2 finishes, persistent balloon (live: false) replaces live balloon
    const finishedBalloons: TurnBalloon[] = [
      { turnIndex: 1, files: [{ path: "a.ts", status: "modified" }], live: false },
      { turnIndex: 2, files: [{ path: "b.ts", status: "new" }], live: true },
      { turnIndex: 2, files: [{ path: "b.ts", status: "new" }], live: false },
    ];
    const mapFinished = mapBalloonsToBlocks(blocks, finishedBalloons);
    expect(mapFinished.get("a2")?.length).toBe(1);
    expect(mapFinished.get("a2")?.[0].live).toBe(false);
  });

  test("ignores balloons with no files", () => {
    const user1: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "p1" }] };
    const asst1: ChatMessage = { id: "a1", role: "assistant", blocks: [{ type: "text", text: "r1" }] };
    const blocks = buildRenderBlocks([user1, asst1]).map((b) => ({ ...b, id: b.msg.id }));

    const emptyBalloons: TurnBalloon[] = [{ turnIndex: 1, files: [] }];
    const map = mapBalloonsToBlocks(blocks, emptyBalloons);
    expect(map.size).toBe(0);
  });

  test("handles mid-turn user messages without splitting the turn", () => {
    const user1: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "start" }] };
    const asst1: ChatMessage = { id: "a1", role: "assistant", blocks: [{ type: "text", text: "working" }] };
    const midUser: ChatMessage = { id: "u_mid", role: "user", blocks: [{ type: "text", text: "extra info" }], midTurn: true };
    const asst2: ChatMessage = { id: "a2", role: "assistant", blocks: [{ type: "text", text: "finished" }] };

    const blocks = buildRenderBlocks([user1, asst1, midUser, asst2]).map((b) => ({ ...b, id: b.msg.id }));
    const balloon1: TurnBalloon = { turnIndex: 1, files: [{ path: "c.ts", status: "modified" }] };

    const map = mapBalloonsToBlocks(blocks, [balloon1]);
    // The balloon belongs to Turn 1, so it anchors to a2 (the last block of Turn 1)
    expect(map.get("a2")?.map((b) => b.turnIndex)).toEqual([1]);
    expect(map.get("u_mid")).toBeUndefined();
    expect(map.get("a1")).toBeUndefined();
  });
});


describe("Tool mini-UI parsers", () => {
  test("parseInspectTree reads the daemon tree format", () => {
    const raw = "./ (6 entries)\n    bin/\n    cmd/\n[M] main.go (38B, 4 lines)\n      helper.ts (2B, 1 lines)\n";
    const t = parseInspectTree(raw);
    expect(t?.scope).toBe("./");
    expect(t?.count).toBe(6);
    expect(t?.entries.length).toBe(4);
    expect(t?.entries[0]).toMatchObject({ depth: 0, name: "bin", isDir: true, flag: "" });
    expect(t?.entries[2]).toMatchObject({ depth: 0, name: "main.go", isDir: false, flag: "M", size: "38B", lines: 4 });
    expect(t?.entries[3]).toMatchObject({ depth: 1, name: "helper.ts", flag: "" });
  });

  test("parseInspectTree handles capped headers and single files", () => {
    const capped = parseInspectTree("src/ (200 entries, capped at 200)\n    a.ts (1B, 1 lines)\n");
    expect(capped?.capped).toBe(200);
    const single = parseInspectTree("[A]   src/util.go (64B, 6 lines)\n");
    expect(single?.count).toBe(1);
    expect(single?.entries[0]).toMatchObject({ depth: 0, name: "src/util.go", flag: "A", size: "64B", lines: 6 });
    expect(parseInspectTree("garbage without structure")).toBeNull();
  });

  test("parseGlobList reads file lists and truncation", () => {
    expect(parseGlobList("No files matched the pattern.")).toMatchObject({ none: true, files: [] });
    const g = parseGlobList("g/a.ts\ng/b.ts\n\n(Truncated: showing first 500 matches)");
    expect(g).toMatchObject({ none: false, truncated: true, files: ["g/a.ts", "g/b.ts"] });
    expect(parseGlobList("")).toBeNull();
  });

  test("parseQuestionQA joins questions with recorded answers", () => {
    const args = {
      questions: [
        { header: "Theme", question: "Pick one", options: [{ label: "dark" }, { label: "light", description: "Bright" }], multiple: false },
        { header: "Scope", question: "Pick many", options: [{ label: "a" }, { label: "b" }], multiple: true },
      ],
    };
    const items = parseQuestionQA(args, JSON.stringify({ answers: [["dark"], ["a", "custom thing"]] }), undefined);
    expect(items.length).toBe(2);
    expect(items[0].answers).toEqual(["dark"]);
    expect(items[1]).toMatchObject({ multiple: true, answers: ["a", "custom thing"] });
    // Pending (no result yet) yields empty answers.
    expect(parseQuestionQA(args, "", undefined)[0].answers).toEqual([]);
    // Singular question field still parses.
    expect(parseQuestionQA({ question: "Do you agree?" }, "", undefined)[0].question).toBe("Do you agree?");
  });
});

describe("collapseCwd", () => {
  test("replaces the session cwd with a dot", () => {
    expect(collapseCwd(
      "cd /home/user/workspace/llm-gateway/indirect-code-daemon && go test ./...",
      "/home/user/workspace/llm-gateway",
    )).toBe("cd ./indirect-code-daemon && go test ./...");
    expect(collapseCwd("cd /home/user/workspace/llm-gateway", "/home/user/workspace/llm-gateway")).toBe("cd .");
    expect(collapseCwd("go build ./...", "/home/user/workspace/llm-gateway")).toBe("go build ./...");
  });

  test("handles trailing slashes, windows separators and degenerate cwd", () => {
    expect(collapseCwd("cd /a/b && make", "/a/b/")).toBe("cd . && make");
    expect(collapseCwd("cd C:\\work\\TAP && build", "C:\\work\\TAP")).toBe("cd . && build");
    expect(collapseCwd("echo hi", "")).toBe("echo hi");
    expect(collapseCwd("ls /", "/")).toBe("ls /");
  });
});

describe("pairing modal visibility", () => {
  test("silent token generation fills the card without popping the modal", async () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage ??= {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    };
    const { createModals } = await import("../web/src/indirect-code/hooks/useModals");
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ connectUrl: "http://x/pair/abc" }), { status: 200 });
    try {
      const toasts: string[] = [];
      const modals = createModals({ toast: (m) => void toasts.push(m) });
      await modals.generatePairingToken({ silent: true });
      expect(modals.pairingData()).toMatchObject({ connectUrl: "http://x/pair/abc" });
      expect(modals.showPairModal()).toBe(false);

      await modals.generatePairingToken();
      expect(modals.showPairModal()).toBe(true);
      expect(toasts).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("ghost session display guards", () => {
  test("timeAgo never renders epoch-scale day counts", async () => {
    const { timeAgo } = await import("../web/src/indirect-code/utils/format");
    expect(timeAgo(0)).toBe("—");
    expect(timeAgo(-5)).toBe("—");
    expect(timeAgo(NaN)).toBe("—");
    expect(timeAgo(Date.now() - 60000)).toBe("1m");
  });
});

describe("unified diff parsing (edit results and turn-change balloons)", () => {
  test("parses daemon-numbered edit rows and plain unified markers", async () => {
    const { parseDiffLine } = await import("../web/src/indirect-code/utils/diffLines");

    // Edit-tool format: "<number>:[ +-]<code>"
    expect(parseDiffLine("12:+const x = 1;")).toEqual({
      lineNum: "12", marker: "+", code: "const x = 1;", kind: "add",
    });
    expect(parseDiffLine("13:-old line")).toEqual({
      lineNum: "13", marker: "-", code: "old line", kind: "del",
    });
    expect(parseDiffLine("14: kept context")).toEqual({
      lineNum: "14", marker: " ", code: "kept context", kind: "context",
    });
    // Numbered row without a marker (read/write output) stays plain context.
    expect(parseDiffLine("7:plain numbered line")).toEqual({
      lineNum: "7", marker: "", code: "plain numbered line", kind: "context",
    });

    // Plain unified markers without numbers.
    expect(parseDiffLine("+added")).toEqual({ lineNum: "", marker: "+", code: "added", kind: "add" });
    expect(parseDiffLine("-removed")).toEqual({ lineNum: "", marker: "-", code: "removed", kind: "del" });
    expect(parseDiffLine(" unchanged")).toEqual({ lineNum: "", marker: " ", code: "unchanged", kind: "context" });
    expect(parseDiffLine("no marker at all")).toEqual({
      lineNum: "", marker: "", code: "no marker at all", kind: "context",
    });

    // Headers and hunk markers.
    expect(parseDiffLine("--- a/f.txt").kind).toBe("header");
    expect(parseDiffLine("+++ b/f.txt").kind).toBe("header");
    expect(parseDiffLine("@@ -1,3 +1,4 @@").kind).toBe("ellipsis");
    expect(parseDiffLine("...").kind).toBe("ellipsis");
  });

  test("derives line numbers from @@ hunk headers for balloon diffs", async () => {
    const { deriveLineNumbers, diffRows } = await import("../web/src/indirect-code/utils/diffLines");

    const unified = [
      "--- src/app.ts",
      "+++ src/app.ts",
      "@@ -10,7 +10,7 @@ function main() {",
      "   ctx = 1;",
      "-  old = 2;",
      "+  neu = 2;",
      "   tail = 3;",
      "@@ -40,3 +40,4 @@",
      "+  fresh = 4;",
      "   more = 5;",
      "-  gone = 6;",
    ].join("\n");

    expect(deriveLineNumbers(unified)).toEqual([
      "", "10", "11", "11", "12", "", "40", "40", "41",
    ]);

    // diffRows attaches the derived numbers and drops file headers.
    const rows = diffRows(unified);
    expect(rows.map((r) => r.code)).not.toContain("+++ src/app.ts");
    expect(rows.map((r) => r.lineNum)).toEqual([
      "", "10", "11", "11", "12", "", "40", "40", "41",
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      "ellipsis", "context", "del", "add", "context", "ellipsis", "add", "context", "del",
    ]);

    // New-file diffs (@@ -0,0 +1,N @@) count context from the new side.
    expect(deriveLineNumbers("@@ -0,0 +1,3 @@\n+first\n+second\n+third")).toEqual([
      "", "1", "2", "3",
    ]);

    // No @@ headers (edit-tool numbered format) -> null, numbers kept as parsed.
    expect(deriveLineNumbers("12:+const x = 1;\n13:-old")).toBeNull();
  });

  test("diffRows strips the daemon line-prefix notice", async () => {
    const { diffRows } = await import("../web/src/indirect-code/utils/diffLines");
    const rows = diffRows(
      '[Note: The line prefix "12:" is for line identification only and is not part of the file content.]\n12:+const x = 1;',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ lineNum: "12", marker: "+", code: "const x = 1;", kind: "add" });
  });
});

describe("balloon tail cuts", () => {
  test("dropAbove removes balloons anchored past the kept prefix", async () => {
    const { createTurnChanges } = await import("../web/src/indirect-code/hooks/useTurnChanges");
    const tc = createTurnChanges({ send: () => {}, getSessionId: () => "s", toast: () => {} });
    tc.applySnapshot({ fileBalloons: [
      { turnIndex: 1, messageIndex: 2, files: [{ path: "a" }] },
      { turnIndex: 2, messageIndex: 4, files: [{ path: "b" }] },
      { turnIndex: 3, files: [{ path: "c" }] },
    ] });
    expect(tc.balloons().map((b) => b.turnIndex)).toEqual([1, 2, 3]);
    tc.dropAbove(2);
    // Turn 2 (anchored at 4) drops; unanchored turn 3 stays.
    expect(tc.balloons().map((b) => b.turnIndex)).toEqual([1, 3]);
    tc.dropAbove(0);
    expect(tc.balloons().map((b) => b.turnIndex)).toEqual([3]);
  });
});

describe("completion signals and turn nudges", () => {
  test("withoutContinueNudges filters all synthetic nudges", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", blocks: [{ type: "text", text: "Regular message" }] },
      { id: "u2", role: "user", blocks: [{ type: "text", text: CONTINUE_NUDGE_TEXT }] },
      { id: "u3", role: "user", blocks: [{ type: "text", text: COMPLETION_NUDGE_BUILD }] },
      { id: "u4", role: "user", blocks: [{ type: "text", text: COMPLETION_NUDGE_PLAN }] },
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "Done" }] },
    ];
    const filtered = withoutContinueNudges(msgs);
    expect(filtered.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  test("withoutTodoActivity hides completion tool calls and marks hasCompletion while keeping text", () => {
    const msgs: ChatMessage[] = [
      {
        id: "a1",
        role: "assistant",
        blocks: [
          { type: "text", text: "I have finished all tasks." },
          { type: "tool_call", toolId: "call_done", toolName: "mark_task_as_complete", toolArgs: "{}" },
        ],
      },
      {
        id: "t1",
        role: "tool",
        blocks: [
          { type: "tool_result", toolId: "call_done", toolResult: "Task marked as complete." },
        ],
      },
    ];

    const result = withoutTodoActivity(msgs);
    // Tool result message t1 should be dropped completely
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("a1");
    // tool_call block is stripped, text block is retained
    expect(result[0].blocks).toEqual([{ type: "text", text: "I have finished all tasks." }]);
    expect(result[0].hasCompletion).toBe(true);
  });

  test("buildRenderBlocks displays text sent with completion tool even when hideToolMessages is true", () => {
    const user: ChatMessage = { id: "u1", role: "user", blocks: [{ type: "text", text: "Fix bug" }] };
    const step1: ChatMessage = {
      id: "a1",
      role: "assistant",
      blocks: [{ type: "tool_call", toolId: "call_write", toolName: "write", toolArgs: "{}" }],
    };
    const res1: ChatMessage = {
      id: "t1",
      role: "tool",
      blocks: [{ type: "tool_result", toolId: "call_write", toolResult: "written" }],
    };
    const step2: ChatMessage = {
      id: "a2",
      role: "assistant",
      blocks: [
        { type: "text", text: "Everything fixed and verified." },
        { type: "tool_call", toolId: "call_done", toolName: "mark_task_as_complete", toolArgs: "{}" },
      ],
    };

    const cleaned = withoutTodoActivity([user, step1, res1, step2]);
    const blocks = buildRenderBlocks(cleaned, { hideToolMessages: true });

    // The tool series contains a1 (the write call)
    // a2 (with text and mark_task_as_complete) must be rendered as a single block with visible text, NOT hidden!
    const a2Block = blocks.find((b) => b.msg.id === "a2");
    expect(a2Block).toBeDefined();
    expect(a2Block?.kind).toBe("single");
    expect(a2Block?.msg.blocks[0]?.text).toBe("Everything fixed and verified.");
  });
});


describe("Turn-end browser notification (useTurnNotify)", () => {
  test("turnNotifyText varies title by disposition", async () => {
    const { turnNotifyText } = await import("../web/src/indirect-code/hooks/useTurnNotify");
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "done" })).toEqual({
      title: "Turn finished — Fix bug",
      body: "Mac · tap to open",
    });
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "error" }).title).toBe(
      "Turn failed — Fix bug",
    );
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "cancelled" }).title).toBe(
      "Turn cancelled — Fix bug",
    );
  });

  test("noteMessage notifies only on running->idle, any host, enriched by turn_end", async () => {
    const { createTurnNotify } = await import("../web/src/indirect-code/hooks/useTurnNotify");
    // Notification API stub: capture shows instead of OS popups.
    const shown: { title: string; body: string }[] = [];
    (globalThis as any).Notification = class {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: { body?: string }) {
        shown.push({ title, body: opts?.body ?? "" });
      }
      close() {}
    };
    const opened: { hostId: string; sessionId: string }[] = [];
    const n = createTurnNotify({
      hosts: () => [{ id: "h1", name: "Mac", hostname: "mac", os: "darwin", arch: "arm64", userId: "u", apiKeyId: null, status: "online", lastSeenAt: null, createdAt: 0 }],
      sessions: () => [{ id: "s1", title: "Fix bug" } as any],
      toast: () => {},
      onOpenSession: (hostId, sessionId) => opened.push({ hostId, sessionId }),
    });

    const run = (hostId: string, sessionId: string) => ({ type: "session_status", hostId, sessionId, status: "running" }) as any;
    const idle = (hostId: string, sessionId: string) => ({ type: "session_status", hostId, sessionId, status: "idle" }) as any;

    // Stray idle with no running turn: silent (reconnect replay safety).
    expect(n.noteMessage(idle("h1", "s1"))).toBe(false);
    expect(shown.length).toBe(0);

    // running -> turn_end(error) -> idle: notifies as failed.
    expect(n.noteMessage(run("h1", "s1"))).toBe(true);
    expect(n.noteMessage({ type: "agent_event", hostId: "h1", sessionId: "s1", event: { type: "turn_end", error: "boom" } } as any)).toBe(true);
    expect(shown.length).toBe(0); // turn_end alone never notifies (per-step)
    expect(n.noteMessage(idle("h1", "s1"))).toBe(true);
    expect(shown.length).toBe(1);
    expect(shown[0]!.title).toBe("Turn failed — Fix bug");

    // Second idle without running: silent (no double notify).
    expect(n.noteMessage(idle("h1", "s1"))).toBe(false);
    expect(shown.length).toBe(1);

    // turn_start also arms (daemon live path), cancelled disposition varies text.
    expect(n.noteMessage({ type: "agent_event", hostId: "h9", sessionId: "s9", event: { type: "turn_start" } } as any)).toBe(true);
    expect(n.noteMessage({ type: "agent_event", hostId: "h9", sessionId: "s9", event: { type: "turn_end", cancelled: true } } as any)).toBe(true);
    expect(n.noteMessage(idle("h9", "s9"))).toBe(true);
    expect(shown.length).toBe(2);
    expect(shown[1]!.title).toContain("Turn cancelled");

    delete (globalThis as any).Notification;
  });

  test("buildTurnPayload is display-only (no secrets on lock screens)", async () => {
    const { buildTurnPayload } = await import("../server/push");
    const p = JSON.parse(buildTurnPayload({ title: "Fix bug", host: "Mac", disposition: "done", url: "/#/code" }));
    expect(p.title).toBe("Turn finished — Fix bug");
    expect(p.body).toBe("Mac · tap to open");
    expect(JSON.stringify(p)).not.toMatch(/gw_|dmt_|sk-|Bearer/i);
  });
});

describe("File icon in inline code (hasFileIcon)", () => {
  test("detects files by trailing extension, even with paths", async () => {
    const { hasFileIcon } = await import("../web/src/indirect-code/files");
    expect(hasFileIcon("server.ts")).toBe(true);
    expect(hasFileIcon("seilaoq/blabla.ts")).toBe(true);
    expect(hasFileIcon("src/api/routes.py")).toBe(true);
    expect(hasFileIcon("C:\\proj\\app.go")).toBe(true);
    expect(hasFileIcon("Dockerfile")).toBe(true);
    expect(hasFileIcon("package.json")).toBe(true);
    expect(hasFileIcon("run.test.ts")).toBe(true);
    // Not files: identifiers, commands, prose with dots, unknown extensions.
    expect(hasFileIcon("useState")).toBe(false);
    expect(hasFileIcon("npm run dev")).toBe(false);
    expect(hasFileIcon("v1.0")).toBe(false);
    expect(hasFileIcon("foo.xyzabc")).toBe(false);
    expect(hasFileIcon("")).toBe(false);
    expect(hasFileIcon(".gitignore")).toBe(false);
  });
});
