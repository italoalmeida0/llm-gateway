/**
 * Preserves scroll positions across DOM remounts and reactive updates
 * for tool output containers (e.g. bash terminal output, CodeBlock file content, diffs).
 */
const toolScrollMap = new Map<string, { top: number; left: number }>();

export function recordToolScroll(key: string | undefined, el: HTMLElement | null) {
  if (!key || !el || el.clientHeight === 0) return;
  toolScrollMap.set(key, { top: el.scrollTop, left: el.scrollLeft });
}

export function restoreToolScroll(key: string | undefined, el: HTMLElement | null) {
  if (!key || !el || el.clientHeight === 0) return;
  const saved = toolScrollMap.get(key);
  if (saved) {
    if (el.scrollTop !== saved.top) el.scrollTop = saved.top;
    if (el.scrollLeft !== saved.left) el.scrollLeft = saved.left;
  }
}

export function clearToolScrolls() {
  toolScrollMap.clear();
}

/** Keeps an open body pinned to its tail while it grows (streaming
 * output, thinking, messages). Follows only while `isActive()` holds
 * (open + turn running) and never on the initial layout, so a remount
 * still restores the reader's saved position first. Returns a cleanup. */
export function followTail(el: HTMLElement | null, isActive: () => boolean): () => void {
  if (!el || typeof ResizeObserver === "undefined") return () => {};
  let first = true;
  let pinned = true;
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pinned && isActive() && el.clientHeight > 0) el.scrollTop = el.scrollHeight;
    });
  };
  const detach = () => { pinned = false; };
  const wheel = (event: WheelEvent) => { if (event.deltaY < 0) detach(); };
  const key = (event: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) detach(); };
  const scroll = () => {
    if (el.clientHeight > 0) pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };
  const ro = new ResizeObserver(() => {
    if (first) { first = false; return; }
    schedule();
  });
  ro.observe(el);
  // Once max-height is reached, the viewport stops resizing. Content mutations
  // still grow scrollHeight, so watch the body as well as the viewport.
  const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  mo?.observe(el, { childList: true, subtree: true, characterData: true });
  el.addEventListener("wheel", wheel, { passive: true });
  el.addEventListener("touchmove", detach, { passive: true });
  el.addEventListener("pointerdown", detach);
  el.addEventListener("keydown", key);
  el.addEventListener("scroll", scroll, { passive: true });
  return () => {
    ro.disconnect(); mo?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    el.removeEventListener("wheel", wheel);
    el.removeEventListener("touchmove", detach);
    el.removeEventListener("pointerdown", detach);
    el.removeEventListener("keydown", key);
    el.removeEventListener("scroll", scroll);
  };
}
