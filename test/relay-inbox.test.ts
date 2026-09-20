import { expect, test } from "bun:test";
import { createRelayInbox } from "../web/src/indirect-code/relayInbox";

function fixture() {
  const received: any[] = [];
  let batches = 0;
  const inbox = createRelayInbox({
    apply: (messages) => { batches++; received.push(...messages); },
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>, cancel: () => {},
  });
  const send = (type: string, extra: Record<string, unknown> = {}, sessionId = "s") => inbox.push({ type: "agent_event", sessionId, hostId: "h", event: { type, ...extra } });
  return { inbox, received, send, batches: () => batches };
}

test("background stream keeps carriers, deltas, completion and snapshots in wire order", () => {
  const { inbox, received, send, batches } = fixture();
  send("assistant_start", { index: 1 });
  for (let i = 0; i < 3000; i++) send("reasoning_delta", { delta: "x" });
  send("text_delta", { delta: "done" });
  send("turn_end");
  inbox.push({ type: "session_content", messages: [] });
  inbox.push({ type: "session_status", status: "idle" });
  inbox.flush();
  expect(received.map((m) => m.event?.type || m.type)).toEqual([
    "assistant_start", "reasoning_delta", "text_delta", "turn_end", "session_content", "session_status",
  ]);
  expect(received[1].event.delta).toBe("x".repeat(3000));
  expect(batches()).toBe(1);
});

test("different tools, sessions and hosts never coalesce", () => {
  const { inbox, received, send } = fixture();
  send("tool_use_args", { id: "a", delta: "first" });
  send("tool_use_args", { id: "b", delta: "second" });
  send("tool_use_args", { id: "b", delta: "third" }, "other");
  inbox.push({ type: "agent_event", hostId: "other", sessionId: "other", event: { type: "tool_use_args", id: "b", delta: "fourth" } });
  inbox.flush(); expect(received).toHaveLength(4);
});

test("throttled timers bound the queue without dropping any events", () => {
  const { inbox, received, send, batches } = fixture();
  for (let i = 0; i < 3000; i++) send("assistant_start", { index: i });
  inbox.flush();
  expect(received.map((m) => m.event.index)).toEqual(Array.from({ length: 3000 }, (_, i) => i));
  expect(batches()).toBe(12);
});

test("host disconnect/switch clears pending data and permits new traffic", () => {
  const { inbox, received, send } = fixture();
  send("text_delta", { delta: "old" }); inbox.clear(); inbox.flush();
  send("text_delta", { delta: "new" }); inbox.flush();
  expect(received.map((m) => m.event.delta)).toEqual(["new"]);
});
