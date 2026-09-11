import { expect, test } from "bun:test";
import { createStore, reconcile } from "solid-js/store";
import { normalizeSessionMessages, cutTail, mergeAssistantMessage } from "../web/src/indirect-code/transcript/updaters";
import { buildRenderBlocks } from "../web/src/indirect-code/transcript";

const txt = (role: string, text: string) => ({ role, content: [{ text }] });
const flat = (blocks: any[]) => JSON.stringify(blocks.map((b: any) => b.msg.role + ":" + (b.msg.blocks || []).map((x: any) => x.text || x.type).join("|")));

test("discard sequence repaints at every step", () => {
  const [state, setState] = createStore<{ blocks: any[] }>({ blocks: [] });
  const render = (msgs: any[]) => {
    const blocks = buildRenderBlocks(msgs, { hideToolMessages: true }).map((b: any) => ({ ...b, id: b.msg.id }));
    setState("blocks", reconcile(blocks));
    return flat(state.blocks);
  };
  let msgs = normalizeSessionMessages([txt("user", "q1"), txt("assistant", "a1"), txt("user", "q2"), txt("assistant", "a2")]);
  let view = render(msgs);
  expect(view).toContain("q2");

  // optimistic cut like regenerateMsg: cutLiveTail(rawIdx-1) for regenerate on a2 (rawIdx 3) -> keep 2
  msgs = cutTail(msgs, 2);
  view = render(msgs);
  expect(view).not.toContain("a2");
  expect(view).toContain("q2");

  // daemon session_content with truncated list [q1,a1,q2]
  msgs = normalizeSessionMessages([txt("user", "q1"), txt("assistant", "a1"), txt("user", "q2")]);
  view = render(msgs);
  expect(view).not.toContain("a2");

  // streaming new answer
  msgs = mergeAssistantMessage(msgs, { index: 3, message: { content: [{ text: "new-a" }] } });
  view = render(msgs);
  expect(view).toContain("new-a");
});

test("regenerate resolves the correct preceding user message in multi-turn with tools", () => {
  const raw = [
    { role: "user", content: [{ text: "first question" }] }, // raw 0
    { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "bash", arguments: "{}" }] }, // raw 1
    { role: "tool", content: [{ type: "tool_result", tool_call_id: "t1", content: "ok" }] }, // raw 2
    { role: "assistant", content: [{ text: "first answer" }] }, // raw 3
    { role: "user", content: [{ text: "second question" }] }, // raw 4
    { role: "assistant", content: [{ type: "tool_call", id: "t2", name: "bash", arguments: "{}" }] }, // raw 5
    { role: "tool", content: [{ type: "tool_result", tool_call_id: "t2", content: "ok" }] }, // raw 6
    { role: "assistant", content: [{ text: "second answer" }] }, // raw 7
  ];
  const msgs = normalizeSessionMessages(raw);
  // Find the last assistant message (second answer)
  const lastAsstIdx = msgs.length - 1;
  expect(msgs[lastAsstIdx].role).toBe("assistant");

  // Search backwards from lastAsstIdx for preceding user message
  let userMsg = null;
  for (let k = lastAsstIdx; k >= 0; k--) {
    if (msgs[k]?.role === "user") {
      userMsg = msgs[k];
      break;
    }
  }

  expect(userMsg).not.toBeNull();
  expect(userMsg!.blocks[0].text).toBe("second question");
  expect(userMsg!.srcIdx).toBe(4); // raw daemon index 4, NOT 0!

  // Cut tail up to userMsg.srcIdx
  const cutMsgs = cutTail(msgs, userMsg!.srcIdx!);
  expect(cutMsgs.map((m) => m.srcIdx)).toEqual([0, 1, 3, 4]);
  expect(cutMsgs.some((m) => m.blocks.some((b) => b.text === "second answer"))).toBe(false);
});

