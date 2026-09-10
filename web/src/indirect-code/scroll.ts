/** Follow streamed content while pinned to the bottom. */
export function createTranscriptScroll(opts: {
  element: () => Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight"> | null;
  running: () => boolean;
  atBottom: (value: boolean) => void;
  frame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}) {
  const frame = opts.frame ?? requestAnimationFrame;
  const cancelFrame = opts.cancelFrame ?? cancelAnimationFrame;
  let pending = 0;
  /** Pinned: the reader wants the tail; streaming keeps scrolling them down. */
  let pinned = true;
  let forced = false;

  function measure() {
    const el = opts.element();
    if (!el) return;
    // Report-only: the button visibility tracks the real position, but the
    // pin never re-engages by itself — only an explicit pin() does.
    opts.atBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }

  function schedule(force = false) {
    if (!force && (!opts.running() || !pinned)) return;
    forced ||= force;
    if (pending) return;
    pending = frame(() => {
      pending = 0;
      // Check again: a queued frame must not override a scroll-up or a task ending.
      if (!explicit() && (!opts.running() || !pinned)) return;
      const el = opts.element();
      if (!el) return;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      opts.atBottom(true);
    });
  }

  function explicit() {
    const value = forced;
    forced = false;
    return value;
  }

  return {
    schedule,
    measure,
    /** Any explicit scroll gesture: unpin immediately. */
    detach() { pinned = false; forced = false; },
    /** Explicit "Pin at bottom": jump to the tail and follow again. */
    pin() {
      pinned = true;
      schedule(true);
    },
    /** Session switch / fresh transcript: pin without a jump. */
    reset() {
      pinned = true;
      forced = false;
      if (pending) cancelFrame(pending);
      pending = 0;
    },
    dispose() { if (pending) cancelFrame(pending); pending = 0; },
  };
}
