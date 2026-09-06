/** Follow streamed content only while a task runs and the reader stays at the end. */
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
  let following = true;
  let forced = false;

  function measure() {
    const el = opts.element();
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    // Markdown layout can shrink and grow in one update, changing scrollTop
    // without user input. Only explicit gestures call detach().
    if (bottom) following = true;
    opts.atBottom(bottom);
  }

  function schedule(force = false) {
    if (!force && (!opts.running() || !following)) return;
    forced ||= force;
    if (pending) return;
    pending = frame(() => {
      pending = 0;
      const explicit = forced;
      forced = false;
      // Check again: a queued frame must not override a scroll-up or a task ending.
      if (!explicit && (!opts.running() || !following)) return;
      const el = opts.element();
      if (!el) return;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      following = true;
      opts.atBottom(true);
    });
  }

  return {
    schedule,
    measure,
    detach() { following = false; forced = false; },
    reset() { following = true; forced = false; if (pending) cancelFrame(pending); pending = 0; },
    dispose() { if (pending) cancelFrame(pending); pending = 0; },
  };
}
