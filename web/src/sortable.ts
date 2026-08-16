import Sortable from "sortablejs";
import { onCleanup } from "solid-js";

/**
 * Thin wrapper around SortableJS (the project's drag-and-drop dep):
 * theme-consistent defaults — drag via a dedicated handle class, small
 * animation, ghost row dimmed. Used for every priority-ordered list in the
 * admin UI (providers, provider keys, model targets).
 *
 * The callback receives the reordered `data-id` values; persistence (API
 * call) is the caller's job. Sortable mutates the DOM optimistically; on API
 * failure the caller should refetch (which re-renders the list).
 */
export function attachSortable(
  el: HTMLElement,
  opts: {
    /** Selector of the drag handle inside each row (default "[data-handle]"). */
    handle?: string;
    onReorder: (ids: string[]) => void;
  },
): Sortable {
  const s = Sortable.create(el, {
    animation: 150,
    handle: opts.handle ?? "[data-handle]",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: (evt) => {
      if (evt.oldIndex === evt.newIndex) return;
      const ids = Array.from(el.children)
        .map((c) => (c as HTMLElement).dataset.id)
        .filter((x): x is string => !!x);
      opts.onReorder(ids);
    },
  });
  onCleanup(() => s.destroy());
  return s;
}
