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
  let gesture = 0;
  let anchorFrame = 0;
  function preserveReadingPosition() {
    if (pinned || anchorFrame) return;
    const el = opts.element() as HTMLElement | null;
    if (!el) return;
    const top = el.scrollTop, version = gesture;
    const viewportTop = el.getBoundingClientRect?.().top ?? 0;
    const anchors = Array.from(el.querySelectorAll?.<HTMLElement>("[data-transcript-id]") || [])
      .filter(node => node.getBoundingClientRect().bottom > viewportTop)
      .map(node => ({ id: node.dataset.transcriptId, offset: node.getBoundingClientRect().top - viewportTop }));
    anchorFrame = frame(() => {
      anchorFrame = 0;
      if (pinned || gesture !== version || opts.element() !== el) return;
      const nodes = Array.from(el.querySelectorAll?.<HTMLElement>("[data-transcript-id]") || []);
      for (const anchor of anchors) {
        const node = nodes.find(node => node.dataset.transcriptId === anchor.id);
        if (!node) continue;
        el.scrollTop += node.getBoundingClientRect().top - (el.getBoundingClientRect?.().top ?? 0) - anchor.offset;
        measure(); return;
      }
      el.scrollTop = top;
      measure();
    });
  }

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
    preserveReadingPosition,
    isPinned: () => pinned,
    /** Any explicit scroll gesture: unpin immediately. */
    detach() { gesture++; pinned = false; forced = false; },
    /** Explicit "Pin at bottom": jump to the tail and follow again. */
    pin() {
      gesture++;
      pinned = true;
      schedule(true);
    },
    /** Session switch / fresh transcript: pin without a jump. */
    reset() {
      gesture++;
      if (anchorFrame) cancelFrame(anchorFrame);
      anchorFrame = 0;
      pinned = true;
      forced = false;
      if (pending) cancelFrame(pending);
      pending = 0;
    },
    dispose() { if (anchorFrame) cancelFrame(anchorFrame); anchorFrame = 0; if (pending) cancelFrame(pending); pending = 0; },
  };
}
