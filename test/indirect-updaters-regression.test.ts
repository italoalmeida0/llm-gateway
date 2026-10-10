import { expect, test } from "bun:test";
import {
  appendToolResult,
  mergeUsage,
  upsertToolCall,
} from "../web/src/indirect-code/transcript/updaters";
import type { ChatMessage } from "../web/src/indirect-code/types";

const assistant = (id: string, text = ""): ChatMessage => ({
  id,
  role: "assistant",
  time: 1,
  streaming: true,
  blocks: [{ type: "text", text }],
});

// BUG-TR-01 regression: an orphan tool_result (no matching call card) must not
// land on an unrelated completed bubble.
test("orphan tool result opens its own carrier instead of polluting the last bubble", () => {
  const a1: ChatMessage = {
    id: "a1",
    role: "assistant",
    time: 1,
    blocks: [{ type: "tool_call", toolId: "callX", toolName: "bash", toolArgs: "" }],
  };
  const done = { ...assistant("a2", "answer"), streaming: false };
  const out = appendToolResult([a1, done], "callUNKNOWN", "res", false);
  const host = out.find((m) => m.blocks.some((b: any) => b.toolId === "callUNKNOWN"));
  expect(host?.id).not.toBe("a2");
  expect(host?.role).toBe("assistant");
  // The completed bubble is untouched.
  expect(out.find((m) => m.id === "a2")?.blocks).toEqual(done.blocks);
});

// The active streaming carrier may still host an orphan result (mid-turn
// detach placeholders land before the card is replayed).
test("orphan tool result still joins the active streaming carrier", () => {
  const active = assistant("a1", "thinking");
  const out = appendToolResult([active], "callLate", "res", false);
  expect(out).toHaveLength(1);
  expect(out[0].blocks.some((b: any) => b.toolId === "callLate")).toBe(true);
});

// BUG-TR-02 regression: a re-issued tool_call must update the existing card
// even when it lives in an earlier carrier than the newest assistant.
test("re-issued tool call updates the existing card in an earlier carrier", () => {
  const a1: ChatMessage = {
    id: "a1",
    role: "assistant",
    time: 1,
    blocks: [{ type: "tool_call", toolId: "callD", toolName: "bash", toolArgs: "old" }],
  };
  const steer: ChatMessage = { id: "u1", role: "user", time: 2, blocks: [{ type: "text", text: "steer" }] };
  const a2 = assistant("a2", "ok");
  const out = upsertToolCall([a1, steer, a2], "callD", "bash", { x: 1 });
  const cards = out.flatMap((m) => m.blocks).filter((b: any) => b.toolId === "callD");
  expect(cards).toHaveLength(1);
  expect((cards[0] as any).toolArgs).toContain("x");
});

// BUG-TR-03 regression: cacheTok must fall back to the previous value when a
// usage snapshot carries no cache fields at all (like reasoningTok/cost*).
test("mergeUsage preserves cacheTok when the snapshot omits cache fields", () => {
  const prev = {
    s1: {
      inTok: 10,
      outTok: 5,
      cacheTok: 777,
      reasoningTok: 3,
      costUsd: 1,
      costInUsd: 0.5,
      costCacheUsd: 0.2,
      costOutUsd: 0.3,
    },
  };
  const next = mergeUsage(prev, "s1", undefined, { input_tokens: 20, output_tokens: 9 });
  expect(next.s1.cacheTok).toBe(777);
  // Explicit zero cache fields still win (real "no cache" report).
  const zeroed = mergeUsage(prev, "s1", undefined, {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  expect(zeroed.s1.cacheTok).toBe(0);
  // Nonzero cache fields replace (cumulative semantics).
  const replaced = mergeUsage(prev, "s1", undefined, {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_tokens: 42,
    cache_write_tokens: 8,
  });
  expect(replaced.s1.cacheTok).toBe(50);
});
