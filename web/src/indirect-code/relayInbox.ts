/** Ordered, bounded batching for relay traffic. All event types share one
 * queue, so snapshots/status cannot overtake an assistant carrier or delta.
 * The callback owns a Solid batch; this helper is also usable in unit tests. */
export function createRelayInbox(opts: {
  apply: (messages: unknown[]) => void;
  schedule: (flush: () => void) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  let pending: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    if (timer !== undefined) opts.cancel(timer);
    timer = undefined;
    const messages = pending;
    pending = [];
    if (messages.length) opts.apply(messages);
  }
  return {
    push(message: unknown) {
      const next = message as any;
      const prev = pending.at(-1) as any;
      const type = next?.event?.type;
      const field = type === "tool_progress" ? "text" : "delta";
      if (next?.type === "agent_event" && prev?.type === "agent_event" &&
          next.hostId === prev.hostId && next.sessionId === prev.sessionId &&
          ["text_delta", "reasoning_delta", "tool_use_args", "tool_progress"].includes(type) &&
          prev.event?.type === type && prev.event.id === next.event.id &&
          typeof prev.event[field] === "string" && typeof next.event[field] === "string") {
        // Copy: callers may retain their decoded message for other consumers.
        pending[pending.length - 1] = { ...next, event: { ...next.event, [field]: prev.event[field] + next.event[field] } };
      } else pending.push(message);
      // Never discard old events. Bound both event count and long delta ropes
      // even when a background tab's timers are throttled by the browser.
      if (pending.length >= 256 || ((pending.at(-1) as any)?.event?.[field]?.length ?? 0) >= 65_536) flush();
      else if (timer === undefined) timer = opts.schedule(flush);
    },
    flush,
    clear() {
      if (timer !== undefined) opts.cancel(timer);
      timer = undefined;
      pending = [];
    },
  };
}
