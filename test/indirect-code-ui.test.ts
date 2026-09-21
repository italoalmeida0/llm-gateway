import { describe, expect, test } from "bun:test";
import { compactTokens, contextDisplay, groupModelsByProvider } from "../web/src/indirect-code/context";
import { createTranscriptScroll } from "../web/src/indirect-code/scroll";
import {
  displayToolArgs,
  withoutTodoActivity,
  withoutContinueNudges,
  isSyntheticNudge,
  sanitizeUserText,
  stripLeadingSystemPrompt,
} from "../web/src/indirect-code/live";
import { absoluteRemotePath, collapseCwd, projectForDirectory, projectsByActivity, sameRemotePath } from "../web/src/indirect-code/paths";
import {
  blockTurnDuration, buildRenderBlocks, createRenderBlockBuilder, cacheHitPct, finalTurnMessage, fmtUsd, fuzzySame, isHeaderOnlySleep, isLongAssistantMessage, isTurnStartMessage, latestShortTurnMessage, mapBalloonsToBlocks, terminalPresentation, toolSummary, usageCosts,
} from "../web/src/indirect-code/transcript";
import { specialTitle } from "../web/src/indirect-code/utils/titles";
import { partitionToolSegs } from "../web/src/indirect-code/utils/toolSegs";
import { followTail } from "../web/src/indirect-code/utils/scrollMemory";
import { parseGlobList, parseInspectTree, parseQuestionQA } from "../web/src/indirect-code/utils/toolTrees";
import { parseEditResults } from "../web/src/indirect-code/utils/toolEdits";
import { parseDaemonMessage } from "../web/src/indirect-code/daemon-protocol";
import { parseContentBlocks } from "../web/src/indirect-code/utils/wire";
import {
  appendReasoningDelta, appendTextDelta, appendToolArgsDelta, appendToolResult,
  cutTail, finishTurn, foldBackgroundResult, mergeUsage, normalizeSessionMessages, stampDuration, upsertToolCall,
} from "../web/src/indirect-code/transcript/updaters";
import type { ChatMessage, ContentBlock, ToolUnit, TurnBalloon } from "../web/src/indirect-code/types";
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

test("groups a whole tool turn into one aggregate with ordered entries", () => {
  const list:ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,thinkingDuration:3,blocks:[{type:"reasoning",reasoning:"Inspect"},{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,thinkingDuration:1,blocks:[{type:"text",text:" \n "},{type:"reasoning",reasoning:"Verify"},{type:"tool_call",toolId:"b",toolName:"bash"}]},
    {id:"three",role:"assistant",srcIdx:5,blocks:[{type:"text",text:"I found an issue."},{type:"tool_call",toolId:"c",toolName:"edit"}]},
    {id:"four",role:"assistant",srcIdx:7,blocks:[{type:"reasoning",reasoning:"Testing"},{type:"tool_call",toolId:"d",toolName:"bash"}]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].kind).toBe("series");
  if (blocks[0].kind === "series") {
    expect(blocks[0].units.map((u) => u.call?.toolId)).toEqual(["a","b","c","d"]);
    expect(blocks[0].extras.map((m) => m.id)).toEqual(["two","three","four"]);
    expect(blocks[0].entries.map((e) => e.kind)).toEqual(
      ["thinking","tools","thinking","tools","text","tools","thinking","tools"]);
    // Nothing reaches 50 tokens: fallback features the last AI text.
    expect(blocks[0].finalMsgId).toBe("three");
  }
  expect(list[1].blocks).toHaveLength(3);
});

test("turn aggregate keeps event order and features the long closing message", () => {
  const long = "All issues are now resolved across the workspace. " + "x".repeat(200);
  const list: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,thinkingDuration:3,blocks:[{type:"reasoning",reasoning:"Inspect"},{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,thinkingDuration:1,blocks:[{type:"text",text:"Checking file"},{type:"reasoning",reasoning:"Verify"},{type:"tool_call",toolId:"b",toolName:"bash"}]},
    {id:"three",role:"assistant",srcIdx:5,blocks:[{type:"text",text:"I found an issue."},{type:"tool_call",toolId:"c",toolName:"edit"}]},
    {id:"four",role:"assistant",srcIdx:7,blocks:[{type:"reasoning",reasoning:"Testing"},{type:"tool_call",toolId:"d",toolName:"bash"}]},
    {id:"five",role:"assistant",srcIdx:9,blocks:[{type:"text",text:long}]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks).toHaveLength(1);
  expect(blocks[0].kind).toBe("series");
  if (blocks[0].kind === "series") {
    expect(blocks[0].units.map((u) => u.call?.toolId)).toEqual(["a","b","c","d"]);
    expect(blocks[0].extras.map((m) => m.id)).toEqual(["two","three","four","five"]);
    expect(blocks[0].entries.at(-1)?.kind).toBe("text");
    expect(blocks[0].finalMsgId).toBe("five");
  }
});

test("text-only turns feature one final, aggregating intermediate messages", () => {
  const list: ChatMessage[] = [
    {id:"u",role:"user",srcIdx:0,blocks:[{type:"text",text:"hi"}]},
    {id:"a",role:"assistant",srcIdx:1,blocks:[{type:"text",text:"Hello!"}]},
    {id:"b",role:"assistant",srcIdx:2,blocks:[{type:"text",text:"How can I help?"}]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks.map((b) => b.kind)).toEqual(["single","series"]);
  expect(blocks[1].kind === "series" && blocks[1].finalMsgId).toBe("b");
  expect(buildRenderBlocks(list.slice(0, 2)).map((b) => b.kind)).toEqual(["single", "single"]);
});

test("fuzzy duplicate progress notes hide, last wins", () => {
  expect(fuzzySame("Reading package.json to understand the project layout", "reading package.json to understand the project layout now")).toBe(true);
  expect(fuzzySame("Checking the file", "Running the test suite")).toBe(false);
  expect(fuzzySame("", "something")).toBe(false);
  const list: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,blocks:[
      {type:"text",text:"Reading package.json to understand the project layout"},
      {type:"tool_call",toolId:"a",toolName:"read"},
    ]},
    {id:"two",role:"assistant",srcIdx:3,blocks:[
      {type:"text",text:"Reading package.json to understand the project layout now"},
      {type:"tool_call",toolId:"b",toolName:"bash"},
    ]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks).toHaveLength(1);
  if (blocks[0].kind === "series") {
    const texts = blocks[0].entries.filter((e) => e.kind === "text");
    expect(texts).toHaveLength(2);
    expect(texts[0].kind === "text" && texts[0].hidden).toBe(true);
    expect(texts[1].kind === "text" && texts[1].hidden).not.toBe(true);
  } else {
    throw new Error("expected series");
  }
});

test("duplicate tool calls with the same id merge into one unit", () => {
  const list: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,blocks:[
      {type:"tool_call",toolId:"a",toolName:"bash",toolArgs:""},
      {type:"tool_call",toolId:"a",toolName:"bash",toolArgs:'{"command":"ls"}'},
    ]},
    {id:"two",role:"assistant",srcIdx:3,blocks:[{type:"tool_result",toolId:"a",toolResult:"done"}]},
  ];
  const blocks = buildRenderBlocks(list);
  expect(blocks).toHaveLength(1);
  if (blocks[0].kind === "series") {
    expect(blocks[0].units).toHaveLength(1);
    expect(blocks[0].units[0].call?.toolArgs).toBe('{"command":"ls"}');
    expect(blocks[0].units[0].result?.toolResult).toBe("done");
    // The cross-message result pairs onto the call instead of orphaning.
    expect(blocks[0].entries.filter((e) => e.kind === "tools")).toHaveLength(1);
  } else {
    throw new Error("expected series");
  }
});

test("replayed calls and results do not create duplicate tool cards", () => {
  const call: ContentBlock = {type:"tool_call",toolId:"same",toolName:"bash",toolArgs:'{"command":"ls"}'};
  const result: ContentBlock = {type:"tool_result",toolId:"same",toolResult:"done"};
  for (const blocks of [[call,result,call,result], [result,call,result]]) {
    const rendered = buildRenderBlocks([{id:"a",role:"assistant",blocks}])[0];
    if (rendered.kind !== "series") throw new Error("Expected tool turn");
    expect(rendered.units).toHaveLength(1);
    expect(rendered.units[0].call).toEqual(call);
    expect(rendered.units[0].result).toEqual(result);
    expect(rendered.entries.flatMap((e) => e.kind === "tools" ? e.units : [])).toHaveLength(1);
  }
});

test("duration is available with or without aggregate and ignores invalid metadata", () => {
  const msg: ChatMessage = {id:"a",role:"assistant",blocks:[{type:"text",text:"Answer"}],turnDurationMs:83000};
  expect(blockTurnDuration(buildRenderBlocks([msg])[0])).toBe(83000);
  expect(blockTurnDuration(buildRenderBlocks([{...msg,turnDurationMs:Infinity},{...msg,id:"b"}])[0])).toBe(83000);
  expect(blockTurnDuration(buildRenderBlocks([{...msg,turnDurationMs:NaN}])[0])).toBeUndefined();
});

test("final message is the last long text without tools (or with completion)", () => {
  const longTool = "Tool-adjacent long note. " + "x".repeat(200);
  const longFinal = "Final summary of everything done. " + "y".repeat(200);
  const list: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,blocks:[{type:"text",text:longTool},{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,blocks:[{type:"text",text:longFinal}]},
  ];
  expect(finalTurnMessage(list)?.id).toBe("two");
  const withCompletion: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,hasCompletion:true,blocks:[{type:"text",text:longFinal},{type:"tool_call",toolId:"a",toolName:"read"}]},
  ];
  expect(finalTurnMessage(withCompletion)?.id).toBe("one");
  const short: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,blocks:[{type:"tool_call",toolId:"a",toolName:"read"}]},
    {id:"two",role:"assistant",srcIdx:3,blocks:[{type:"text",text:"Done."}]},
  ];
  // No 50+ token message: falls back to the last AI text regardless of size.
  expect(finalTurnMessage(short)?.id).toBe("two");
  const toolOnly: ChatMessage[] = [
    {id:"one",role:"assistant",srcIdx:1,blocks:[{type:"tool_call",toolId:"a",toolName:"read"}]},
  ];
  expect(finalTurnMessage(toolOnly)).toBeNull();
});

test("final message prefers the longest of the last two qualifying texts", () => {
  const mk = (id: string, n: number): ChatMessage => ({
    id, role: "assistant", blocks: [{ type: "text", text: "t".repeat(n) }],
  });
  // Last two qualify; the longer (middle) wins over the tail.
  expect(finalTurnMessage([mk("a", 300), mk("b", 500), mk("c", 250)])?.id).toBe("b");
  // Tail longest wins.
  expect(finalTurnMessage([mk("a", 300), mk("b", 250), mk("c", 500)])?.id).toBe("c");
  // Older qualifying messages outside the last two lose.
  expect(finalTurnMessage([mk("a", 900), mk("b", 250), mk("c", 260)])?.id).toBe("c");
});

test("cache hit share rounds cached input over total input", () => {
  expect(cacheHitPct({ inTok: 25, cacheTok: 75 })).toBe(75);
  expect(cacheHitPct({ inTok: 100, cacheTok: 0 })).toBe(0);
  expect(cacheHitPct({ inTok: 0, cacheTok: 0 })).toBeNull();
});

test("usage costs split output pro-rata and hide without pricing", () => {
  const c = usageCosts({ outTok: 1000, reasoningTok: 250, costUsd: 0.02, costInUsd: 0.01, costCacheUsd: 0.002, costOutUsd: 0.008 });
  expect(c).not.toBeNull();
  expect(c!.reasoning).toBeCloseTo(0.002, 9);
  expect(c!.output).toBeCloseTo(0.006, 9);
  expect(c!.total).toBe(0.02);
  expect(usageCosts({ outTok: 0, reasoningTok: 0, costUsd: 0 })).toBeNull();
  expect(fmtUsd(2.5)).toBe("2.50");
  expect(fmtUsd(0.02)).toBe("0.02");
  expect(fmtUsd(0.001)).toBe("0.00");
  expect(fmtUsd(0.009)).toBe("0.00");
});

test("aggregate title summarizes activity counts", () => {
  const unit = (toolName: string): ToolUnit => ({ call: { type: "tool_call", toolId: toolName, toolName } });
  expect(specialTitle([unit("read"), unit("read"), unit("glob")])).toBe("Explored 2 files, 1 search");
  expect(specialTitle([unit("bash"), unit("bash"), unit("edit")])).toBe("Ran 2 commands · Made 1 edit");
  expect(specialTitle([unit("fetch_url"), unit("mystery")])).toBe("Checked 1 page · 1 call");
  expect(specialTitle([unit("read")], { texts: 2 })).toBe("Explored 1 file · 2 notes");
  expect(specialTitle([], { thoughts: 1 })).toBe("Thinking");
  expect(specialTitle([])).toBe("Tools");
});

test("followTail is inert without a DOM element", () => {
  const cleanup = followTail(null, () => true);
  expect(typeof cleanup).toBe("function");
  cleanup();
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
    })).toEqual({ icon: "mdi:language-python", verb: "Ran", target: "print(sum(range(10)))" });
    // Script mode shows the file plus CLI args.
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p2", toolName: "python", toolArgs: JSON.stringify({ script: "scripts/seed.py", args: ["--dry"] }) }
    })).toEqual({ icon: "mdi:language-python", verb: "Ran", target: "seed.py --dry" });
    // Empty code falls back to a clean placeholder (never blank).
    expect(toolSummary({
      call: { type: "tool_call", toolId: "p3", toolName: "python", toolArgs: "{}" }
    })).toEqual({ icon: "mdi:language-python", verb: "Ran", target: "snippet" });
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
  test("chunks long runs into five without moving earlier calls when appending", () => {
    const units = Array.from({length:50}, (_,i) => unit(i % 2 ? "python" : "bash", String(i)));
    expect(partitionToolSegs(units).map((s) => s.kind === "group" ? s.units.length : 1)).toEqual(Array(10).fill(5));
    expect(partitionToolSegs(units.slice(0, 6)).map((s) => s.kind === "group" ? s.units.length : 1)).toEqual([5, 1]);
    expect(partitionToolSegs([...units, unit("bash", "50")]).slice(0, 10)).toEqual(partitionToolSegs(units));
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
  test("stampDuration lands on thought-bearing messages, never mints 0s", () => {
    const thought = asst([{ type: "reasoning", reasoning: "hmm" }]);
    const empty = asst([], { id: "a2" });
    const stamped = stampDuration([thought, empty], 3);
    expect(stamped[0].thinkingDuration).toBe(3);
    expect(stamped[1].thinkingDuration).toBeUndefined();
    expect(stampDuration([thought], 0)[0].thinkingDuration).toBe(1);
    expect(stampDuration([empty], 5)[0].thinkingDuration).toBeUndefined();
    expect(stampDuration([], 5)).toEqual([]);
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
    expect(next.s).toEqual({ inTok: 1, outTok: 9, cacheTok: 0, reasoningTok: 4, costUsd: 5, costInUsd: 0, costCacheUsd: 0, costOutUsd: 0 });
    const split = mergeUsage(prev, "s", { output_tokens: 9, cost_input_usd: 0.1, cost_cache_usd: 0.2, cost_output_usd: 0.3 }, null);
    expect(split.s).toMatchObject({ costInUsd: 0.1, costCacheUsd: 0.2, costOutUsd: 0.3 });
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
  test("normalizeSessionMessages carries daemon turn_ms as turnDurationMs", () => {
    const raw = [
      { role: "user", turnIndex: 3, content: [{ type: "text", text: "hi" }] },
      { role: "assistant", turnIndex: 3, meta: { turn_ms: "83000" }, content: [{ type: "text", text: "yo" }] },
      { role: "assistant", turnIndex: 4, content: [{ type: "text", text: "new" }] },
    ];
    const out = normalizeSessionMessages(raw);
    expect(out[1].turnDurationMs).toBe(83000);
    expect(out[0].turnDurationMs).toBeUndefined();
    expect(out[2].turnDurationMs).toBeUndefined();
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
    expect(blocks.length).toBe(2); // user1, one turn aggregate (t1 lead + a1 extra)

    const balloon: TurnBalloon = { turnIndex: 1, files: [{ path: "test.ts", status: "modified" }] };
    const map = mapBalloonsToBlocks(blocks, [balloon]);

    // Must attach to the turn aggregate (the final block of turn 1)
    expect(map.get("t1")?.map((b) => b.turnIndex)).toEqual([1]);
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

  test("parseInspectTree reads mtimes and aggregated dir sizes", () => {
    const raw = "./ (3 entries)\n    sub/ (10B, 2026-09-16 10:00)\n    a.txt (8B, 2 lines, 2026-09-16 10:01)\n";
    const t = parseInspectTree(raw);
    expect(t?.entries[0]).toMatchObject({ name: "sub", isDir: true, size: "10B", mtime: "2026-09-16 10:00" });
    expect(t?.entries[1]).toMatchObject({ name: "a.txt", size: "8B", lines: 2, mtime: "2026-09-16 10:01" });
  });

  test("parseGlobList reads file lists and truncation", () => {
    expect(parseGlobList("No files matched the pattern.")).toMatchObject({ none: true, files: [] });
    const g = parseGlobList("g/a.ts\ng/b.ts\n\n(Truncated: showing first 500 matches)");
    expect(g).toMatchObject({ none: false, truncated: true, files: ["g/a.ts", "g/b.ts"] });
    expect(parseGlobList("")).toBeNull();
  });

  test("parseEditResults keeps windows drive letters out of the error split", () => {
    // Daemon header: `✓ C:/work/TAP/src/foo.ts (2 matches)` — the `C:`
    // colon is a drive letter, not the `path: message` error separator.
    const applied = parseEditResults("APPLIED.\n\n✓ C:/work/TAP/src/foo.ts (2 matches)\n1:+const x = 1");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ file: "C:/work/TAP/src/foo.ts", status: "applied", matches: 2 });
    const backslash = parseEditResults("APPLIED.\n\n✓ C:\\work\\TAP\\src\\foo.ts (1 match)\n1:+x");
    expect(backslash).toHaveLength(1);
    expect(backslash[0]).toMatchObject({ file: "C:\\work\\TAP\\src\\foo.ts", status: "applied", matches: 1 });
    // A real error (`path: message`, colon + space) still splits.
    const failed = parseEditResults("✗ src/foo.ts: oldText not found");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ file: "src/foo.ts", status: "error", error: "oldText not found" });
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
    expect(collapseCwd("cd /a/b && make", "/a/b/")).toBe("make");
    expect(collapseCwd("cd C:\\work\\TAP && build", "C:\\work\\TAP")).toBe("build");
    expect(collapseCwd("echo hi", "")).toBe("echo hi");
    expect(collapseCwd("ls /", "/")).toBe("ls /");
  });

  test("strips a redundant leading cd . && left by the collapse", () => {
    expect(collapseCwd("cd /proj && bun run dev", "/proj")).toBe("bun run dev");
    expect(collapseCwd("cd /proj && cd /proj/sub && make", "/proj")).toBe("cd ./sub && make");
    expect(collapseCwd("  cd . && echo hi", "/proj")).toBe("echo hi");
    // A cd into a DIFFERENT directory is meaningful: keep it.
    expect(collapseCwd("cd /other && ls", "/proj")).toBe("cd /other && ls");
    // Windows compares case-insensitively: casing drift must still collapse.
    expect(collapseCwd("cd c:\\work\\tap && build", "C:\\Work\\TAP")).toBe("build");
    expect(collapseCwd("cd C:/WORK/TAP && build", "c:\\work\\tap")).toBe("build");
  });

  test("compares remote paths across separator and case styles", () => {
    expect(sameRemotePath("C:\\work\\TAP", "c:/work/tap")).toBe(true);
    expect(sameRemotePath("\\\\server\\share\\dir", "//server/share/dir")).toBe(true);
    expect(sameRemotePath("/home/user/TAP", "/home/user/tap")).toBe(false);
    expect(sameRemotePath("/home/user", "/home/user")).toBe(true);
    expect(sameRemotePath("", "/home/user")).toBe(false);
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

  test("undoTurn prompts for confirmation before sending and honors cancellation", async () => {
    const { createTurnChanges } = await import("../web/src/indirect-code/hooks/useTurnChanges");
    const sent: any[] = [];
    let confirmPrompt: any = null;
    let confirmResult = false;
    const tc = createTurnChanges({
      send: (p) => sent.push(p),
      getSessionId: () => "sess-1",
      toast: () => {},
      showConfirm: async (opts) => {
        confirmPrompt = opts;
        return confirmResult;
      },
    });
    tc.applySnapshot({
      fileBalloons: [
        { turnIndex: 1, files: [{ path: "foo.ts" }, { path: "bar.ts" }] },
      ],
    });

    // User cancels confirmation -> nothing sent
    confirmResult = false;
    await tc.undoTurn(1);
    expect(confirmPrompt).not.toBeNull();
    expect(confirmPrompt.title).toBe("Undo turn changes?");
    expect(confirmPrompt.message).toContain("2 files");
    expect(confirmPrompt.danger).toBe(true);
    expect(sent.length).toBe(0);

    // User confirms -> undo_turn_changes is sent
    confirmResult = true;
    await tc.undoTurn(1);
    expect(sent.length).toBe(1);
    expect(sent[0].type).toBe("undo_turn_changes");
    expect(sent[0].sessionId).toBe("sess-1");
    expect(sent[0].turnIndex).toBe(1);
  });
});

describe("completion signals and turn nudges", () => {
  test("withoutContinueNudges filters all synthetic nudges", () => {
    const msgs: ChatMessage[] = [
      { id: "u1", role: "user", blocks: [{ type: "text", text: "Regular message" }] },
      { id: "u2", role: "user", blocks: [{ type: "text", text: "<system-reminder>You should continue what you are doing.</system-reminder>" }] },
      { id: "u3", role: "user", blocks: [{ type: "text", text: "<system-reminder>If you have completed the task, call mark_task_as_complete...</system-reminder>" }] },
      { id: "u4", role: "user", blocks: [{ type: "text", text: "<system-reminder>If your plan is ready, call mark_plan_as_ready_to_execute...</system-reminder>" }] },
      { id: "u5", role: "user", blocks: [{ type: "text", text: "  <system-reminder>custom anything</system-reminder>  " }] },
      { id: "u6", role: "user", blocks: [{ type: "text", text: "<system-reminder>## Context Summary (compacted)\n\nDid things.</system-reminder>" }] },
      { id: "a1", role: "assistant", blocks: [{ type: "text", text: "Done" }] },
    ];
    const filtered = withoutContinueNudges(msgs);
    expect(filtered.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  test("isSyntheticNudge matches any system-reminder block after trim", () => {
    expect(isSyntheticNudge("<system-reminder>hello</system-reminder>")).toBe(true);
    expect(isSyntheticNudge("  <system-reminder>anything here</system-reminder>  ")).toBe(true);
    expect(isSyntheticNudge("<system-reminder>You should continue what you are doing.</system-reminder>")).toBe(true);
    expect(isSyntheticNudge("<system-reminder>If you have completed the task, call mark_task_as_complete.</system-reminder>")).toBe(true);
    expect(isSyntheticNudge("<system-reminder>If your plan is ready, call mark_plan_as_ready_to_execute.</system-reminder>")).toBe(true);
    expect(isSyntheticNudge("<system-reminder>## Context Summary (compacted)\n\nDid things.</system-reminder>")).toBe(true);
    expect(isSyntheticNudge("Regular user message")).toBe(false);
    expect(isSyntheticNudge("hello <system-reminder>mid</system-reminder>")).toBe(false);
  });

  test("sanitizeUserText removes system-reminder tags from user input", () => {
    expect(sanitizeUserText("<system-reminder>You should continue</system-reminder>")).toBe("You should continue");
    expect(sanitizeUserText("  <system-reminder>qualquer coisa</system-reminder>  ")).toBe("qualquer coisa");
    expect(sanitizeUserText("prefix <system-reminder>mid</system-reminder> suffix")).toBe("prefix mid suffix");
    expect(sanitizeUserText("Regular user message")).toBe("Regular user message");
  });

  test("stripLeadingSystemPrompt removes leading system-reminder block and preserves user text", () => {
    expect(stripLeadingSystemPrompt("<system-reminder>\nCurrent date: Monday, 2026-09-12\n</system-reminder>\n\nCan you fix the bug?")).toBe("Can you fix the bug?");
    expect(stripLeadingSystemPrompt("<system-reminder>Operational mode: Plan</system-reminder> Please inspect")).toBe("Please inspect");
    expect(stripLeadingSystemPrompt("Regular user message without tag")).toBe("Regular user message without tag");
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
    const blocks = buildRenderBlocks(cleaned);

    // One turn aggregate: the write unit plus a visible text entry for a2
    // (completion text is exempt from hiding — enforced at render).
    expect(blocks).toHaveLength(2);
    const series = blocks[1];
    expect(series.kind).toBe("series");
    if (series.kind === "series") {
      expect(series.units.map((u) => u.call?.toolName)).toEqual(["write"]);
      const texts = series.entries.filter((e) => e.kind === "text");
      expect(texts).toHaveLength(1);
      expect(texts[0].kind === "text" && texts[0].block.text).toBe("Everything fixed and verified.");
      expect(texts[0].kind === "text" && texts[0].msg.hasCompletion).toBe(true);
    }
  });

  test("isLongAssistantMessage estimates tokens as chars/4 with a 50-token threshold", () => {
    const short: ChatMessage = { id: "s", role: "assistant", blocks: [{ type: "text", text: "Checking file" }] };
    const long: ChatMessage = {
      id: "l", role: "assistant",
      blocks: [{ type: "text", text: "x".repeat(200) }, { type: "tool_call", toolId: "t", toolName: "bash" }],
    };
    expect(isLongAssistantMessage(short)).toBe(false);
    expect(isLongAssistantMessage(long)).toBe(true);
  });

  test("latestShortTurnMessage returns the last short assistant text of the current turn", () => {
    const mk = (id: string, text: string, turnIndex?: number): ChatMessage => ({
      id, role: "assistant", blocks: [{ type: "text", text }], ...(turnIndex !== undefined ? { turnIndex } : {}),
    });
    const user: ChatMessage = { id: "u", role: "user", blocks: [{ type: "text", text: "go" }] };
    // Stamped turns: only the max turn counts, newest short text wins.
    expect(latestShortTurnMessage([
      mk("a1", "old turn", 49), user,
      mk("a2", "x".repeat(200), 50),
      mk("a3", "Checking file", 50),
    ])).toBe("Checking file");
    // Long tail falls back to the earlier short message of the same turn.
    expect(latestShortTurnMessage([mk("a1", "ok", 50), mk("a2", "y".repeat(150), 50)])).toBe("ok");
    // No short text at all -> empty.
    expect(latestShortTurnMessage([mk("a1", "z".repeat(120), 50)])).toBe("");
    // Unstamped (live streaming): tail after the last user turn-start.
    expect(latestShortTurnMessage([mk("old", "stale"), user, mk("new", "Reading config")])).toBe("Reading config");
    expect(latestShortTurnMessage([])).toBe("");
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
    expect(hasFileIcon(".dockerignore")).toBe(false);
    // Bare extension words are not files (no dot in the basename).
    expect(hasFileIcon("ts")).toBe(false);
    expect(hasFileIcon("tsx")).toBe(false);
    expect(hasFileIcon("js")).toBe(false);
    expect(hasFileIcon("py")).toBe(false);
    expect(hasFileIcon("go")).toBe(false);
    expect(hasFileIcon("README")).toBe(false);
    // Extensionless special names and known dotfiles keep their icons.
    expect(hasFileIcon("Makefile")).toBe(true);
    expect(hasFileIcon("LICENSE")).toBe(true);
    expect(hasFileIcon(".git")).toBe(true);
    expect(hasFileIcon(".env")).toBe(true);
    expect(hasFileIcon(".env.local")).toBe(true);
    expect(hasFileIcon("bun.lock")).toBe(true);
    // Every .git* file gets the git icon.
    expect(hasFileIcon(".gitignore")).toBe(true);
    expect(hasFileIcon(".gitmodules")).toBe(true);
    expect(hasFileIcon(".gitattributes")).toBe(true);
  });

  test("commandIcon matches leading command word + space", async () => {
    const { commandIcon } = await import("../web/src/indirect-code/files");
    expect(commandIcon("git push")?.icon).toBe("mdi:git");
    expect(commandIcon("GIT STATUS")?.icon).toBe("mdi:git");
    expect(commandIcon("bun run dev")?.icon).toBe("lucide:zap");
    expect(commandIcon("npm install")?.icon).toBe("mdi:npm");
    expect(commandIcon("docker ps")?.icon).toBe("mdi:docker");
    expect(commandIcon("ls -la")?.icon).toBe("lucide:terminal");
    expect(commandIcon("ssh u@h")?.icon).toBe("mdi:ssh");
    expect(commandIcon("kubectl get pods")?.icon).toBe("mdi:kubernetes");
    expect(commandIcon("foobar baz")).toBeNull();
    expect(commandIcon("git")).toBeNull(); // no trailing space, not a command
    expect(commandIcon("useState x")).toBeNull();
  });
});

describe("Read tool label line range (toolSummary)", () => {
  const readUnit = (offset: number | undefined, limit: number | undefined, resultLines: number) => ({
    call: {
      type: "tool_call",
      toolId: "1",
      toolName: "read",
      toolArgs: JSON.stringify({ path: "server.ts", ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) }),
    },
    result: { type: "tool_result", toolId: "1", toolResult: Array(resultLines).fill("x").join("\n") },
  });
  test("offset is 1-indexed: label matches the display block numbering", async () => {
    const { toolSummary } = await import("../web/src/indirect-code/transcript");
    // AI reads lines 56..115 (offset=56, limit=60): block shows 56:..115:.
    expect(toolSummary(readUnit(56, 60, 60) as any).target).toBe("server.ts#L56-115");
    // No offset: first line is L1, matching the block's 1: prefix.
    expect(toolSummary(readUnit(undefined, undefined, 10) as any).target).toBe("server.ts#L1-10");
    // Offset only: range covers the returned lines.
    expect(toolSummary(readUnit(56, undefined, 60) as any).target).toBe("server.ts#L56-115");
  });
});

describe("Turn balloons use daemon-stamped turnIndex", () => {
  test("balloon anchors by stamped turn even when local bubble count diverges", async () => {
    const { buildRenderBlocks, mapBalloonsToBlocks } = await import("../web/src/indirect-code/transcript");
    // Daemon session is at TurnSeq 10/11, but only 2 user bubbles are visible
    // (older turns compacted away). Old code counted bubbles (turns 1-2) and
    // piled balloon 10 onto the first block; stamped anchoring + backward
    // fallback must keep it near the end instead.
    const userA: ChatMessage = { id: "ua", role: "user", blocks: [{ type: "text", text: "a" }], turnIndex: 10 };
    const asstA: ChatMessage = { id: "aa", role: "assistant", blocks: [{ type: "text", text: "A" }], turnIndex: 10 };
    const userB: ChatMessage = { id: "ub", role: "user", blocks: [{ type: "text", text: "b" }], turnIndex: 11 };
    const blocks = buildRenderBlocks([userA, asstA, userB]).map((b) => ({ ...b, id: b.msg.id }));
    const balloon: TurnBalloon = { turnIndex: 10, files: [{ path: "f.ts", status: "modified" }] };
    const map = mapBalloonsToBlocks(blocks, [balloon]);
    // Turn 10's last block is asstA (right above userB's message).
    expect(map.get("aa")?.map((b) => b.turnIndex)).toEqual([10]);
    expect(map.get("ua")).toBeUndefined();
  });

  test("missing turn walks back to the nearest older rendered turn", async () => {
    const { buildRenderBlocks, mapBalloonsToBlocks } = await import("../web/src/indirect-code/transcript");
    const userA: ChatMessage = { id: "ua", role: "user", blocks: [{ type: "text", text: "a" }], turnIndex: 8 };
    const asstA: ChatMessage = { id: "aa", role: "assistant", blocks: [{ type: "text", text: "A" }], turnIndex: 8 };
    const userB: ChatMessage = { id: "ub", role: "user", blocks: [{ type: "text", text: "b" }], turnIndex: 11 };
    const asstB: ChatMessage = { id: "ab", role: "assistant", blocks: [{ type: "text", text: "B" }], turnIndex: 11 };
    const blocks = buildRenderBlocks([userA, asstA, userB, asstB]).map((b) => ({ ...b, id: b.msg.id }));
    // Balloon for pruned turn 10: must sit after turn 8 (nearest older),
    // never piled onto the first block.
    const map = mapBalloonsToBlocks(blocks, [{ turnIndex: 10, files: [{ path: "f.ts", status: "modified" }] }]);
    expect(map.get("aa")?.map((b) => b.turnIndex)).toEqual([10]);
    expect(map.get("ua")).toBeUndefined();
    // Future turn 12 (not rendered yet): pins to the end.
    const map2 = mapBalloonsToBlocks(blocks, [{ turnIndex: 12, files: [{ path: "g.ts", status: "new" }] }]);
    expect(map2.get("ab")?.map((b) => b.turnIndex)).toEqual([12]);
  });
});

describe("Wait-state notifications (approval/question/stalled error)", () => {
  test("approval/question text varies; waits dedupe per id; retry clears fatal", async () => {
    const { createTurnNotify, turnNotifyText } = await import("../web/src/indirect-code/hooks/useTurnNotify");
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "approval" }).title).toBe(
      "Approval needed — Fix bug",
    );
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "question" }).title).toBe(
      "Your answer needed — Fix bug",
    );
    const shown: string[] = [];
    (globalThis as any).Notification = class {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push(title);
      }
      close() {}
    };
    const n = createTurnNotify({
      hosts: () => [],
      sessions: () => [],
      toast: () => {},
      onOpenSession: () => {},
    });
    const run = { type: "session_status", hostId: "h1", sessionId: "s1", status: "running" } as any;
    expect(n.noteMessage(run)).toBe(true);
    // Approval notifies once per callId.
    const appr = { type: "tool_approval_request", hostId: "h1", sessionId: "s1", callId: "c1", tool: "bash" } as any;
    expect(n.noteMessage(appr)).toBe(true);
    expect(n.noteMessage(appr)).toBe(false);
    expect(shown.filter((t) => t.startsWith("Approval"))).toHaveLength(1);
    // Question notifies once per question id.
    const q = { type: "question_request", hostId: "h1", sessionId: "s1", question: { id: "q1" } } as any;
    expect(n.noteMessage(q)).toBe(true);
    expect(n.noteMessage(q)).toBe(false);
    expect(shown.filter((t) => t.startsWith("Your answer"))).toHaveLength(1);
    // turn_end error arms a fatal; retry clears it (no stalled notification).
    expect(n.noteMessage({ type: "agent_event", hostId: "h1", sessionId: "s1", event: { type: "turn_end", error: "boom" } } as any)).toBe(true);
    expect(n.noteMessage({ type: "agent_event", hostId: "h1", sessionId: "s1", event: { type: "retry", attempt: 1 } } as any)).toBe(false);
    // Normal idle still notifies once as failed (no duplicate from watchdog).
    expect(n.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s1", status: "idle" } as any)).toBe(true);
    expect(shown.filter((t) => t.startsWith("Turn failed"))).toHaveLength(1);
    delete (globalThis as any).Notification;
  });
});

describe("Notification tags are unique per event", () => {
  test("notifyTag keeps prefix and appends a 6-hex suffix", async () => {
    const { notifyTag } = await import("../web/src/indirect-code/hooks/useTurnNotify");
    const a = notifyTag("turn", "h1", "s1");
    const b = notifyTag("turn", "h1", "s1");
    expect(a).toMatch(/^turn-h1-s1-[0-9a-f]{6}$/);
    expect(b).toMatch(/^turn-h1-s1-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(notifyTag("wait", "h1", "s1")).toMatch(/^wait-h1-s1-[0-9a-f]{6}$/);
  });

  test("push payload tag is unique per event", async () => {
    const { buildTurnPayload } = await import("../server/push");
    const p1 = JSON.parse(buildTurnPayload({ title: "T", host: "H", disposition: "done", url: "/#/code" }));
    const p2 = JSON.parse(buildTurnPayload({ title: "T", host: "H", disposition: "done", url: "/#/code" }));
    expect(p1.tag).toMatch(/^turn-H-T-[0-9a-f]{6}$/);
    expect(p2.tag).toMatch(/^turn-H-T-[0-9a-f]{6}$/);
    expect(p1.tag).not.toBe(p2.tag);
  });
});

describe("Notify only for build/plan modes", () => {
  test("learning/talk sessions stay silent, unknown mode still notifies", async () => {
    const { createTurnNotify } = await import("../web/src/indirect-code/hooks/useTurnNotify");
    const shown: string[] = [];
    (globalThis as any).Notification = class {
      static permission = "granted";
      onclick: (() => void) | null = null;
      constructor(title: string) {
        shown.push(title);
      }
      close() {}
    };
    const mkSessions = () => [
      { id: "build-s", title: "Build", hostId: "h1", options: { mode: "build" } },
      { id: "plan-s", title: "Plan", hostId: "h1", options: { mode: "plan" } },
      { id: "talk-s", title: "Talk", hostId: "h1", options: { mode: "talk" } },
      { id: "learn-s", title: "Learn", hostId: "h1", options: { mode: "learning" } },
    ];
    const n = createTurnNotify({
      hosts: () => [],
      sessions: mkSessions as any,
      toast: () => {},
      onOpenSession: () => {},
    });
    const idle = (sid: string) => ({ type: "session_status", hostId: "h1", sessionId: sid, status: "idle" }) as any;
    const run = (sid: string) => ({ type: "session_status", hostId: "h1", sessionId: sid, status: "running" }) as any;
    for (const sid of ["build-s", "plan-s", "talk-s", "learn-s", "unknown-s"]) n.noteMessage(run(sid));
    for (const sid of ["build-s", "plan-s", "talk-s", "learn-s", "unknown-s"]) n.noteMessage(idle(sid));
    expect(shown.filter((t) => t.includes("Build"))).toHaveLength(1);
    expect(shown.filter((t) => t.includes("Plan"))).toHaveLength(1);
    expect(shown.filter((t) => t.includes("Talk"))).toHaveLength(0);
    expect(shown.filter((t) => t.includes("Learn"))).toHaveLength(0);
    expect(shown.filter((t) => t.includes("unknown"))).toHaveLength(1);
    delete (globalThis as any).Notification;
  });
});

describe("Turn audit regressions", () => {
  test("live messages retain turn identity and raw position through snapshots", async () => {
    const { pushAssistantCarrier, mergeAssistantMessage } = await import("../web/src/indirect-code/transcript/updaters");
    let list = pushAssistantCarrier([], 12, 9);
    list = appendReasoningDelta(list, "Working");
    list = mergeAssistantMessage(list, {index:12,turnIndex:9,message:{role:"assistant",content:[{text:"Done"}]}});
    expect(list[0]).toMatchObject({id:"msg_12",srcIdx:12,turnIndex:9,streaming:false});
    const raw = Array.from({length:13},(_,i) => i===12 ? {role:"assistant",turnIndex:9,content:[{text:"Done"}]} : {role:"tool",content:[]});
    expect(normalizeSessionMessages(raw,list)[0].id).toBe(list[0].id);
  });

  test("short live hints never fall back into the previous turn", () => {
    const list: ChatMessage[] = [
      {id:"old",role:"assistant",turnIndex:8,blocks:[{type:"text",text:"Old hint"}]},
      {id:"user",role:"user",blocks:[{type:"text",text:"New task"}]},
      {id:"live",role:"assistant",blocks:[{type:"text",text:"Current hint"}]},
    ];
    expect(latestShortTurnMessage(list)).toBe("Current hint");
    expect(latestShortTurnMessage(list.slice(0,2))).toBe("");
    const map = mapBalloonsToBlocks(buildRenderBlocks(list),[{turnIndex:8,files:[{path:"old.ts",status:"modified"}]}]);
    expect(map.get("old")?.[0].turnIndex).toBe(8);
    expect(map.has("live")).toBe(false);
  });

  test("stamped turns cannot fuse when a user bubble is absent", () => {
    const list: ChatMessage[] = [1,2].map((turnIndex) => ({id:String(turnIndex),role:"assistant",turnIndex,blocks:[{type:"reasoning",reasoning:"Work"}]}));
    expect(buildRenderBlocks(list)).toHaveLength(2);
  });

  test("balloons normalize legacy wire keys and retain committed changes", async () => {
    const { createTurnChanges } = await import("../web/src/indirect-code/hooks/useTurnChanges");
    const tc = createTurnChanges({send:()=>{},getSessionId:()=>"s",toast:()=>{}});
    const files = [{path:"a.ts",status:"new"}];
    tc.noteBalloon({turn_index:3,message_index:6,files},false);
    expect(tc.balloons()[0]).toMatchObject({turnIndex:3,messageIndex:6,live:false});
    tc.dropAbove(5); // Raw index 5 keeps six messages, including the entire turn.
    expect(tc.balloons()).toHaveLength(1);
    tc.noteBalloon({turnIndex:3,files:[]},true);
    expect(tc.balloons()).toHaveLength(1); // Late live empty must not delete committed changes.
  });
});

describe("Background tasks (bash/python detach)", () => {
  const placeholder = (): ChatMessage => ({
    id: "a1", role: "assistant", time: 0,
    blocks: [{
      type: "tool_result", toolId: "t1",
      toolResult: "Command moved to background (still running).",
      toolStartedAt: 1000,
      toolDetails: { background_job_id: "bg_1", log_path: "/brain/bg_1.log" },
    }],
  });

  test("foldBackgroundResult folds the terminal result into the placeholder row", () => {
    const folded = foldBackgroundResult([placeholder()], { id: "bg_1", result: "out\n[exit 0]", status: "done", endedAt: 5000 });
    const b = folded[0].blocks[0] as any;
    expect(b.toolResult).toBe("out\n[exit 0]");
    expect(b.toolDetails.detached).toBe(true);
    expect(b.toolDetails.display).toBe("out\n[exit 0]");
    expect(b.toolDetails.background_job_id).toBe("bg_1");
    expect(b.toolDurationMs).toBe(4000);
  });

  test("foldBackgroundResult is idempotent and ignores unknown jobs", () => {
    const once = foldBackgroundResult([placeholder()], { id: "bg_1", result: "out", status: "done", endedAt: 2000 });
    expect(foldBackgroundResult(once, { id: "bg_1", result: "out", status: "done", endedAt: 2000 })).toBe(once);
    expect(foldBackgroundResult([placeholder()], { id: "bg_other", result: "x", status: "done" })).toHaveLength(1);
    const untouched = foldBackgroundResult([placeholder()], { id: "bg_other", result: "x", status: "done" });
    expect((untouched[0].blocks[0] as any).toolDetails.detached).toBeUndefined();
  });

  test("foldBackgroundResult marks errors", () => {
    const folded = foldBackgroundResult([placeholder()], { id: "bg_1", result: "boom", status: "error", endedAt: 2000 });
    expect((folded[0].blocks[0] as any).isError).toBe(true);
  });

  test("normalizeSessionMessages drops background deliveries (tagged and sanitized)", () => {
    // Live-turn shape: tags survive the quiet append.
    const tagged: any[] = [{
      role: "user",
      content: [{ type: "text", text: "<system-reminder>\nBackground task x finished.\n</system-reminder>" }],
      meta: { background_delivery: "bg_1", background_kind: "bash" },
    }];
    expect(normalizeSessionMessages(tagged)).toEqual([]);
    // Wake-up shape: SanitizeUserText stripped the tags, the meta flag remains.
    const sanitized: any[] = [{
      role: "user",
      content: [{ type: "text", text: "Background task x finished." }],
      meta: { user_text: "Background task x finished.", background_delivery: "bg_1", background_kind: "bash" },
    }];
    expect(normalizeSessionMessages(sanitized)).toEqual([]);
    // A dropped delivery must not become the carrier for later tool results.
    const withTool: any[] = [...sanitized, {
      role: "assistant", content: [{ type: "tool_result", toolId: "t", toolResult: "r" }],
    }];
    expect(normalizeSessionMessages(withTool)).toHaveLength(1);
  });

  test("toolSummary reads detached runs as Background, plus sleep/bg_cancel", () => {
    const bashBg = toolSummary({
      call: { type: "tool_call", toolId: "t", toolName: "bash", toolArgs: JSON.stringify({ command: "sleep 30" }) },
      result: { type: "tool_result", toolId: "t", toolResult: "moved to background", toolDetails: { background_job_id: "bg_1" } },
    } as any);
    expect(bashBg.verb).toBe("Background");
    const bashSync = toolSummary({
      call: { type: "tool_call", toolId: "t", toolName: "bash", toolArgs: JSON.stringify({ command: "ls" }) },
      result: { type: "tool_result", toolId: "t", toolResult: "x" },
    } as any);
    expect(bashSync.verb).toBe("Ran");
    expect(toolSummary({
      call: { type: "tool_call", toolId: "t", toolName: "sleep", toolArgs: JSON.stringify({ seconds: 120 }) },
    } as any).verb).toBe("Sleeping");
    expect(toolSummary({
      call: { type: "tool_call", toolId: "t", toolName: "bg_cancel", toolArgs: JSON.stringify({ job_id: "bg_9" }) },
      result: { type: "tool_result", toolId: "t", toolResult: "cancelled" },
    } as any).verb).toBe("Stopped");
  });

  test("sleep rows are header-only while running, with a body once finished", () => {
    expect(isHeaderOnlySleep("sleep", false)).toBe(true);
    expect(isHeaderOnlySleep("sleep", true)).toBe(false);
    expect(isHeaderOnlySleep("bash", false)).toBe(false);
    expect(isHeaderOnlySleep("bash", true)).toBe(false);
    expect(isHeaderOnlySleep("python", false)).toBe(false);
  });

  test("aggregate keeps detached bash and finished sleep units with their results", () => {
    const list: ChatMessage[] = [
      { id: "one", role: "assistant", srcIdx: 1, blocks: [
        { type: "tool_call", toolId: "b", toolName: "bash", toolArgs: JSON.stringify({ command: "sleep 30 && echo done" }) },
        { type: "tool_result", toolId: "b", toolResult: "moved to background", toolDetails: { background_job_id: "bg_1" } },
        { type: "tool_call", toolId: "s", toolName: "sleep", toolArgs: JSON.stringify({ seconds: 30 }) },
        { type: "tool_result", toolId: "s", toolResult: "Woken early after 12s: a background task finished — its completion notice is now in context." },
      ]},
    ];
    const blocks = buildRenderBlocks(list);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("series");
    if (blocks[0].kind === "series") {
      expect(blocks[0].units.map((u) => u.call?.toolId)).toEqual(["b", "s"]);
      // The finished sleep keeps its result text: the body gate must let it through.
      const sleep = blocks[0].units.find((u) => u.call?.toolId === "s");
      expect(sleep?.result?.toolResult).toContain("Woken early");
      expect(isHeaderOnlySleep(sleep?.call?.toolName || "", !!sleep?.result)).toBe(false);
    }
  });
});

describe("Background hook (tail buffering + always-fold)", () => {
  test("terminal jobs fold on every snapshot; live chunks buffer until the tail lands", async () => {
    const { createBackground } = await import("../web/src/indirect-code/hooks/useBackground");
    const { createRoot } = await import("solid-js");
    const sent: any[] = [];
    const folded: string[] = [];
    createRoot((dispose) => {
      const bg = createBackground({
        send: (p) => { sent.push(p); },
        isOpen: () => true,
        getSessionId: () => "s1",
        toast: () => {},
        onTerminalResult: (job) => { folded.push(job.id); },
      });
      const done1 = { id: "bg_1", kind: "bash", sessionId: "s1", label: "sleep 30", status: "done", startedAt: 1, endedAt: 2, result: "out" };
      // Terminal job never seen running: still folds (self-healing a
      // missed bg_update instead of showing the AI notice forever).
      bg.noteJobs([done1]);
      expect(folded).toEqual(["bg_1"]);
      // Repeated snapshots re-fold (idempotent downstream).
      bg.noteJobs([done1]);
      expect(folded).toEqual(["bg_1", "bg_1"]);
      // Foreign sessions never fold.
      bg.noteJobs([{ id: "bg_9", kind: "bash", sessionId: "other", label: "x", status: "done", startedAt: 1, result: "x" }]);
      expect(folded).toEqual(["bg_1", "bg_1"]);
      // Running job: tail requested, live chunks buffered (pre-detach
      // history is not lost to a tail/live race).
      bg.noteJobs([{ id: "bg_2", kind: "python", sessionId: "s1", label: "code", status: "running", startedAt: 1 }]);
      expect(sent).toContainEqual({ type: "bg_tail", jobId: "bg_2" });
      bg.noteOutput("bg_2", "live-1");
      expect(bg.output()["bg_2"] || "").toBe("");
      bg.noteTail("bg_2", "history-");
      expect(bg.output()["bg_2"]).toBe("history-live-1");
      bg.noteOutput("bg_2", "live-2");
      expect(bg.output()["bg_2"]).toBe("history-live-1live-2");
      // Finishing flushes the fold again (heals rows that mounted late).
      bg.noteJobs([{ id: "bg_2", kind: "python", sessionId: "s1", label: "code", status: "done", startedAt: 1, endedAt: 2, result: "done" }]);
      expect(folded[folded.length - 1]).toBe("bg_2");
      dispose();
    });
  });
});

describe("Tool row model", () => {
  test("builds without throwing: eager memos must not read consts declared below them", async () => {
    const { useToolUnitModel } = await import("../web/src/indirect-code/components/tool/toolUnitModel");
    const { createRoot } = await import("solid-js");
    const ctx: any = {
      toolProgress: () => ({}),
      toolStarts: () => ({ s1: 100000 }),
      turnClock: () => 105000,
      elapsedLabel: (ms: number) => `${ms}ms`,
      backgroundJobs: () => [],
      bgOutput: () => ({}),
      bgClock: () => 0,
    };
    const sleepUnit: any = {
      call: { type: "tool_call", toolId: "s1", toolName: "sleep", toolArgs: JSON.stringify({ seconds: 30 }) },
    };
    const bashUnit: any = {
      call: { type: "tool_call", toolId: "b1", toolName: "bash", toolArgs: JSON.stringify({ command: "echo hi" }) },
      result: { type: "tool_result", toolId: "b1", toolResult: "hi" },
    };
    createRoot((dispose) => {
      // Before the reorder this threw `ReferenceError: Cannot access 'name'
      // before initialization` out of the hook — the eager hasContent memo
      // read a const declared below it, breaking every tool row on expand.
      const sleep = useToolUnitModel(ctx, "m1", sleepUnit, 0, () => true, () => true);
      expect(sleep.name()).toBe("sleep");
      expect(sleep.open()).toBe(false); // header-only while running
      expect(sleep.sleepRemaining()).toBe("25s left");
      const bash = useToolUnitModel(ctx, "m1", bashUnit, 1, () => false, () => false);
      expect(bash.sum().verb).toBe("Ran");
      expect(bash.open()).toBe(false);
      dispose();
    });
  });

  test("folded bg rows survive a later full snapshot (normalize carries folds)", () => {
    const wire: any[] = [{
      role: "assistant",
      content: [
        { name: "bash", id: "c1", arguments: { command: "sleep 15" } },
        { call_id: "c1", content: [{ text: "Command moved to background (still running)." }], is_error: false, started_at: 1000, duration_ms: 10009, details: { background_job_id: "bg_1", log_path: "/tmp/x.log" } },
      ],
    }];
    const first = normalizeSessionMessages(wire);
    const folded = foldBackgroundResult(first, { id: "bg_1", result: "done-gamma\n", status: "done", endedAt: 16005 });
    const resBlock = (msgs: ChatMessage[]) => msgs.flatMap((m) => m.blocks).find((b) => b.type === "tool_result");
    const fb = resBlock(folded);
    expect(fb?.toolResult).toBe("done-gamma\n");
    expect((fb?.toolDetails as any)?.detached).toBe(true);
    // Full duration (15s), not the 10s foreground slice.
    expect(fb?.toolDurationMs).toBe(15005);
    // A later snapshot (turn end, fetch, reconnect) rebuilds from the same
    // wire — the folded result must ride along, not revert to the
    // "still running" placeholder.
    const again = normalizeSessionMessages(wire, folded);
    const rb = resBlock(again);
    expect(rb?.toolResult).toBe("done-gamma\n");
    expect((rb?.toolDetails as any)?.detached).toBe(true);
    expect(rb?.toolDurationMs).toBe(15005);
  });

  test("terminal fold with empty output blanks the body instead of lying", () => {
    const wire: any[] = [{
      role: "assistant",
      content: [
        { name: "bash", id: "c1", arguments: { command: "sleep 15" } },
        { call_id: "c1", content: [{ text: "Command moved to background (still running)." }], is_error: false, started_at: 1000, duration_ms: 10009, details: { background_job_id: "bg_1" } },
      ],
    }];
    const first = normalizeSessionMessages(wire);
    const folded = foldBackgroundResult(first, { id: "bg_1", status: "cancelled", endedAt: 12000 });
    const rb = folded.flatMap((m) => m.blocks).find((b) => b.type === "tool_result");
    expect(rb?.toolResult).toBe("");
    expect((rb?.toolDetails as any)?.detached).toBe(true);
  });
});


test("streaming reuses unchanged historical turn derivations and invalidates edits", () => {
  const build = createRenderBlockBuilder();
  const old: ChatMessage = { id: "old", role: "assistant", turnIndex: 1, blocks: [{ type: "reasoning", reasoning: "old thought" }, { type: "text", text: "old answer" }] };
  const live: ChatMessage = { id: "live", role: "assistant", turnIndex: 2, streaming: true, blocks: [{ type: "reasoning", reasoning: "new thought" }] };
  const first = build([old, live]);
  const updated = appendReasoningDelta([old, live], " delta");
  const second = build(updated);
  expect(second).toEqual(buildRenderBlocks(updated));
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
  const edited = [{ ...old, blocks: [{ type: "text" as const, text: "edited" }] }, updated[1]];
  expect(build(edited)).toEqual(buildRenderBlocks(edited));
  build([]);
  expect(build([old, live])[0]).not.toBe(first[0]);
});

describe("Incremental note deduplication", () => {
  test("matches a fresh derivation across appends, edits, snapshots and truncation", () => {
    const build = createRenderBlockBuilder();
    const make = (id: number, text: string): ChatMessage => ({ id: `note-${id}`, role: "assistant", turnIndex: 1,
      time: 0, blocks: [{ type: "text", text }, { type: "tool_call", toolId: `read-${id}`, toolName: "read", toolArgs: "{}" }] });
    const hidden = (blocks: ReturnType<typeof buildRenderBlocks>) => blocks.flatMap((block) => block.kind === "series"
      ? block.entries.filter((entry) => entry.kind === "text").map((entry) => !!entry.hidden) : []);
    let messages = Array.from({ length: 25 }, (_, i) => make(i, `Inspect module ${i} with unique symbol_${i} field_${i} method_${i}.`));
    const check = () => expect(hidden(build(messages))).toEqual(hidden(buildRenderBlocks(messages)));
    check();
    messages = [...messages, make(25, messages[0].blocks[0].text!)]; check();
    expect(hidden(build(messages))[0]).toBe(true);
    messages = [...messages.slice(0, -1), make(25, "A completely different response.")]; check();
    expect(hidden(build(messages))[0]).toBe(false);
    messages = [...messages, make(26, messages[3].blocks[0].text!), make(27, messages[4].blocks[0].text!)]; check();
    messages = structuredClone(messages); check();
    messages = messages.slice(0, -2); check();
    messages = [make(0, "Edited first note."), ...messages.slice(1)]; check();
  });
});
