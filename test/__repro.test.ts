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
