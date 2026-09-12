/**
 * Preserves scroll positions across DOM remounts and reactive updates
 * for tool output containers (e.g. bash terminal output, CodeBlock file content, diffs).
 */
const toolScrollMap = new Map<string, { top: number; left: number }>();

export function recordToolScroll(key: string | undefined, el: HTMLElement | null) {
  if (!key || !el) return;
  toolScrollMap.set(key, { top: el.scrollTop, left: el.scrollLeft });
}

export function restoreToolScroll(key: string | undefined, el: HTMLElement | null) {
  if (!key || !el) return;
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
  const ro = new ResizeObserver(() => {
    if (first) {
      first = false;
      return;
    }
    if (isActive()) el.scrollTop = el.scrollHeight;
  });
  ro.observe(el);
  return () => ro.disconnect();
}
