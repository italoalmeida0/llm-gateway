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
